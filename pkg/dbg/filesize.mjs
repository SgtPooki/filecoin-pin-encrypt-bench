import { UnixFS } from 'ipfs-unixfs'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import * as dagPb from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
const IPFS = process.env.IPFS_SH
for (const total of [2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 3891799298]) {
  const u = new UnixFS({ type: 'file', blockSizes: [BigInt(total)] })
  const data = u.marshal()
  const back = UnixFS.unmarshal(data)
  const leaf = CID.createV1(0x55, await sha256.digest(new Uint8Array(1)))
  const node = dagPb.encode(dagPb.prepare({ Data: data, Links: [{ Hash: leaf, Name: '', Tsize: total }] }))
  const f = `/tmp/fs-${total}.bin`; writeFileSync(f, node)
  let kubo
  try { kubo = execFileSync(IPFS, ['dag', 'put', '--input-codec=dag-pb', '--store-codec=dag-pb', f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() } catch (e) { kubo = 'DAG PUT FAIL: ' + e.stderr.toString().trim().split('\n').at(-1) }
  console.log(total, 'js fileSize', back.fileSize(), 'data', Buffer.from(data).toString('hex'), '| kubo:', kubo)
}
