import { UnixFS } from 'ipfs-unixfs'
const vals = [2 ** 31 - 1, 2 ** 31, 2 ** 31 + 1, 3000000000, 3891799298, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 5368709120, 5369036956, 2 ** 33]
for (const total of vals) {
  const data = new UnixFS({ type: 'file', blockSizes: [BigInt(total)] }).marshal()
  let back; try { back = String(UnixFS.unmarshal(data).fileSize()) } catch (e) { back = 'UNMARSHAL FAIL' }
  console.log(String(total).padStart(11), 'roundtrip', back.padStart(11), back === String(total) ? 'OK ' : 'BAD', Buffer.from(data).toString('hex'))
}
