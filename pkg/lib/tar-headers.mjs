// Pure (browser-safe) tar header parsing for seeking.
// ---- header parsing for seek ----
const dec = new TextDecoder()
function octal(buf, off, len) {
  if (buf[off] & 0x80) { // base-256
    let n = 0; for (let i = 1; i < len; i++) n = n * 256 + buf[off + i]; return n
  }
  const s = dec.decode(buf.subarray(off, off + len)).replace(/\0.*$/, '').trim()
  return s === '' ? 0 : parseInt(s, 8)
}
function cstr(buf, off, len) { return dec.decode(buf.subarray(off, off + len)).replace(/\0.*$/, '') }
/** Parse a 512-byte header block. Returns null for an end-of-archive zero block. */
export function parseTarHeader(h) {
  if (h.every((b) => b === 0)) return null
  const name = cstr(h, 0, 100), prefix = cstr(h, 345, 155)
  return { name: prefix ? `${prefix}/${name}` : name, size: octal(h, 124, 12), type: String.fromCharCode(h[156] || 48), magic: cstr(h, 257, 6) }
}
export function parsePax(body) {
  const out = {}
  let i = 0
  while (i < body.length) {
    const sp = body.indexOf(0x20, i); const len = parseInt(dec.decode(body.subarray(i, sp)), 10)
    const rec = dec.decode(body.subarray(sp + 1, i + len - 1)); const eq = rec.indexOf('=')
    out[rec.slice(0, eq)] = rec.slice(eq + 1); i += len
  }
  return out
}
/**
 * Walk the archive headers using `read(offset, length) -> Uint8Array` (each call is one decryptRange).
 * Returns [{ name, size, type, dataOffset }]. Stops at `stopAfter` entries or end of archive.
 */
export async function walkTarHeaders(read, total, { stopAtName } = {}) {
  const entries = []
  let off = 0
  let pax = null
  while (off + 512 <= total) {
    const h = parseTarHeader(await read(off, 512))
    if (!h) break
    const dataOffset = off + 512, padded = Math.ceil(h.size / 512) * 512
    if (h.type === 'x') { pax = parsePax(await read(dataOffset, h.size)); off = dataOffset + padded; continue }
    if (pax?.path) h.name = pax.path
    if (pax?.size) h.size = Number(pax.size)
    pax = null
    entries.push({ ...h, dataOffset })
    if (stopAtName != null && h.name === stopAtName) break
    off = dataOffset + Math.ceil(h.size / 512) * 512
  }
  return entries
}
