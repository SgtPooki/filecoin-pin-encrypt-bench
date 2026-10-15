// node bin/seek.mjs <raw|car|tar> <url> <pathInPayload|-> <localOriginalFile> <readLen> <offset,offset,...>
// Random reads over HTTP Range + fee.decryptRange. Verifies each read against the local original.
import { open } from 'node:fs/promises'
import * as fee from 'filecoin-encryption-envelope'
import { openCarReader } from '../lib/car-seek.mjs'
import { walkTarHeaders } from '../lib/tar-payload.mjs'
import { httpSource, headSize, readPrefix } from '../lib/http-source.mjs'
import { keyFromInfo } from '../lib/kdf.mjs'

const [fmt, url, path, original, readLenS, offsetsS] = process.argv.slice(2)
const readLen = Number(readLenS)
const offsets = offsetsS.split(',').map(Number)
const size = await headSize(url)
const source = httpSource(url, size)
const t0 = performance.now()
const info = await fee.parse(source)
const cek = await keyFromInfo(info)
const afterParse = { ...source.stats, firstByteMs: undefined }
const tParse = performance.now()

let readRange, prep = {}
if (fmt === 'raw') {
  readRange = async (off, len) => (await fee.decryptRange(source, cek, { offset: off, length: len })).stream
} else if (fmt === 'car') {
  const r = await openCarReader(source, cek)
  prep = { prepMs: Math.round(r.prepMs), metadataBytes: r.metadataBytes, files: r.files.size }
  readRange = (off, len) => r.read(path, off, len)
} else if (fmt === 'tar') {
  const total = (await fee.decryptRange(source, cek, { offset: 0, length: 1 })).totalPlaintextLength
  let headerReads = 0
  const read = async (off, len) => { headerReads++; return readPrefix((await fee.decryptRange(source, cek, { offset: off, length: len })).stream, len) }
  const tp = performance.now()
  const entries = await walkTarHeaders(read, total, { stopAtName: path })
  const e = entries.at(-1)
  if (!e || e.name !== path) throw new Error(`tar entry ${path} not found (walked ${entries.length})`)
  prep = { prepMs: Math.round(performance.now() - tp), headerReads, entriesWalked: entries.length }
  readRange = async (off, len) => (await fee.decryptRange(source, cek, { offset: e.dataOffset + off, length: Math.min(len, e.size - off) })).stream
}
const prepStats = { requests: source.stats.requests - afterParse.requests, bytes: source.stats.bytes - afterParse.bytes }
const fh = await open(original, 'r')
const seeks = []
for (const off of offsets) {
  const before = { ...source.stats, firstByteMs: undefined }
  const t = performance.now()
  const stream = await readRange(off, readLen)
  const reader = stream.getReader()
  let ttfb, got = []
  for (;;) { const { value, done } = await reader.read(); if (done) break; ttfb ??= performance.now() - t; got.push(value) }
  const ms = performance.now() - t
  const data = Buffer.concat(got)
  const expect = Buffer.alloc(data.length)
  await fh.read(expect, 0, data.length, off)
  seeks.push({ offset: off, len: data.length, ttfbMs: Math.round(ttfb ?? ms), ms: Math.round(ms), requests: source.stats.requests - before.requests, bytesFetched: source.stats.bytes - before.bytes, ok: data.equals(expect) })
}
await fh.close()
const ttfbs = seeks.map((s) => s.ttfbMs).sort((a, b) => a - b)
console.log(JSON.stringify({ fmt, url, path, parseMs: Math.round(tParse - t0), parseBytes: afterParse.bytes, ...prep, prepRequests: prepStats.requests, prepBytes: prepStats.bytes, seeks, allOk: seeks.every((s) => s.ok), ttfbMedianMs: ttfbs[Math.floor(ttfbs.length / 2)], ttfbMaxMs: ttfbs.at(-1), bytesPerSeekAvg: Math.round(seeks.reduce((a, s) => a + s.bytesFetched, 0) / seeks.length), maxRssBytes: process.resourceUsage().maxRSS }))
