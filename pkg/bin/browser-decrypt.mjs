// node bin/browser-decrypt.mjs <label:root:parseCar> ...   bulk fetch+decrypt in Chrome
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { startServer } from '../web/server.mjs'
const exec = promisify(execFile)
const PKG = new URL('..', import.meta.url).pathname
await build({ entryPoints: [`${PKG}web/page-src.mjs`], bundle: true, format: 'esm', platform: 'browser', outfile: `${PKG}web/dist/page.js`, logLevel: 'error' })
await build({ entryPoints: [`${PKG}web/sw-src.mjs`], bundle: true, format: 'esm', platform: 'browser', outfile: `${PKG}web/dist/sw.js`, logLevel: 'error' })
const server = await startServer(9000)
const userDataDir = `${PKG}web/.chrome-${process.pid}`
const ctx = await chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: true })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:9000/')
const out = []
for (const spec of process.argv.slice(2)) {
  const [label, root, parse] = spec.split(':')
  const rss = []; const t = setInterval(async () => { try { const { stdout } = await exec('ps', ['-axo', 'rss,command']); rss.push(stdout.split('\n').filter((l) => l.includes(userDataDir) || l.includes('Google Chrome Helper')).reduce((a, l) => a + Number(l.trim().split(/\s+/)[0] || 0), 0) * 1024) } catch {} }, 500)
  const r = await page.evaluate(([u, p]) => window.benchDecrypt(u, { parseCar: p === '1' }), [`http://127.0.0.1:8080/ipfs/${root}`, parse])
  clearInterval(t)
  out.push({ label, ...r, chromeRssPeakMB: Math.round(Math.max(0, ...rss) / 1e6) })
  console.log(JSON.stringify(out.at(-1)))
}
await ctx.close(); server.close(); await exec('rm', ['-rf', userDataDir])
