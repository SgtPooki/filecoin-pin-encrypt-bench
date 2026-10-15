import { importer } from 'ipfs-unixfs-importer'
import * as dagPb from '@ipld/dag-pb'
const n = Number(process.argv[2]) // MiB
const blocks = new Map()
const bs = { async put(cid, bytes) { blocks.set(cid.toString(), bytes); return cid }, async get(cid) { return blocks.get(cid.toString()) }, async has(cid) { return blocks.has(cid.toString()) } }
async function* content() { const z = new Uint8Array(1 << 20); for (let i = 0; i < n; i++) yield z }
let root
for await (const e of importer([{ path: 'f.bin', content: content() }], bs, { profile: 'unixfs-v1-2025' })) root = e.cid
const rb = blocks.get(root.toString())
console.log('root', root.toString(), 'bytes', rb.length)
try { const d = dagPb.decode(rb); console.log('root decodes: links', d.Links.length) } catch (e) { console.log('ROOT DECODE FAIL', e.message, Buffer.from(rb.subarray(0, 64)).toString('hex')) }
