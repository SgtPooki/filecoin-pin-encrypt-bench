// node pathing/demo/mobile-check.mjs <base> <key>: iPhone-sized viewport; checks for sideways overflow and the top status line.
import { chromium, devices } from 'playwright'
const [base, keyHex] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ ...devices['iPhone 13'] })
const page = await ctx.newPage()
await page.goto(`${base}#k=${keyHex}`, { waitUntil: 'load', timeout: 120000 })
await page.waitForSelector('#top', { timeout: 120000 })
const early = await page.evaluate(() => ({ top: document.getElementById('top').textContent.slice(0, 120), topY: document.getElementById('top').getBoundingClientRect().top }))
await page.waitForFunction(() => window.demo?.last != null, null, { timeout: 240000 })
const after = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth > window.innerWidth ? `${document.documentElement.scrollWidth} > ${window.innerWidth}` : 'none',
  counter: document.getElementById('counter').textContent,
  gwPath: [...document.querySelectorAll('#gw tr')].at(-1).children[1].textContent.trim(),
  headerFirst: document.getElementById('header').textContent.split('\n')[0],
}))
await page.screenshot({ path: `${new URL('.', import.meta.url).pathname}mobile.png`, fullPage: true })
console.log(JSON.stringify({ early, after }, null, 1))
await browser.close()
