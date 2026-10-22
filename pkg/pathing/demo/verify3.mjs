// node pathing/demo/verify3.mjs <base> <key>: drives the two-reader page and checks what it claims.
import { chromium } from 'playwright'
const [base, keyHex] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[page]', m.text().slice(0, 200)) })
const t0 = Date.now()
await page.goto(`${base}#k=${keyHex}`, { waitUntil: 'load', timeout: 120000 })
await page.waitForFunction(() => window.demo?.last != null, null, { timeout: 240000 })
const snap = async () => page.evaluate(() => ({
  status: document.getElementById('status').textContent,
  counter: document.getElementById('counter').textContent,
  gw: [...document.querySelectorAll('#gw tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent.trim().slice(0, 110))),
  header: document.getElementById('header').textContent.split('\n').slice(0, 3),
  innercid: document.getElementById('innercid').textContent.slice(0, 160),
  trace: document.getElementById('trace').textContent.split('\n'),
  viewer: document.getElementById('viewer').textContent.slice(0, 120),
  reqs: window.demo.requests.map((r) => [r.why.slice(0, 40), r.length, r.bytes]),
  last: window.demo.last,
}))
const afterOpen = await snap()
await page.evaluate(() => window.demo.resolve('data/big.bin', 12 * 1024 * 1024, 65536))
await page.waitForFunction(() => window.demo.last?.path === 'data/big.bin', null, { timeout: 60000 })
const afterBig = await snap()
await page.evaluate(() => window.demo.resolve('docs/notes.txt'))
await page.waitForFunction(() => window.demo.last?.path === 'docs/notes.txt', null, { timeout: 60000 })
const afterNotes = await snap()
console.log(JSON.stringify({ base, secondsToFirstFile: Math.round((Date.now() - t0) / 1000), afterOpen, afterBig: { counter: afterBig.counter, viewer: afterBig.viewer, reqs: afterBig.reqs.slice(-1) }, afterNotes: { counter: afterNotes.counter, viewer: afterNotes.viewer, trace: afterNotes.trace.slice(-3) } }, null, 1))
await browser.close()
