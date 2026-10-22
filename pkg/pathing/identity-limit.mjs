// Bisect how many leaves an identity-CID UnixFS file node may list before the gateway refuses it.
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
const [gateway, mode] = process.argv.slice(2)
const leaf = CID.parse('bafkreifes6ywbq7y3h7xfx5vojdyxdnl6olpnveibbo75r3apujbc554pi')
const node = (n) => {
  const links = Array.from({ length: n }, () => ({ Hash: leaf, Name: '', Tsize: 1048576 }))
  const bytes = dagPb.encode({ Data: new UnixFS({ type: 'file', blockSizes: links.map(() => 1048576n) }).marshal(), Links: links })
  return { cid: CID.createV1(dagPb.code, Digest.create(0x00, bytes)), bytes }
}
for (const n of [2, 3, 4, 6, 8, 12, 16, 24, 32]) {
  const { cid, bytes } = node(n)
  const url = mode === 'car' ? `${gateway}/ipfs/${cid}?format=car&dag-scope=entity&entity-bytes=0:9` : `${gateway}/ipfs/${cid}`
  const res = await fetch(url, { headers: mode === 'car' ? {} : { range: 'bytes=0-9' } })
  const body = await res.arrayBuffer()
  console.log(JSON.stringify({ links: n, nodeBytes: bytes.length, cidChars: cid.toString().length, status: res.status, len: body.byteLength, err: res.status >= 400 ? new TextDecoder().decode(body).replace(/bafy\w+/g, '<cid>').slice(0, 140) : undefined }))
}
