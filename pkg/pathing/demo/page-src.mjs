// The reader that holds the key. Everything here is plain JavaScript over HTTP Range to the sibling encrypted.fee.
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { openCarReader } from '../../lib/car-seek.mjs'
import { openSource } from './source.mjs'

const $ = (id) => document.getElementById(id)
const t0 = Date.now()
const status = (m) => { $('status').textContent = m }
setInterval(() => { $('elapsed').textContent = $('status').textContent ? `(${Math.round((Date.now() - t0) / 1000)} s since load)` : '' }, 1000)
const hexToBytes = (h) => new Uint8Array(h.replace(/^0x/, '').match(/../g).map((b) => parseInt(b, 16)))
const fmt = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KiB` : `${n} B`)
const CHUNK = 262144
const ENVELOPE = new URL('encrypted.fee', location.href).toString()

let reader = null
let src = null
const requests = []
let why = 'index'

// ---------- left panel: what existing clients get ----------
async function gatewayPanel() {
  const rows = [
    ['GET encrypted.fee, Range: bytes=0-1023', async () => fetch(ENVELOPE, { headers: { range: 'bytes=0-1023' }, cache: 'no-store' })],
    ['GET encrypted.fee?format=raw (trustless block)', async () => fetch(`${ENVELOPE}?format=raw`, { cache: 'no-store' })],
    ['GET encrypted.fee/docs/notes.txt (a path into the file)', async () => fetch(`${ENVELOPE}/docs/notes.txt`, { cache: 'no-store' })],
  ]
  for (const [label, run] of rows) {
    const tr = document.createElement('tr')
    const a = document.createElement('td'); a.innerHTML = `<code></code>`; a.firstChild.textContent = label
    const b = document.createElement('td'); b.textContent = '…'
    tr.append(a, b); $('gw').appendChild(tr)
    try {
      const res = await run()
      const body = await res.arrayBuffer()
      const text = new TextDecoder().decode(body.slice(0, 400)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)
      const okish = label.includes('path') ? res.status >= 400 : res.status < 300
      b.innerHTML = `<span class="${okish ? 'ok' : 'bad'}"></span> `
      b.firstChild.textContent = `${res.status}`
      b.append(` ${res.headers.get('content-type') ?? ''}, ${fmt(body.byteLength)}${label.includes('path') ? ` — ${text}` : ''}`)
    } catch (e) { b.textContent = `failed: ${e.message}` }
  }
}

// ---------- right panel ----------
function counter() {
  const n = src.stats.requests, b = src.stats.bytes
  $('counter').textContent = `${n} request${n === 1 ? '' : 's'}, ${fmt(b)} of ${fmt(src.size)}`
}

function strip() {
  const el = $('strip'); el.textContent = ''
  const spans = Math.ceil(src.size / CHUNK)
  const hit = new Set()
  for (const r of requests) for (let i = Math.floor(r.offset / CHUNK); i <= Math.floor((r.offset + r.length - 1) / CHUNK); i++) hit.add(i)
  for (let i = 0; i < Math.min(spans, 400); i++) { const b = document.createElement('i'); if (hit.has(i)) b.className = 'hit'; el.appendChild(b) }
}

// A row is added when the Range is issued and its byte cell updated as the body arrives, so a read the
// reader cancels early (the index) still shows up, with the bytes actually received.
function addRequest(offset, length) {
  const entry = { why, offset, length, bytes: 0 }
  requests.push(entry)
  const tr = document.createElement('tr')
  tr.innerHTML = `<td></td><td><code></code></td><td></td>`
  tr.children[0].textContent = why
  tr.children[1].firstChild.textContent = `bytes=${offset}-${offset + length - 1}`
  tr.children[2].textContent = '…'
  $('reqs').appendChild(tr)
  counter(); strip()
  return (bytes) => { entry.bytes = bytes; tr.children[2].textContent = fmt(bytes); counter() }
}

async function open(hex) {
  status('asking the gateway for the first 4 KiB of the envelope. A cold gateway first fetches the whole first 1 MiB block from the storage provider, which on calibration can take a minute or more; nothing else is downloaded.')
  $('header').textContent = 'waiting for the first block of the envelope'
  src = await openSource(ENVELOPE, (m) => { if (!/first/.test(m)) status(m) })
  why = 'envelope header'
  addRequest(0, 4096)(src.stats.bytes) // the one read openSource already made
  const info = await fee.parse(src)
  const labels = { ...info.appMetadata }
  $('header').textContent = [
    `size            ${src.size} bytes (${fmt(src.size)})`,
    `content_type    ${info.contentType}`,
    `scheme          ${info.scheme}, ${info.params?.chunkSize ?? CHUNK} B chunks`,
    ...Object.entries(labels).map(([k, v]) => `${k.padEnd(15)} ${v}`),
    `everything else is ciphertext: no names, no sizes, no file count`,
  ].join('\n')
  // instrument the source so every Range shows up in the table and the strip
  const raw = src.openRange.bind(src)
  src.openRange = async (offset, length) => {
    const before = src.stats.requests
    const stream = await raw(offset, length)
    if (src.stats.requests === before) return stream // served from the cached header, no network request
    const update = addRequest(offset, length)
    let got = 0
    return stream.pipeThrough(new TransformStream({
      transform(chunk, c) { got += chunk.length; update(got); c.enqueue(chunk) },
      flush() { update(got) },
    }))
  }
  why = 'folder index (bounded read, cancelled once the directory nodes have arrived)'
  status('decrypting the folder index')
  reader = await openCarReader(src, hexToBytes(hex))
  counter(); strip()
  const wrapper = dagPb.decode(reader.nodes.get(reader.root.toString()).bytes)
  $('innercid').textContent = `inner root ${reader.root} → folder ${wrapper.Links[0].Hash} (the CID a plain add of the folder produces; ${reader.nodes.size} directory nodes, ${fmt(reader.metadataBytes)} of index)`
  renderTree()
  status('')
}

function renderTree() {
  const ul = $('files'); ul.textContent = ''
  const groups = new Map()
  for (const [p, f] of reader.files) {
    const parts = p.split('/')
    const top = parts.length > 2 ? parts.slice(0, 2).join('/') : null
    if (top && top.endsWith('/many')) { const g = groups.get(top) ?? { n: 0, bytes: 0 }; g.n++; g.bytes += f.size; groups.set(top, g); continue }
    const li = document.createElement('li')
    const a = document.createElement('a'); a.textContent = `${p} (${fmt(f.size)})`
    a.addEventListener('click', () => { $('path').value = p.split('/').slice(1).join('/'); resolve() })
    li.appendChild(a)
    if (p.endsWith('big.bin')) {
      const b = document.createElement('button'); b.textContent = 'read 64 KiB at offset 12 MiB'; b.style.marginLeft = '.5rem'
      b.addEventListener('click', () => resolve(p.split('/').slice(1).join('/'), 12 * 1024 * 1024, 65536))
      li.appendChild(b)
      li.appendChild(Object.assign(document.createElement('span'), { className: 'muted', textContent: ' not downloaded' }))
    }
    ul.appendChild(li)
  }
  for (const [g, { n, bytes }] of groups) {
    const li = document.createElement('li')
    li.textContent = `${g.split('/')[1]}/ — ${n} files, ${fmt(bytes)}, HAMT-sharded directory; open one with the path box`
    ul.appendChild(li)
  }
}

// Walk the decrypted dag-pb nodes the way UnixFS path resolution does, recording each hop.
function walk(path) {
  const node = (cid) => { const n = reader.nodes.get(cid.toString()); if (!n) return null; const pb = dagPb.decode(n.bytes); return { cid, pb, ufs: pb.Data ? UnixFS.unmarshal(pb.Data) : null } }
  const hops = []
  let cur = node(reader.root)
  const wrapperLink = cur.pb.Links[0]
  hops.push(`root ${cur.cid} : UnixFS ${cur.ufs?.type} with one entry "${wrapperLink.Name}" (the folder)`)
  cur = node(wrapperLink.Hash)
  let prefix = wrapperLink.Name
  for (const seg of path.split('/')) {
    if (!cur) { hops.push(`${seg}: node not in index`); break }
    if (cur.ufs?.type === 'directory') {
      const l = cur.pb.Links.find((x) => x.Name === seg)
      if (!l) { hops.push(`${prefix}: directory ${cur.cid} has no entry "${seg}"`); return hops }
      hops.push(`${prefix}: directory ${cur.cid}, ${cur.pb.Links.length} entries, link "${seg}" → ${l.Hash}`)
      prefix += `/${seg}`; cur = node(l.Hash) ?? { cid: l.Hash, pb: null, ufs: null, leaf: true }
    } else if (cur.ufs?.type === 'hamt-sharded-directory') {
      // UnixFS HAMT: link names are a 2-hex bucket prefix plus the entry name; a bare prefix is a sub-shard
      let shard = cur, depth = 0, found = null
      while (shard && !found) {
        const direct = shard.pb.Links.find((x) => x.Name.length > 2 && x.Name.slice(2) === seg)
        if (direct) { hops.push(`${prefix}: HAMT shard ${shard.cid} (depth ${depth}, ${shard.pb.Links.length} links), bucket ${direct.Name.slice(0, 2)} holds "${seg}" → ${direct.Hash}`); found = direct; break }
        let next = null
        for (const x of shard.pb.Links) { if (x.Name.length === 2) { const sub = node(x.Hash); if (sub && JSON.stringify(sub.pb.Links.map((y) => y.Name)).includes(seg)) { next = x; break } } }
        if (!next) { hops.push(`${prefix}: no bucket in shard ${shard.cid} leads to "${seg}"`); return hops }
        hops.push(`${prefix}: HAMT shard ${shard.cid} (depth ${depth}, ${shard.pb.Links.length} links), bucket ${next.Name} → sub-shard ${next.Hash}`)
        shard = node(next.Hash); depth++
      }
      prefix += `/${seg}`; cur = node(found.Hash) ?? { cid: found.Hash, pb: null, ufs: null, leaf: true }
    } else { hops.push(`${prefix}: ${cur.cid} is a file, cannot path into it`); return hops }
  }
  if (cur?.leaf) hops.push(`${prefix}: raw leaf ${cur.cid} (single-block file)`)
  else if (cur?.ufs?.type === 'file') hops.push(`${prefix}: file ${cur.cid}, ${cur.pb.Links.length} leaves, ${cur.ufs.fileSize()} bytes`)
  return hops
}

async function resolve(path = $('path').value.trim(), offset = 0, length) {
  if (!reader) return
  const full = `${[...reader.files.keys()][0].split('/')[0]}/${path}`
  const f = reader.files.get(full)
  const trace = $('trace')
  const hops = walk(path)
  if (!f) { trace.textContent = `${hops.join('\n')}\n\nno such file: ${path}`; return }
  const len = length ?? f.size
  const leaves = f.leaves.filter((l) => l.fileOffset + l.len > offset && l.fileOffset < offset + len)
  hops.push(`leaves for bytes ${offset}-${offset + len - 1}: ${leaves.map((l) => `${l.leaf.cid} @ inner CAR ${l.leaf.dataOffset}`).join(', ')}`)
  const first = leaves[0].leaf.dataOffset + (offset - leaves[0].fileOffset)
  hops.push(`inner CAR bytes ${first}… → FEE chunks ${Math.floor(first / CHUNK)}… → one Range on the outer file`)
  trace.textContent = hops.join('\n')
  why = `${path} [${offset}+${len}]`
  status(`decrypting ${path}`)
  const bytes = new Uint8Array(await new Response(reader.read(full, offset, len)).arrayBuffer())
  status('')
  const v = $('viewer'); v.textContent = ''; v.className = ''
  const ext = path.split('.').pop()
  if (ext === 'mp4') {
    const el = document.createElement('video'); el.controls = true; el.muted = true; el.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' })); v.appendChild(el)
    v.appendChild(Object.assign(document.createElement('p'), { className: 'muted', textContent: `${path}: ${fmt(bytes.length)} decrypted into the page; seeking inside it is local here (measured as one Range per seek in the benchmark)` }))
  } else if (ext === 'bin') {
    const hex = Array.from(bytes.subarray(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join(' ')
    v.appendChild(Object.assign(document.createElement('pre'), { textContent: `${path} bytes ${offset}-${offset + len - 1} (${fmt(len)} of ${fmt(f.size)}):\n${hex} …` }))
  } else {
    v.appendChild(Object.assign(document.createElement('pre'), { textContent: new TextDecoder().decode(bytes) }))
  }
  window.demo = { ...(window.demo ?? {}), last: { path, offset, len, bytes: bytes.length } }
}

async function main() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('k')
  if (fromHash) { $('key').value = fromHash; $('keysrc').textContent = '(from the URL fragment, which the gateway never receives)' }
  const key = $('key').value.trim()
  if (!key) { status('paste the piece key, or open this page with #k=<hex>'); return }
  try {
    await open(key)
    window.demo = { mode: 'reader', files: [...reader.files.keys()], stats: () => src.stats, requests, resolve }
    $('path').value = 'many/f4321.txt'
    await resolve()
  } catch (e) { status(`error: ${e.message}`) }
}
$('go').addEventListener('click', main)
$('resolve').addEventListener('click', () => resolve())
gatewayPanel()
main()
