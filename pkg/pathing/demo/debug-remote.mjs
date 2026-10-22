import { chromium } from 'playwright'
const [base, keyHex] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)))
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url().slice(0, 160), r.failure()?.errorText))
page.on('response', (r) => { if (r.status() >= 400) console.log('[response]', r.status(), r.url().slice(0, 160)) })
await page.goto(`${base}#k=${keyHex}`, { waitUntil: 'load', timeout: 90000 })
await page.waitForTimeout(Number(process.env.WAIT_MS ?? 20000))
const info = await page.evaluate(async () => {
  const controlled = navigator.serviceWorker?.controller != null
  const regs = (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, script: r.active?.scriptURL }))
  let head = null
  try { const r = await fetch('encrypted.fee', { method: 'HEAD' }); head = { status: r.status, cl: r.headers.get('content-length'), ar: r.headers.get('accept-ranges') } } catch (e) { head = String(e) }
  let range = null
  try { const r = await fetch('encrypted.fee', { headers: { range: 'bytes=0-1023' } }); range = { status: r.status, cr: r.headers.get('content-range'), len: (await r.arrayBuffer()).byteLength } } catch (e) { range = String(e) }
  return { href: location.href, controlled, regs, mode: window.demo?.mode, log: document.getElementById('log').textContent, head, range }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
