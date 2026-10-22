// node pathing/demo/click-test.mjs <base> <key>: click the README link and check the tab that opens
import { chromium } from 'playwright'
const [base, keyHex] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await page.goto(`${base}#k=${keyHex}`)
await page.waitForFunction(() => window.demo != null, null, { timeout: 180000 })
const mode = await page.evaluate(() => window.demo.mode)
const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 30000 }), page.click('text=folder/README.md')])
await popup.waitForLoadState('load')
await popup.waitForFunction(() => document.body?.innerText.length > 0, null, { timeout: 30000 })
console.log(JSON.stringify({ mode, popupUrl: popup.url().slice(0, 80), text: (await popup.evaluate(() => document.body.innerText)).slice(0, 60) }))
await browser.close()
