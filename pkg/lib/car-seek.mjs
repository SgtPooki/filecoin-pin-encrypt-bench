// Random access into a metadata-first UnixFS CAR inside a FEE envelope, over a RandomAccessSource.
// Prep: one open-ended decryptRange from plaintext offset 0, read until every dag-pb node referenced
// from the root has arrived, then cancel. After that any (path, offset, length) maps to CAR offsets
// with no further metadata reads.
import * as fee from 'filecoin-encryption-envelope'
import { DAG_PB, RAW, layout, scanCar } from './car-layout.mjs'

export async function openCarReader(source, cek) {
  const t0 = performance.now()
  const { stream, totalPlaintextLength } = await fee.decryptRange(source, cek, { offset: 0 })
  const reader = stream.getReader()
  const nodes = new Map()
  let buf = new Uint8Array(0), root, lay, consumedBlocks = 0, rawSeen = false
  while (!lay) {
    const { value, done } = await reader.read()
    if (done) break
    const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb
    const { header, blocks } = scanCar(buf)
    if (!header) continue
    root ??= header.roots[0]
    for (const b of blocks.slice(consumedBlocks)) {
      if (b.cid.code === DAG_PB) nodes.set(b.cid.toString(), { cid: b.cid, bytes: b.bytes })
      else if (b.cid.code === RAW) rawSeen = true
    }
    consumedBlocks = blocks.length
    try { lay = layout(root, nodes) } catch (e) { if (!/metadata incomplete/.test(e.message)) throw e; if (rawSeen) throw new Error('raw leaf before metadata closure: not metadata-first') }
  }
  await reader.cancel().catch(() => {})
  if (!lay) throw new Error('metadata never closed')
  const prepMs = performance.now() - t0
  const metadataBytes = lay.leaves[0]?.offset ?? lay.total
  if (lay.total !== totalPlaintextLength) throw new Error(`layout total ${lay.total} != plaintext ${totalPlaintextLength}`)

  /**
   * ReadableStream of plaintext for file `path` bytes [offset, offset+length).
   * Consecutive leaves that are adjacent in the CAR are read with ONE decryptRange over the whole span and the
   * per-block framing (varint + CID) between them is stripped on the fly, so a Range request costs the same
   * number of HTTP requests as a raw payload. A dedup gap (leaf stored elsewhere) starts a new span.
   */
  function read(path, offset, length) {
    const f = lay.files.get(path)
    if (!f) throw new Error(`no such file ${path}`)
    const end = Math.min(offset + length, f.size)
    let i = f.leaves.findIndex((l) => l.fileOffset + l.len > offset)
    let pos = offset
    let reader = null, carPos = 0, spanEnd = 0, cuts = [] // cuts: [{from,to}) CAR byte ranges to drop (framing)
    async function openSpan() {
      const first = f.leaves[i]
      const from = first.leaf.dataOffset + (pos - first.fileOffset)
      let j = i, to = first.leaf.dataOffset + first.len
      cuts = []
      while (j + 1 < f.leaves.length && f.leaves[j + 1].fileOffset < end) {
        const a = f.leaves[j].leaf, b = f.leaves[j + 1].leaf
        if (b.offset !== a.offset + (a.dataOffset - a.offset) + a.len) break // not adjacent in the CAR (dedup)
        cuts.push({ from: a.dataOffset + a.len, to: b.dataOffset })
        j++; to = b.dataOffset + b.len
      }
      const last = f.leaves[j]
      to = Math.min(to, last.leaf.dataOffset + (end - last.fileOffset))
      const { stream } = await fee.decryptRange(source, cek, { offset: from, length: to - from })
      reader = stream.getReader(); carPos = from; spanEnd = to; i = j + 1
    }
    return new ReadableStream({
      async pull(c) {
        // a pull must enqueue or close before returning, otherwise the stream never pulls again
        for (;;) {
          if (pos >= end) { c.close(); return }
          if (!reader) await openSpan()
          const { value, done } = await reader.read()
          if (done) { reader = null; if (carPos !== spanEnd) throw new Error('short span'); continue }
          if (emit(c, value)) return
        }
      },
      cancel() { reader?.cancel().catch(() => {}) },
    })
    function emit(c, value) {
        // strip framing cuts that fall inside this chunk
        let out = [], p = carPos, chunkEnd = carPos + value.length
        for (const cut of cuts) {
          if (cut.to <= p || cut.from >= chunkEnd) continue
          if (cut.from > p) out.push(value.subarray(p - carPos, cut.from - carPos))
          p = Math.min(cut.to, chunkEnd)
        }
        if (p < chunkEnd) out.push(value.subarray(p - carPos))
        carPos = chunkEnd
        let any = false
        for (const o of out) { if (o.length) { c.enqueue(o); pos += o.length; any = true } }
        return any
    }
  }
  return { lay, root, read, prepMs, metadataBytes, files: lay.files, size: (p) => lay.files.get(p)?.size }
}
