// node bin/decrypt-vf.mjs <raw|car|tar> <outerRoot> <outDir>
// Same as decrypt.mjs but the envelope bytes come through @helia/verified-fetch (trustless gateway, block-verified),
// which is what a browser viewer would use instead of trusting a path gateway.
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import * as fee from 'filecoin-encryption-envelope'
import { createVerifiedFetch } from '@helia/verified-fetch'
import { unpackCar } from '../lib/car-unpack.mjs'
import { extractTar } from '../lib/tar-payload.mjs'
import { keyFromInfo } from '../lib/kdf.mjs'

const [fmt, root, outDir] = process.argv.slice(2)
await mkdir(outDir, { recursive: true, mode: 0o700 })
const vf = await createVerifiedFetch({ gateways: ['http://127.0.0.1:8080'], routers: [], allowLocal: true, allowInsecure: true })
const t0 = performance.now()
const res = await vf(`ipfs://${root}`)
if (!res.ok) throw new Error(`verified-fetch ${res.status}`)
const plain = res.body.pipeThrough(fee.decrypt((i) => keyFromInfo(i)))
let stats
if (fmt === 'raw') {
  const fh = await open(join(outDir, 'payload.bin'), 'wx', 0o600); let bytes = 0
  await plain.pipeTo(new WritableStream({ async write(c) { await fh.write(c); bytes += c.length }, async close() { await fh.close() } }))
  stats = { files: 1, bytes }
} else if (fmt === 'tar') stats = await extractTar(plain, outDir)
else stats = await unpackCar(plain, outDir)
const t1 = performance.now()
await vf.stop()
console.log(JSON.stringify({ fmt, root, via: 'verified-fetch', totalMs: Math.round(t1 - t0), maxRssBytes: process.resourceUsage().maxRSS, ...stats }))
