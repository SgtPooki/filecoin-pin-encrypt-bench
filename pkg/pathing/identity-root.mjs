// node pathing/identity-root.mjs <gateway> <localEnvelope>
// Claude-session design 6: a UnixFS file node built client-side over existing leaves, encoded as an
// identity CID, so the gateway serves Range over those leaves with no structural block stored anywhere.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
const [gateway, local] = process.argv.slice(2)
const envelope = await readFile(local)
const leaf1 = CID.parse('bafkreifes6ywbq7y3h7xfx5vojdyxdnl6olpnveibbo75r3apujbc554pi') // bytes 0..1048575 of big.fee
const leaf2 = CID.parse('bafkreidmhvuq44vtipfrlogbify4pygyr7qsl7nl6fshy3jq3okgc5rsqm') // bytes 1048576..1100717
function fileNode(links) {
  const sizes = links.map(([, n]) => BigInt(n))
  const data = new UnixFS({ type: 'file', blockSizes: sizes }).marshal()
  const bytes = dagPb.encode({ Data: data, Links: links.map(([cid, n]) => ({ Hash: cid, Name: '', Tsize: n })) })
  return { cid: CID.createV1(dagPb.code, Digest.create(0x00, bytes)), bytes }
}
const sha = (b) => createHash('sha256').update(b).digest('hex')
async function probe(label, cid, start, len, expected) {
  const url = `${gateway}/ipfs/${cid}`
  const res = await fetch(url, { headers: { range: `bytes=${start}-${start + len - 1}` } })
  const b = new Uint8Array(await res.arrayBuffer())
  console.log(JSON.stringify({ label, cidChars: cid.toString().length, status: res.status, cr: res.headers.get('content-range'), len: b.length, ok: sha(b) === sha(expected), body: res.status >= 400 ? new TextDecoder().decode(b).slice(0, 160) : undefined }))
}
// 1. the whole envelope as a virtual file: both leaves
const whole = fileNode([[leaf1, 1048576], [leaf2, 52142]])
await probe('2-leaf virtual file, straddling range', whole.cid, 1048500, 200, envelope.subarray(1048500, 1048700))
await probe('2-leaf virtual file, tail', whole.cid, 1100000, 718, envelope.subarray(1100000, 1100718))
// 2. only the second leaf exposed as its own virtual file (a "per-file view" with no stored node)
const second = fileNode([[leaf2, 52142]])
await probe('1-leaf virtual file', second.cid, 100, 1000, envelope.subarray(1048576 + 100, 1048576 + 1100))
// 3. a 40-link virtual file (leaf1 repeated): URL length and link-count tolerance
const forty = fileNode(Array.from({ length: 40 }, () => [leaf1, 1048576]))
await probe('40-leaf virtual file, offset 39 MiB + 7', forty.cid, 39 * 1048576 + 7, 500, envelope.subarray(7, 507))
// 4. trustless: entity-bytes on the identity root
const res = await fetch(`${gateway}/ipfs/${second.cid}?format=car&dag-scope=entity&entity-bytes=0:999`)
console.log(JSON.stringify({ label: 'entity-bytes CAR on identity root', status: res.status, ct: res.headers.get('content-type'), len: (await res.arrayBuffer()).byteLength }))
