// node pathing/sw-path-probe.mjs <outerRoot> <localDir> <pathInPayload>...
// Registers the bench's decrypting Service Worker in Chrome and fetches paths inside an encrypted
// directory as /media/car/<root>/<path>, with and without Range, comparing bytes to the local files.
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { startServer } from '../web/server.mjs'
const [root, localDir, ...paths] = process.argv.slice(2)
const PKG = new URL('..', import.meta.url).pathname
await mkdir(`${PKG}web/dist`, { recursive: true })
await build({ entryPoints: [`${PKG}web/sw-src.mjs`], bundle: true, format: 'esm', platform: 'browser', outfile: `${PKG}web/dist/sw.js`, logLevel: 'error' })
await build({ entryPoints: [`${PKG}web/page-src.mjs`], bundle: true, format: 'esm', platform: 'browser', outfile: `${PKG}web/dist/page.js`, logLevel: 'error' })
const server = await startServer(9000)
const userDataDir = `${PKG}web/.chrome-${process.pid}`
const ctx = await chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: true })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()) })
const sha = (b) => createHash('sha256').update(b).digest('hex')
try {
  await page.goto('http://127.0.0.1:9000/')
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })) })
  for (const p of paths) {
    const local = await readFile(`${localDir}/${p.split('/').slice(1).join('/')}`)
    const probes = [[null, null], [0, 1024], [1048576 - 100, 300], [local.length - 1000, 1000]].filter(([s, l]) => s == null || (s >= 0 && s + l <= local.length))
    for (const [start, len] of probes) {
      const r = await page.evaluate(async ([u, s, l]) => {
        const res = await fetch(u, s == null ? {} : { headers: { range: `bytes=${s}-${s + l - 1}` } })
        const b = new Uint8Array(await res.arrayBuffer())
        const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((x) => x.toString(16).padStart(2, '0')).join('')
        return { status: res.status, cr: res.headers.get('content-range'), len: b.length, sha: h }
      }, [`/media/car/${root}/${p}`, start, len])
      const expected = start == null ? local : local.subarray(start, start + len)
      console.log(JSON.stringify({ path: p, range: start == null ? 'none' : `${start}-${start + len - 1}`, ...r, ok: r.sha === sha(expected) }))
    }
  }
  console.log('stats', JSON.stringify(await page.evaluate(async () => (await fetch('/media-stats')).json())))
} finally {
  await ctx.close(); await server.close?.(); process.exit(0)
}
