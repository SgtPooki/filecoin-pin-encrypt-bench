// Service Worker: answers <video> Range requests for /media/<fmt>/<root>/<path> by decrypting
// the FEE envelope at the local gateway with fee.decryptRange. Bundled by bin/browser.mjs.
import * as fee from 'filecoin-encryption-envelope'
import { openCarReader } from '../lib/car-seek.mjs'
import { walkTarHeaders } from '../lib/tar-headers.mjs'
import { httpSource, headSize, readPrefix } from '../lib/http-source.mjs'
import { keyFromInfo } from '../lib/kdf-web.mjs'

const GATEWAY = 'http://127.0.0.1:8080/ipfs/'
const PASSWORD = 'bench-password'
const readers = new Map()

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  const u = new URL(event.request.url)
  if (u.pathname.startsWith('/media/')) event.respondWith(handle(event.request, u).catch((e) => new Response(String(e?.stack ?? e), { status: 500 })))
  else if (u.pathname === '/media-stats') event.respondWith(stats())
})

async function open(fmt, root, path) {
  const t0 = performance.now()
  const url = GATEWAY + root
  const size = await headSize(url)
  const source = httpSource(url, size)
  const info = await fee.parse(source)
  const cek = await keyFromInfo(info, PASSWORD)
  const base = { source, prep: {} }
  if (fmt === 'raw') {
    const { totalPlaintextLength } = await fee.decryptRange(source, cek, { offset: 0, length: 1 })
    return { ...base, size: totalPlaintextLength, read: async (o, l) => (await fee.decryptRange(source, cek, { offset: o, length: l })).stream, prep: { prepMs: performance.now() - t0, requests: source.stats.requests, bytes: source.stats.bytes } }
  }
  if (fmt === 'tar') {
    const { totalPlaintextLength } = await fee.decryptRange(source, cek, { offset: 0, length: 1 })
    const read = async (off, len) => readPrefix((await fee.decryptRange(source, cek, { offset: off, length: len })).stream, len)
    const entries = await walkTarHeaders(read, totalPlaintextLength, { stopAtName: path })
    const e = entries.at(-1)
    if (!e || e.name !== path) throw new Error(`tar entry ${path} not found`)
    return { ...base, size: e.size, read: async (o, l) => (await fee.decryptRange(source, cek, { offset: e.dataOffset + o, length: Math.min(l, e.size - o) })).stream, prep: { prepMs: performance.now() - t0, requests: source.stats.requests, bytes: source.stats.bytes, entriesWalked: entries.length } }
  }
  if (fmt === 'car') {
    const r = await openCarReader(source, cek)
    const size = r.size(path)
    if (size == null) throw new Error(`no ${path} in CAR`)
    return { ...base, size, read: (o, l) => r.read(path, o, l), prep: { prepMs: performance.now() - t0, requests: source.stats.requests, bytes: source.stats.bytes, metadataBytes: r.metadataBytes } }
  }
  throw new Error(`unknown fmt ${fmt}`)
}

async function handle(req, u) {
  const [, , fmt, root, ...rest] = u.pathname.split('/')
  const path = decodeURIComponent(rest.join('/'))
  const key = `${fmt}|${root}|${path}`
  let p = readers.get(key)
  if (!p) { p = open(fmt, root, path); readers.set(key, p); p.catch(() => readers.delete(key)) }
  const r = await p
  const range = req.headers.get('range')
  let start = 0, end = r.size - 1
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), r.size - 1)
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${r.size}` } })
  }
  const len = end - start + 1
  r.rangeLog ??= []
  r.rangeLog.push({ start, end, t: performance.now() })
  const body = await r.read(start, len)
  return new Response(body, {
    status: range ? 206 : 200,
    headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(len), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${r.size}` } : {}) },
  })
}

async function stats() {
  const out = {}
  for (const [k, p] of readers) { try { const r = await p; out[k] = { size: r.size, prep: r.prep, requests: r.source.stats.requests, bytes: r.source.stats.bytes, ranges: r.rangeLog?.length ?? 0, firstByteMsMedian: median(r.source.stats.firstByteMs) } } catch (e) { out[k] = { error: String(e) } } }
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null }
