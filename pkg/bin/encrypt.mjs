// node bin/encrypt.mjs <raw|car|tar> <input> <out.fee>   -> JSON stats on stdout
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import * as fee from 'filecoin-encryption-envelope'
import { buildCarPayload, emitCar, CONTENT_TYPE as CAR_CT } from '../lib/car-payload.mjs'
import { buildTarPayload, CONTENT_TYPE as TAR_CT } from '../lib/tar-payload.mjs'
import { newKey } from '../lib/kdf.mjs'

const [fmt, input, out] = process.argv.slice(2)
const t0 = performance.now()
const st = await stat(input)
let payload, contentType, contentLength, meta = {}
if (fmt === 'raw') {
  if (st.isDirectory()) { console.log(JSON.stringify({ fmt, error: 'raw cannot encode a directory' })); process.exit(2) }
  payload = () => Readable.toWeb(createReadStream(input, { highWaterMark: 1 << 20 }))
  contentLength = st.size
} else if (fmt === 'car') {
  const b = await buildCarPayload(input, { hasher: process.env.BENCH_HASHER ?? 'default', concurrency: Number(process.env.BENCH_HASH_CONCURRENCY ?? 8) })
  const verify = process.env.BENCH_VERIFY === 'none' ? false : (process.env.BENCH_VERIFY ?? 'hash')
  payload = () => ReadableStream.from(emitCar(b.plan, b.lay, { verify })); contentType = CAR_CT; contentLength = b.contentLength
  meta = { root: b.lay.root.toString(), metadataBytes: b.lay.leaves[0]?.offset ?? b.lay.total, metadataBlocks: b.lay.metadata.length, leaves: b.lay.leaves.length, files: b.lay.files.size, dirs: b.lay.dirs.length, skippedSymlinks: b.plan.skippedSymlinks }
} else if (fmt === 'tar') {
  const b = await buildTarPayload(input)
  payload = b.stream; contentType = TAR_CT
  meta = { files: b.plan.files.length, dirs: b.plan.dirs.length, skippedSymlinks: b.plan.skippedSymlinks }
} else throw new Error(`unknown fmt ${fmt}`)
const tPlan = performance.now()
const { cek, appMetadata } = await newKey()
const tKdf = performance.now()
await payload().pipeThrough(fee.encrypt({ cek, contentLength, contentType, appMetadata })).pipeTo(Writable.toWeb(createWriteStream(out, { mode: 0o600 })))
const t1 = performance.now()
const envelopeBytes = (await stat(out)).size
const result = { fmt, input, inputBytes: st.isDirectory() ? undefined : st.size, envelopeBytes, contentLength, contentType, planMs: Math.round(tPlan - t0), kdfMs: Math.round(tKdf - tPlan), encryptMs: Math.round(t1 - tKdf), totalMs: Math.round(t1 - t0), maxRssBytes: process.resourceUsage().maxRSS, ...meta }
await writeFile(`${out}.meta.json`, JSON.stringify(result))
console.log(JSON.stringify(result))
