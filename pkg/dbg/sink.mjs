import * as fee from 'filecoin-encryption-envelope'
import { streamUrl } from '../lib/http-source.mjs'
import { keyFromInfo } from '../lib/kdf.mjs'
const [url, mode] = process.argv.slice(2)
const t0 = performance.now(); let n = 0, pieces = 0
let s = await streamUrl(url)
if (mode !== 'fetch-only') s = s.pipeThrough(fee.decrypt((i) => keyFromInfo(i)))
for await (const c of s) { n += c.length; pieces++ }
console.log(`${mode}: ${n} bytes, ${pieces} pieces, ${Math.round(performance.now() - t0)} ms, ${(n / 1e9 / ((performance.now() - t0) / 1000)).toFixed(2)} GB/s`)
