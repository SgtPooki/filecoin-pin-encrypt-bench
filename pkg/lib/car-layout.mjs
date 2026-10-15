// Pure (browser-safe) CAR layout helpers for the metadata-first UnixFS CAR profile.
import { encode as cborEncode, decode as cborDecode } from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'

export const RAW = 0x55
export const DAG_PB = 0x70
export const CONTENT_TYPE = 'application/vnd.ipld.car'

export function varintEncode(n) {
  const out = []
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128) }
  out.push(n)
  return Uint8Array.from(out)
}
export function varintDecode(buf, pos = 0) {
  let n = 0, shift = 0, i = pos
  for (;;) {
    if (i >= buf.length) return undefined
    const b = buf[i++]
    n += (b & 0x7f) * 2 ** shift
    if (b < 0x80) return [n, i - pos]
    shift += 7
  }
}
export function sectionLength(cid, dataLen) {
  const body = cid.bytes.length + dataLen
  return varintEncode(body).length + body
}
export function carHeader(root) {
  const h = cborEncode({ roots: [root], version: 1 })
  const v = varintEncode(h.length)
  const out = new Uint8Array(v.length + h.length); out.set(v); out.set(h, v.length)
  return out
}

function decodeNode(nodes, cidStr) {
  const n = nodes.get(cidStr)
  if (!n) throw new Error(`metadata incomplete: missing dag-pb node ${cidStr}`)
  if (!n.decoded) {
    const pb = dagPb.decode(n.bytes)
    n.decoded = { links: pb.Links, unixfs: pb.Data ? UnixFS.unmarshal(pb.Data) : undefined }
  }
  return n.decoded
}

/**
 * Compute the block order and byte layout from the root + dag-pb nodes only.
 * Returns {
 *   metadata: [{cid, offset, len}], leaves: [{cid, offset, dataOffset, len, targets:[{path, fileOffset}]}],
 *   files: Map<path, {size, leaves:[{fileOffset, len, cid, dataOffset}]}>, dirs: [path], total
 * }
 * `path` is the UnixFS path under the wrapper root ("name/sub/file").
 */
export function layout(root, nodes) {
  const header = carHeader(root)
  let pos = header.length
  const metadata = []
  const seen = new Set()
  const q = [root]
  while (q.length) {
    const cid = q.shift(); const k = cid.toString()
    if (seen.has(k)) continue
    seen.add(k)
    const { bytes } = nodes.get(k) ?? (() => { throw new Error(`metadata incomplete: missing ${k}`) })()
    const len = sectionLength(cid, bytes.length)
    metadata.push({ cid, offset: pos, len }); pos += len
    const { links } = decodeNode(nodes, k)
    for (const l of links) if (l.Hash.code === DAG_PB) q.push(l.Hash)
  }
  const leaves = []
  const leafByCid = new Map()
  const files = new Map()
  const dirs = []
  const dirSet = new Set()
  const unsafe = (name) => name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')

  function leaf(cid, size, path, fileOffset) {
    const k = cid.toString()
    let L = leafByCid.get(k)
    if (!L) {
      L = { cid, len: size, targets: [], offset: 0, dataOffset: 0 }
      leafByCid.set(k, L); leaves.push(L)
    } else if (L.len !== size) throw new Error(`leaf ${k} referenced with two sizes`)
    L.targets.push({ path, fileOffset })
    files.get(path).leaves.push({ fileOffset, len: size, cid, leaf: L })
  }
  function fileTree(cid, size, path, fileOffset) {
    if (cid.code === RAW) { leaf(cid, size, path, fileOffset); return size }
    const { links, unixfs } = decodeNode(nodes, cid.toString())
    if (!unixfs || (unixfs.type !== 'file' && unixfs.type !== 'raw')) throw new Error(`expected file node at ${path}, got ${unixfs?.type}`)
    if (unixfs.data?.length) throw new Error(`inline file data not allowed under this profile (${path})`)
    let off = fileOffset
    links.forEach((l, i) => { off += fileTree(l.Hash, Number(unixfs.blockSizes[i] ?? l.Tsize), path, off) })
    return off - fileOffset
  }
  function dir(cid, path) {
    const { links, unixfs } = decodeNode(nodes, cid.toString())
    if (!unixfs) throw new Error('dag-pb node without UnixFS data')
    if (unixfs.type === 'directory' || unixfs.type === 'hamt-sharded-directory') {
      if (path !== '') { dirs.push(path); dirSet.add(path) }
      const hamt = unixfs.type === 'hamt-sharded-directory'
      for (const l of links) {
        let name = l.Name ?? ''
        if (hamt) {
          const sub = name.slice(2); name = sub
          if (sub === '') { // sub-shard: same directory path
            const child = decodeNode(nodes, l.Hash.toString())
            if (child.unixfs?.type !== 'hamt-sharded-directory') throw new Error('bad HAMT sub-shard')
            dirShard(l.Hash, path); continue
          }
        }
        if (unsafe(name)) throw new Error(`unsafe entry name ${JSON.stringify(name)} in ${path || '<root>'}`)
        entry(l.Hash, l.Tsize, path === '' ? name : `${path}/${name}`)
      }
      return
    }
    throw new Error(`unexpected UnixFS type ${unixfs.type} at ${path}`)
  }
  function dirShard(cid, path) {
    const { links } = decodeNode(nodes, cid.toString())
    for (const l of links) {
      const name = (l.Name ?? '').slice(2)
      if (name === '') dirShard(l.Hash, path)
      else { if (unsafe(name)) throw new Error(`unsafe entry name ${JSON.stringify(name)}`); entry(l.Hash, l.Tsize, path === '' ? name : `${path}/${name}`) }
    }
  }
  function entry(cid, tsize, path) {
    if (files.has(path) || dirSet.has(path)) throw new Error(`duplicate path ${path}`)
    if (cid.code === RAW) { files.set(path, { size: Number(tsize), leaves: [] }); leaf(cid, Number(tsize), path, 0); return }
    const { unixfs } = decodeNode(nodes, cid.toString())
    if (unixfs?.type === 'file' || unixfs?.type === 'raw') {
      files.set(path, { size: Number(unixfs.fileSize()), leaves: [] })
      const got = fileTree(cid, Number(unixfs.fileSize()), path, 0)
      if (got !== Number(unixfs.fileSize())) throw new Error(`file size mismatch at ${path}: ${got} vs ${unixfs.fileSize()}`)
      return
    }
    if (unixfs?.type === 'symlink') throw new Error(`symlink entries are not allowed (${path})`)
    dir(cid, path)
  }
  // Root is the anonymous wrapper directory.
  dir(root, '')
  for (const L of leaves) {
    L.offset = pos
    L.dataOffset = pos + varintEncode(L.cid.bytes.length + L.len).length + L.cid.bytes.length
    pos += sectionLength(L.cid, L.len)
  }
  return { header, metadata, leaves, files, dirs, total: pos, root }
}

/**
 * Tolerant CAR section scanner over a growing byte buffer. Returns { header: {roots}, blocks:[{cid,bytes,offset}], consumed }.
 * Stops at the first incomplete section (so a prefix can be parsed).
 */
export function scanCar(buf) {
  let pos = 0
  const h = varintDecode(buf, 0); if (!h) return { consumed: 0, blocks: [] }
  const [hlen, hv] = h
  if (buf.length < hv + hlen) return { consumed: 0, blocks: [] }
  const header = cborDecode(buf.subarray(hv, hv + hlen))
  pos = hv + hlen
  const blocks = []
  for (;;) {
    const d = varintDecode(buf, pos); if (!d) break
    const [blen, bv] = d
    if (pos + bv + blen > buf.length) break
    const body = buf.subarray(pos + bv, pos + bv + blen)
    const [cid, rest] = CID.decodeFirst(body)
    blocks.push({ cid, bytes: rest, offset: pos, dataOffset: pos + bv + cid.bytes.length })
    pos += bv + blen
  }
  return { header, blocks, consumed: pos }
}

