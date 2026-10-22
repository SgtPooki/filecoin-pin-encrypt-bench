// Service Worker that travels inside the upload. Scope: its own directory on whatever gateway serves it.
// `v/<path>` under the scope is answered by decrypting the sibling `encrypted.fee` (a #771 envelope:
// metadata-first UnixFS CAR inside FEE scheme 2) with the piece key the page hands over, one Range
// request per chunk-aligned span. Nothing is fetched from anywhere but the upload's own origin.
import * as fee from 'filecoin-encryption-envelope'
import { openCarReader } from '../../lib/car-seek.mjs'
import { openSource } from './source.mjs'

const TYPES = { md: 'text/plain', txt: 'text/plain', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', mp4: 'video/mp4', html: 'text/html', json: 'application/json', bin: 'application/octet-stream' }
let cek = null
let readerPromise = null

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('message', (e) => {
  if (e.data?.type === 'key') {
    cek = new Uint8Array(e.data.cek)
    readerPromise = null
    e.ports[0]?.postMessage({ ok: true })
  }
})

function openReader() {
  if (readerPromise) return readerPromise
  readerPromise = (async () => {
    const url = new URL('encrypted.fee', self.registration.scope).toString()
    const source = await openSource(url)
    const info = await fee.parse(source)
    const labels = { ...info.appMetadata }
    const r = await openCarReader(source, cek)
    return { r, source, labels, contentType: info.contentType }
  })()
  readerPromise.catch(() => { readerPromise = null })
  return readerPromise
}

self.addEventListener('fetch', (event) => {
  const u = new URL(event.request.url)
  const scope = new URL(self.registration.scope).pathname
  if (!u.pathname.startsWith(`${scope}v/`)) return
  event.respondWith(handle(event.request, decodeURIComponent(u.pathname.slice(scope.length + 2))).catch((e) => new Response(String(e?.message ?? e), { status: 500 })))
})

async function handle(req, path) {
  if (!cek) return new Response('no key: open the page with #k=<piece key> first', { status: 403 })
  const { r, source, labels } = await openReader()
  if (path === '.list') {
    const files = [...r.files.entries()].map(([p, f]) => ({ path: p, size: f.size }))
    return Response.json({ files, dirs: r.lay.dirs, labels, metadataBytes: r.metadataBytes, prepMs: Math.round(r.prepMs), stats: source.stats })
  }
  if (path === '.stats') return Response.json(source.stats)
  const size = r.size(path)
  if (size == null) return new Response(`no such file in the upload: ${path}`, { status: 404 })
  const range = req.headers.get('range')
  let start = 0, end = size - 1
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    if (m) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1) }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  const len = end - start + 1
  const ext = path.split('.').pop().toLowerCase()
  const body = size === 0 ? new ReadableStream({ start(c) { c.close() } }) : r.read(path, start, len)
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(len),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    },
  })
}

