import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { startServer } from '../web/server.mjs'
const exec = promisify(execFile)
const PKG = new URL('..', import.meta.url).pathname
const server = await startServer(9000)
const userDataDir = `${PKG}web/.chrome-idle-${process.pid}`
const ctx = await chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: true })
const page = await ctx.newPage(); await page.goto('http://127.0.0.1:9000/')
const rss = []
for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 500)); const { stdout } = await exec('ps', ['-axo', 'rss,command']); rss.push(stdout.split('\n').filter((l) => l.includes(userDataDir) || l.includes('Google Chrome Helper')).reduce((a, l) => a + Number(l.trim().split(/\s+/)[0] || 0), 0) * 1024) }
console.log(JSON.stringify({ idleChromeRssMB: Math.round(Math.max(...rss) / 1e6), heapMB: Math.round((await page.evaluate(() => performance.memory.usedJSHeapSize)) / 1e6) }))
await ctx.close(); server.close(); await exec('rm', ['-rf', userDataDir])
