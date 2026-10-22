// Fresh profile, first visit, like a human clicking the link: what does the log say, and what do HEAD and Range return?
import { chromium } from 'playwright'
const [base, keyHex] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const seen = []
page.on('response', (r) => { const u = r.url(); if (u.includes('encrypted.fee')) seen.push({ m: r.request().method(), range: r.request().headers().range ?? '', status: r.status(), cr: r.headers()['content-range'] ?? '', cl: r.headers()['content-length'] ?? '' }) })
await page.goto(`${base}#k=${keyHex}`, { waitUntil: 'load', timeout: 120000 })
for (let i = 0; i < 24; i++) { await page.waitForTimeout(5000); const l = await page.evaluate(() => document.getElementById('log').textContent); if (/error|metadata \d+ B/.test(l)) break }
console.log(JSON.stringify({ log: await page.evaluate(() => document.getElementById('log').textContent), envelopeRequests: seen.slice(0, 8) }, null, 1))
await browser.close()
