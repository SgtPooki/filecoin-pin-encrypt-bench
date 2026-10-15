import { chromium } from 'playwright'
const [file, outDir] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: true })
const p = await b.newPage({ viewport: { width: 1600, height: 900 } })
await p.goto(`file://${file}`)
const n = await p.evaluate(() => document.querySelectorAll('.slide').length)
const overflow = []
for (let i = 0; i < n; i++) {
  if (i > 0) await p.evaluate(() => go(1)); await p.waitForTimeout(450)
  const o = await p.evaluate(() => { const s = document.querySelector('.slide.active'); const r = s.getBoundingClientRect(); return { sh: s.scrollHeight, ch: s.clientHeight, tableW: Math.max(0, ...Array.from(s.querySelectorAll('table')).map(t => t.scrollWidth - t.clientWidth)) } })
  if (o.sh > o.ch + 2 || o.tableW > 0) overflow.push({ slide: i + 1, ...o })
  if ([1, 6, 7, 10, 11, 14].includes(i + 1)) await p.screenshot({ path: `${outDir}/slide-${String(i + 1).padStart(2, '0')}.png` })
}
console.log(JSON.stringify({ slides: n, overflow }))
await b.close()
