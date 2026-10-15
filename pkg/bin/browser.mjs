// node bin/browser.mjs <raw|car|tar> <outerRoot> <pathInPayload> [--full]
// Google Chrome (Playwright channel 'chrome') plays the encrypted video through the decrypting Service Worker.
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { startServer } from '../web/server.mjs'
const exec = promisify(execFile)
const [fmt, root, path, flag] = process.argv.slice(2)
const PKG = new URL('..', import.meta.url).pathname

await mkdir(`${PKG}web/dist`, { recursive: true })
await build({ entryPoints: [`${PKG}web/sw-src.mjs`], bundle: true, format: 'esm', platform: 'browser', outfile: `${PKG}web/dist/sw.js`, logLevel: 'error' })
const server = await startServer(9000)
const userDataDir = `${PKG}web/.chrome-${process.pid}`
const ctx = await chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()) })
const rssSamples = []
const sampler = setInterval(async () => {
  try {
    const { stdout } = await exec('ps', ['-axo', 'rss,command'])
    const kb = stdout.split('\n').filter((l) => l.includes(userDataDir) || l.includes('Google Chrome Helper')).reduce((a, l) => a + Number(l.trim().split(/\s+/)[0] || 0), 0)
    rssSamples.push(kb * 1024)
  } catch {}
}, 1000)
const result = { fmt, root, path, startedAt: new Date().toISOString() }
try {
  await page.goto('http://127.0.0.1:9000/')
  if (flag === '--probe') {
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })) })
    const local = process.argv[6]
    const { createHash } = await import('node:crypto')
    const { open } = await import('node:fs/promises')
    const fh = await open(local, 'r')
    result.probes = []
    for (const [start, len] of [[0, 1024], [0, 65536], [1048576 - 100, 300], [300000000, 65536]]) {
      const r = await page.evaluate(async ([u, s, l]) => { const res = await fetch(u, { headers: { range: `bytes=${s}-${s + l - 1}` } }); const b = new Uint8Array(await res.arrayBuffer()); const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((x) => x.toString(16).padStart(2, '0')).join(''); return { status: res.status, cr: res.headers.get('content-range'), cl: res.headers.get('content-length'), len: b.length, sha: h, head: Array.from(b.subarray(0, 16)) } }, [`/media/${fmt}/${root}/${path}`, start, len])
      const buf = Buffer.alloc(len); await fh.read(buf, 0, len, start)
      r.expectedSha = createHash('sha256').update(buf).digest('hex'); r.ok = r.sha === r.expectedSha; r.expectedHead = Array.from(buf.subarray(0, 16)); r.start = start
      result.probes.push(r)
    }
    await fh.close()
    throw new Error('probe done')
  }
  result.start = await page.evaluate(([f, r, p]) => window.bench.start(f, r, p), [fmt, root, path])
  result.playHead = await page.evaluate(() => window.bench.playFor(5))
  result.seeks = []
  for (const frac of [0.1, 0.5, 0.9]) {
    const s = await page.evaluate((x) => window.bench.seekTo(x), frac)
    s.play = await page.evaluate(() => window.bench.playFor(5))
    result.seeks.push(s)
  }
  const tail = await page.evaluate(() => window.bench.seekTo(1 - 8 / document.getElementById('v').duration))
  tail.end = await page.evaluate(() => window.bench.playToEnd(60000))
  result.tail = tail
  if (flag === '--full') {
    await page.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 0; v.playbackRate = 16 })
    const t0 = performance.now()
    result.full = await page.evaluate(() => window.bench.playToEnd(20 * 60 * 1000))
    result.full.wallMs = Math.round(performance.now() - t0)
  }
  result.pageHeapBytes = await page.evaluate(() => window.bench.heap())
  result.sw = await page.evaluate(() => window.bench.stats())
} catch (e) {
  result.error = String(e?.stack ?? e)
} finally {
  clearInterval(sampler)
  result.chromeRssPeakBytes = Math.max(0, ...rssSamples)
  result.chromeRssSamples = rssSamples.length
  await ctx.close()
  server.close()
  await exec('rm', ['-rf', userDataDir])
}
await mkdir(`${PKG}results`, { recursive: true })
await writeFile(`${PKG}results/browser-${fmt}-${path.replace(/[^a-z0-9.]+/gi, '_')}.json`, JSON.stringify(result, null, 1))
console.log(JSON.stringify(result))
