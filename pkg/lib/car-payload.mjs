// Candidate 2: UnixFS CAR payload, "metadata-first" block order.
//
// Order inside the CARv1: header, every dag-pb node (BFS from the root, each once),
// then every raw leaf in DFS/file order (first occurrence only, so dedup is kept).
// A reader therefore knows the whole tree before the first data byte, can list,
// can stream-unpack in one pass with memory bounded by the metadata, and can map
// any (file, offset) to a CAR byte offset with no further reads.
//
// Built in two passes over the input with no plaintext temp file:
//   pass 1  ipfs-unixfs-importer (unixfs-v1-2025 profile, wrapWithDirectory) computes the DAG;
//           dag-pb nodes are kept in memory, raw leaf bytes are discarded (only sizes kept)
//   pass 2  re-read each file at the leaf offsets, verify each chunk's CID, emit sections
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readdir, lstat, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importer } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { DAG_PB, RAW, carHeader, layout, sectionLength, varintEncode } from './car-layout.mjs'
export * from './car-layout.mjs'

/** Walk a path: files and directories, symlinks skipped (reported). Paths are rooted at basename(input). */
export async function walkInput(inputPath) {
  const name = basename(inputPath)
  const st = await lstat(inputPath)
  if (st.isSymbolicLink()) throw new Error('input is a symlink')
  const files = [] // { rel, abs, size }
  const dirs = [] // rel (only empty dirs need explicit candidates, but listing all is harmless)
  const skippedSymlinks = []
  if (st.isFile()) { files.push({ rel: name, abs: inputPath, size: st.size }); return { name, files, dirs, skippedSymlinks, isDirectory: false } }
  async function rec(abs, rel) {
    dirs.push(rel)
    const entries = (await readdir(abs)).sort()
    for (const e of entries) {
      const a = join(abs, e), r = `${rel}/${e}`
      const s = await lstat(a)
      if (s.isSymbolicLink()) skippedSymlinks.push(r)
      else if (s.isDirectory()) await rec(a, r)
      else if (s.isFile()) files.push({ rel: r, abs: a, size: s.size })
    }
  }
  await rec(inputPath, name)
  return { name, files, dirs, skippedSymlinks, isDirectory: true }
}

/**
 * Raw-leaf importer that hashes with crypto.subtle.digest. Node runs WebCrypto digests on the libuv
 * threadpool, so with blockWriteConcurrency N the importer hashes N chunks at once instead of one.
 */
function subtleBufferImporter(file, blockstore) {
  return (async function* () {
    for await (const block of file.content) {
      yield async () => {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', block))
        const cid = CID.createV1(RAW, Digest.create(0x12, digest))
        await blockstore.put(cid, block)
        return { cid, unixfs: undefined, size: BigInt(block.length), block }
      }
    }
  })()
}

/** Pass 1: compute the DAG. Returns { root, nodes: Map<cidStr,{cid,bytes}>, fileByCid: Map<cidStr, abs> , rawSizes } */
export async function planDag(inputPath, { hasher = 'default', concurrency = 8 } = {}) {
  const walk = await walkInput(inputPath)
  const nodes = new Map()
  const rawSizes = new Map()
  const blockstore = {
    async put(cid, bytes) {
      if (cid.code === DAG_PB) nodes.set(cid.toString(), { cid, bytes })
      else rawSizes.set(cid.toString(), bytes.length)
      return cid
    },
    async get(cid) { const n = nodes.get(cid.toString()); if (!n) throw new Error(`get ${cid}`); return n.bytes },
    async has(cid) { return nodes.has(cid.toString()) || rawSizes.has(cid.toString()) },
  }
  const absByRel = new Map(walk.files.map((f) => [f.rel, f.abs]))
  async function* candidates() {
    for (const d of walk.dirs) yield { path: d }
    for (const f of walk.files) yield { path: f.rel, content: createReadStream(f.abs, { highWaterMark: 1 << 20 }) }
  }
  const fileByCid = new Map()
  let root
  const opts = { profile: 'unixfs-v1-2025', wrapWithDirectory: true }
  if (hasher === 'subtle') Object.assign(opts, { bufferImporter: subtleBufferImporter, blockWriteConcurrency: concurrency })
  for await (const entry of importer(candidates(), blockstore, opts)) {
    const abs = absByRel.get(entry.path)
    if (abs != null && !fileByCid.has(entry.cid.toString())) fileByCid.set(entry.cid.toString(), abs)
    root = entry.cid
  }
  return { ...walk, root, nodes, rawSizes, fileByCid }
}

const sha256 = (b) => createHash('sha256').update(b).digest()

/** Pass 2: async iterable of CAR bytes. Reads each leaf from its first target file and verifies its CID. */
export async function* emitCar(plan, lay, { verify = 'hash' } = {}) {
  const statKey = (st) => `${st.size}:${st.mtimeNs}`
  const before = new Map()
  if (verify === 'stat') for (const f of plan.files) before.set(f.abs, statKey(await stat(f.abs, { bigint: true })))
  yield lay.header
  for (const m of lay.metadata) {
    const { bytes } = plan.nodes.get(m.cid.toString())
    yield varintEncode(m.cid.bytes.length + bytes.length); yield m.cid.bytes; yield bytes
  }
  let fd, fdPath
  try {
    for (const L of lay.leaves) {
      const t = L.targets[0]
      const abs = plan.fileByCid.get(L.cid.toString())
      if (!abs) throw new Error(`no source file for ${t.path}`)
      if (abs !== fdPath) { await fd?.close(); fd = await open(abs, 'r'); fdPath = abs }
      const buf = new Uint8Array(L.len)
      const { bytesRead } = await fd.read(buf, 0, L.len, t.fileOffset)
      if (bytesRead !== L.len) throw new Error(`short read in ${abs} (input changed during encryption?)`)
      if (verify === 'hash' && Buffer.compare(sha256(buf), Buffer.from(L.cid.multihash.digest)) !== 0) throw new Error(`chunk hash mismatch in ${abs} at ${t.fileOffset} (input changed during encryption?)`)
      yield varintEncode(L.cid.bytes.length + L.len); yield L.cid.bytes; yield buf
    }
  } finally { await fd?.close() }
  if (verify === 'stat') for (const f of plan.files) if (statKey(await stat(f.abs, { bigint: true })) !== before.get(f.abs)) throw new Error(`${f.abs} changed during encryption`)
}

/** Convenience: plan + layout + stream, and the exact plaintext length up front. */
export async function buildCarPayload(inputPath, planOpts = {}) {
  const plan = await planDag(inputPath, planOpts)
  // The leaf -> source mapping prefers the importer's file cid map; dedup across files is fine either way.
  const lay = layout(plan.root, plan.nodes)
  // layout paths are wrapper-relative, identical to walk.rel
  const absByRel = new Map(plan.files.map((f) => [f.rel, f.abs]))
  plan.fileByCid = new Map()
  for (const L of lay.leaves) plan.fileByCid.set(L.cid.toString(), absByRel.get(L.targets[0].path))
  return { plan, lay, contentLength: lay.total, stream: () => ReadableStream.from(emitCar(plan, lay)) }
}


export { sha256 }
