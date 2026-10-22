// node pathing/demo/verify.mjs <base-url-with-trailing-slash> <pieceKeyHex>
// Opens the demo in headless Chrome and checks the virtual paths, Range, and video seeking.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const [base, keyHex] = process.argv.slice(2)
const HERE = new URL('.', import.meta.url).pathname
const big = await readFile(`${HERE}.src/folder/data/big.bin`)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()) })
await page.goto(`${base}#k=${keyHex}`)
await page.waitForFunction(() => window.demo != null, null, { timeout: 180000 })
const out = { base }
out.log = await page.evaluate(() => document.getElementById('log').textContent)
out.mode = await page.evaluate(() => window.demo.mode)
// worker mode: real URLs under the page's path, with Range. in-page mode: blob URLs minted after decrypting in the page.
out.readme = await page.evaluate(async () => (await fetch(window.demo.mode === 'worker' ? 'v/folder/README.md' : await window.demo.url4('folder/README.md'))).text())
const r = await page.evaluate(async () => {
  const url = window.demo.mode === 'worker' ? 'v/folder/data/big.bin' : await window.demo.url4('folder/data/big.bin')
  const res = await fetch(url, { headers: { range: 'bytes=3000000-3001023' } })
  let b = new Uint8Array(await res.arrayBuffer())
  if (res.status === 200) b = b.subarray(3000000, 3001024) // blob URLs ignore Range
  return { status: res.status, cr: res.headers.get('content-range'), sha: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((x) => x.toString(16).padStart(2, '0')).join('') }
})
out.bigRange = { ...r, ok: r.sha === sha(big.subarray(3000000, 3001024)) }
out.svg = await page.evaluate(async () => { const res = await fetch(window.demo.mode === 'worker' ? 'v/folder/img/logo.svg' : await window.demo.url4('folder/img/logo.svg')); return { status: res.status, ct: res.headers.get('content-type'), len: (await res.text()).length } })
out.video = await page.evaluate(async () => {
  const v = document.querySelector('video')
  if (!v) return 'no video element'
  if (!(v.readyState >= 1)) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }))
  const t0 = performance.now()
  await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = 10 })
  await v.play().catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  return { duration: v.duration, seekedMs: Math.round(performance.now() - t0), currentTime: v.currentTime, width: v.videoWidth }
})
out.stats = await page.evaluate(() => window.demo.refreshStats())
console.log(JSON.stringify(out, null, 1))
await browser.close()
