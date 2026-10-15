// Single-pass streaming unpack of a metadata-first UnixFS CAR into a directory.
// Memory: the dag-pb metadata plus one leaf. Every leaf's CID is re-verified.
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CarBlockIterator } from '@ipld/car'
import { decode as cborDecode } from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import { varintDecode } from './car-layout.mjs'

/**
 * Lean CARv1 block reader: one allocation per block (filled in place from incoming chunks), no
 * intermediate concatenation. Yields { cid, bytes }. `roots` is set after the header is parsed.
 */
export async function* leanBlocks(webStream, out) {
  let head = new Uint8Array(0) // small accumulator for the header and section prefixes only
  let target = null, filled = 0, cid = null, headerDone = false
  const append = (a, b) => { const n = new Uint8Array(a.length + b.length); n.set(a); n.set(b, a.length); return n }
  for await (const chunk of webStream) {
    let pos = 0
    while (pos < chunk.length) {
      if (target) { // filling a block body
        const take = Math.min(target.length - filled, chunk.length - pos)
        target.set(chunk.subarray(pos, pos + take), filled); filled += take; pos += take
        if (filled === target.length) { yield { cid, bytes: target }; target = null; filled = 0 }
        continue
      }
      head = head.length ? append(head, chunk.subarray(pos)) : chunk.subarray(pos); pos = chunk.length
      for (;;) { // parse as many prefixes as the accumulator holds
        const d = varintDecode(head, 0); if (!d) break
        const [len, vl] = d
        if (!headerDone) {
          if (head.length < vl + len) break
          out.roots = cborDecode(head.subarray(vl, vl + len)).roots; headerDone = true
          head = head.subarray(vl + len); continue
        }
        if (head.length < vl + 40) { if (head.length < vl + len) break } // need the CID (<= 40 B) before deciding
        let c; try { [c] = CID.decodeFirst(head.subarray(vl)) } catch { break }
        const bodyLen = len - c.bytes.length
        const avail = head.length - vl - c.bytes.length
        cid = c; target = new Uint8Array(bodyLen)
        const take = Math.min(bodyLen, avail)
        target.set(head.subarray(vl + c.bytes.length, vl + c.bytes.length + take)); filled = take
        head = head.subarray(vl + c.bytes.length + take)
        if (filled === bodyLen) { yield { cid, bytes: target }; target = null; filled = 0; continue }
        // need more chunk data for this body; push leftover head back by prepending to the next chunk read
        if (head.length) throw new Error('unreachable: leftover after partial body')
        break
      }
    }
  }
  if (target || head.length) throw new Error('truncated CAR')
}
import { DAG_PB, RAW, layout, sha256 } from './car-payload.mjs'

export async function unpackCar(webStream, outDir, { verify = 'sync', onList, concurrency = 8, reader = 'ipld' } = {}) {
  const pending = new Set()
  const verifyAsync = (cid, bytes) => {
    const p = crypto.subtle.digest('SHA-256', bytes).then((d) => { if (Buffer.compare(Buffer.from(d), Buffer.from(cid.multihash.digest)) !== 0) throw new Error(`hash mismatch ${cid}`) }).finally(() => pending.delete(p))
    pending.add(p); return p
  }
  let it, roots, lean = null
  if (reader === 'lean') { lean = {}; it = leanBlocks(webStream, lean) }
  else { it = await CarBlockIterator.fromIterable(webStream); roots = await it.getRoots(); if (roots.length !== 1) throw new Error(`expected exactly one root, got ${roots.length}`) }
  let root = roots?.[0]
  const nodes = new Map()
  let lay, expected = [], next = 0
  const fds = new Map()
  const stats = { metadataBlocks: 0, leaves: 0, bytes: 0, listMs: 0, files: 0, dirs: 0 }
  const t0 = performance.now()

  // ponytail: bounded open-fd cache, oldest closed first; leaves arrive grouped per file so churn is low
  async function fdFor(path) {
    let fh = fds.get(path)
    if (!fh) {
      if (fds.size >= 64) { const [k, v] = fds.entries().next().value; await v.close(); fds.delete(k) }
      fh = await open(join(outDir, path), 'r+'); fds.set(path, fh)
    }
    return fh
  }
  async function startData() {
    lay = layout(root, nodes) // throws if any referenced dag-pb node is missing (not metadata-first)
    stats.listMs = performance.now() - t0
    for (const d of lay.dirs) await mkdir(join(outDir, d), { recursive: true, mode: 0o700 })
    for (const [p] of lay.files) { await mkdir(dirname(join(outDir, p)), { recursive: true, mode: 0o700 }); await (await open(join(outDir, p), 'wx', 0o600)).close() }
    stats.files = lay.files.size; stats.dirs = lay.dirs.length
    onList?.(lay)
    expected = lay.leaves
  }
  try {
    for await (const { cid, bytes } of it) {
      if (lean && !root) { if (lean.roots?.length !== 1) throw new Error(`expected exactly one root, got ${lean.roots?.length}`); root = lean.roots[0] }
      if (cid.code === DAG_PB) {
        if (lay) throw new Error('dag-pb block after data began: not metadata-first')
        nodes.set(cid.toString(), { cid, bytes }); stats.metadataBlocks++
        continue
      }
      if (cid.code !== RAW) throw new Error(`unexpected codec 0x${cid.code.toString(16)}`)
      if (!lay) await startData()
      const L = expected[next++]
      if (!L || !L.cid.equals(cid)) throw new Error(`leaf out of order: got ${cid}, expected ${L?.cid}`)
      if (bytes.length !== L.len) throw new Error(`leaf length ${bytes.length} != ${L.len}`)
      if (verify === 'sync' && Buffer.compare(sha256(bytes), Buffer.from(cid.multihash.digest)) !== 0) throw new Error(`hash mismatch ${cid}`)
      if (verify === 'async') { verifyAsync(cid, bytes); if (pending.size >= concurrency) await Promise.race(pending) }
      if (process.env.BENCH_NOWRITE !== '1') for (const t of L.targets) {
        const fh = await fdFor(t.path)
        await fh.write(bytes, 0, bytes.length, t.fileOffset)
      }
      stats.leaves++; stats.bytes += bytes.length
    }
    if (!lay) await startData() // metadata-only CAR (empty dir / empty files)
    if (next !== expected.length) throw new Error(`truncated: ${next}/${expected.length} leaves`)
    await Promise.all(pending)
  } finally { for (const fh of fds.values()) await fh.close() }
  return stats
}
