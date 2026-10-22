// node pathing/sw-inside-upload.mjs <root> <localPack>
// Does a Service Worker shipped inside the upload take over its own scope on a gateway?
// Tests Kubo's subdomain gateway (<root>.ipfs.localhost:8080) and path gateway (127.0.0.1:8080/ipfs/<root>/).
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const [root, localPack] = process.argv.slice(2)
const pack = await readFile(localPack)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const [label, base, virtual] of [
  ['subdomain gateway', `http://${root}.ipfs.localhost:8080/`, `/virtual/`],
  ['path gateway', `http://127.0.0.1:8080/ipfs/${root}/`, `/ipfs/${root}/virtual/`],
]) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()) })
  try {
    await page.goto(base)
    const ready = await page.evaluate(() => window.ready)
    const r = await page.evaluate(async (u) => {
      const res = await fetch(u)
      const b = new Uint8Array(await res.arrayBuffer())
      const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((x) => x.toString(16).padStart(2, '0')).join('')
      return { status: res.status, len: b.length, sha: h, upstream: res.headers.get('x-upstream-status'), cr: res.headers.get('x-upstream-cr') }
    }, `${virtual}1048000-1049023`)
    const expected = createHash('sha256').update(pack.subarray(1048000, 1049024)).digest('hex')
    console.log(JSON.stringify({ label, scope: ready.scope, origin: ready.origin, ...r, ok: r.sha === expected }))
  } catch (e) {
    console.log(JSON.stringify({ label, error: String(e).slice(0, 300) }))
  }
  await ctx.close()
}
await browser.close()
