// node bin/decrypt.mjs <raw|car|tar> <url> <outDir>   CLI-style single-pass streaming decrypt from a gateway URL
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import * as fee from 'filecoin-encryption-envelope'
import { unpackCar } from '../lib/car-unpack.mjs'
import { unpackCarStream } from '../lib/car-unpack-stream.mjs'
import { extractTar } from '../lib/tar-payload.mjs'
import { streamUrl } from '../lib/http-source.mjs'
import { keyFromInfo } from '../lib/kdf.mjs'

const [fmt, url, outDir] = process.argv.slice(2)
await mkdir(outDir, { recursive: true, mode: 0o700 })
const t0 = performance.now()
let info, tFirst
const plain = (await streamUrl(url)).pipeThrough(fee.decrypt((i) => { info = i; return keyFromInfo(i) })).pipeThrough(new TransformStream({ transform(c, ctl) { tFirst ??= performance.now(); ctl.enqueue(c) } }))
let stats
if (fmt === 'raw') {
  const fh = await open(join(outDir, 'payload.bin'), 'wx', 0o600)
  let bytes = 0
  if (process.env.BENCH_FORAWAIT === '1') { for await (const c of plain) { if (process.env.BENCH_NOWRITE !== '1') await fh.write(c); bytes += c.length } await fh.close() }
  else await plain.pipeTo(new WritableStream({ async write(c) { if (process.env.BENCH_NOWRITE !== '1') await fh.write(c); bytes += c.length }, async close() { await fh.close() } }))
  stats = { files: 1, bytes }
} else if (fmt === 'tar') {
  let listMs
  stats = await extractTar(plain, outDir, { onList: () => { listMs ??= performance.now() - t0 } })
  stats.listMs = listMs
} else if (fmt === 'car') {
  stats = process.env.BENCH_READER === 'stream' ? await unpackCarStream(plain, outDir, { verify: process.env.BENCH_UNPACK_VERIFY !== 'none' }) : await unpackCar(plain, outDir, { verify: process.env.BENCH_UNPACK_VERIFY ?? 'sync', reader: process.env.BENCH_READER ?? 'ipld' })
} else throw new Error(`unknown fmt ${fmt}`)
const t1 = performance.now()
console.log(JSON.stringify({ fmt, url, contentType: info?.contentType, totalMs: Math.round(t1 - t0), firstPlainMs: Math.round(tFirst - t0), maxRssBytes: process.resourceUsage().maxRSS, ...stats }))
