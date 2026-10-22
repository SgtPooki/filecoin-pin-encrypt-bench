// Print the byte layout of a CARv1 file: header length, then each section's offset, CID, codec and data length.
import { readFile } from 'node:fs/promises'
import { CarBlockIterator } from '@ipld/car'
import { CID } from 'multiformats/cid'
const bytes = await readFile(process.argv[2])
const varint = (pos) => { let n = 0, shift = 0, i = pos; for (;;) { const b = bytes[i++]; n += (b & 0x7f) * 2 ** shift; shift += 7; if (b < 0x80) return [n, i] } }
let [hlen, pos] = varint(0)
console.log('header: varint+cbor =', pos + hlen, 'bytes')
pos += hlen
const it = await CarBlockIterator.fromBytes(bytes)
for await (const b of it) {
  const [slen, dataStart] = varint(pos)
  const cidLen = CID.decodeFirst(bytes.subarray(dataStart))[0].bytes.length
  console.log(`section@${pos} len=${slen} cidBytes=${cidLen} data@${dataStart + cidLen} dataLen=${b.bytes.length} ${b.cid.code === 0x70 ? 'dag-pb' : 'raw'} ${b.cid}`)
  pos = dataStart + slen
}
console.log('total', bytes.length)
