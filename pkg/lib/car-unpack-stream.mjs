// Zero-copy single-pass unpack of a metadata-first UnixFS CAR: raw leaf bodies are written to their
// target file offsets piece by piece as they arrive from the decrypt stream (no leaf assembly, no
// extra copy); dag-pb nodes (small) are accumulated. Optional incremental SHA-256 per leaf.
import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decode as cborDecode } from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import { DAG_PB, RAW, layout, varintDecode } from './car-layout.mjs'

export async function unpackCarStream(webStream, outDir, { verify = true, onList } = {}) {
  const nodes = new Map()
  let root, lay, expected = [], next = 0
  const fds = new Map()
  const stats = { metadataBlocks: 0, leaves: 0, bytes: 0, listMs: 0, files: 0, dirs: 0 }
  const t0 = performance.now()
  async function fdFor(path) {
    let fh = fds.get(path)
    if (!fh) { if (fds.size >= 64) { const [k, v] = fds.entries().next().value; await v.close(); fds.delete(k) } fh = await open(join(outDir, path), 'r+'); fds.set(path, fh) }
    return fh
  }
  async function startData() {
    lay = layout(root, nodes)
    stats.listMs = performance.now() - t0
    for (const d of lay.dirs) await mkdir(join(outDir, d), { recursive: true, mode: 0o700 })
    for (const [p] of lay.files) { await mkdir(dirname(join(outDir, p)), { recursive: true, mode: 0o700 }); await (await open(join(outDir, p), 'wx', 0o600)).close() }
    stats.files = lay.files.size; stats.dirs = lay.dirs.length; onList?.(lay); expected = lay.leaves
  }
  // parser state
  let head = new Uint8Array(0), headerDone = false
  let cur = null // { cid, len, filled, hash, L, acc }  (acc only for dag-pb)
  const append = (a, b) => { const n = new Uint8Array(a.length + b.length); n.set(a); n.set(b, a.length); return n }
  async function body(piece) {
    if (cur.cid.code === DAG_PB) { cur.acc.push(piece); return }
    cur.hash?.update(piece)
    if (process.env.BENCH_NOWRITE !== '1') for (const t of cur.L.targets) await (await fdFor(t.path)).write(piece, 0, piece.length, t.fileOffset + cur.filled)
  }
  async function endBlock() {
    if (cur.cid.code === DAG_PB) {
      if (lay) throw new Error('dag-pb block after data began: not metadata-first')
      nodes.set(cur.cid.toString(), { cid: cur.cid, bytes: Buffer.concat(cur.acc) }); stats.metadataBlocks++
    } else {
      if (verify && Buffer.compare(cur.hash.digest(), Buffer.from(cur.cid.multihash.digest)) !== 0) throw new Error(`hash mismatch ${cur.cid}`)
      stats.leaves++; stats.bytes += cur.len
    }
    cur = null
  }
  async function startBlock(cid, len) {
    if (cid.code === DAG_PB) { cur = { cid, len, filled: 0, acc: [] }; return }
    if (cid.code !== RAW) throw new Error(`unexpected codec 0x${cid.code.toString(16)}`)
    if (!lay) await startData()
    const L = expected[next++]
    if (!L || !L.cid.equals(cid)) throw new Error(`leaf out of order: got ${cid}, expected ${L?.cid}`)
    if (len !== L.len) throw new Error(`leaf length ${len} != ${L.len}`)
    cur = { cid, len, filled: 0, L, hash: verify ? createHash('sha256') : null }
  }
  try {
    for await (const chunk of webStream) {
      let pos = 0
      while (pos < chunk.length) {
        if (cur) {
          const take = Math.min(cur.len - cur.filled, chunk.length - pos)
          await body(chunk.subarray(pos, pos + take)); cur.filled += take; pos += take
          if (cur.filled === cur.len) await endBlock()
          continue
        }
        head = head.length ? append(head, chunk.subarray(pos)) : chunk.subarray(pos); pos = chunk.length
        for (;;) {
          const d = varintDecode(head, 0); if (!d) break
          const [len, vl] = d
          if (!headerDone) { if (head.length < vl + len) break; root = cborDecode(head.subarray(vl, vl + len)).roots[0]; headerDone = true; head = head.subarray(vl + len); continue }
          let c; try { [c] = CID.decodeFirst(head.subarray(vl)) } catch { break }
          await startBlock(c, len - c.bytes.length)
          const rest = head.subarray(vl + c.bytes.length); head = new Uint8Array(0)
          const take = Math.min(cur.len, rest.length)
          if (take) { await body(rest.subarray(0, take)); cur.filled += take }
          if (cur.filled === cur.len) { await endBlock(); if (rest.length > take) { head = rest.subarray(take); continue } }
          break
        }
      }
    }
    if (cur || head.length) throw new Error('truncated CAR')
    if (!lay) await startData()
    if (next !== expected.length) throw new Error(`truncated: ${next}/${expected.length} leaves`)
  } finally { for (const fh of fds.values()) await fh.close() }
  return stats
}
