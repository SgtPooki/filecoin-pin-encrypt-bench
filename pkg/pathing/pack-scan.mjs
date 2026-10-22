// Concatenate several FEE envelopes into one opaque pack and see what a key-less scanner recovers.
import { randomBytes } from 'node:crypto'
import * as fee from 'filecoin-encryption-envelope'
const enc = async (bytes, label) => {
  const cek = crypto.getRandomValues(new Uint8Array(32))
  const out = new Blob([bytes]).stream().pipeThrough(fee.encrypt({ cek, contentLength: bytes.length, appMetadata: { 'foc/v': 1, 'foc/salt': label } }))
  return new Uint8Array(await new Response(out).arrayBuffer())
}
const sizes = [1_000, 300_000, 7_777, 2_000_000]
const parts = []
for (const [i, n] of sizes.entries()) parts.push(await enc(new Uint8Array(randomBytes(n)), `0x${String(i).padStart(32, '0')}`))
const pack = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
let at = 0
for (const p of parts) { pack.set(p, at); at += p.length }
// scanner: look for the COSE typ string every envelope must carry (FRC-0120 "Header Validation")
const needle = new TextEncoder().encode('application/vnd.filecoin-encryption+cose')
const hits = []
for (let i = 0; i + needle.length <= pack.length; i++) {
  let ok = true
  for (let j = 0; j < needle.length; j++) if (pack[i + j] !== needle[j]) { ok = false; break }
  if (ok) hits.push(i)
}
console.log('pack bytes', pack.length, 'envelopes', parts.length)
console.log('typ string found at offsets', hits)
// each hit sits inside a header; parse the envelope that starts a little before it to recover its exact length
const starts = []
for (const h of hits) {
  for (let s = Math.max(0, h - 64); s <= h; s++) {
    try {
      const info = await fee.parse({ size: pack.length - s, openRange: async (o, l) => new Blob([pack.subarray(s + o, s + o + l)]).stream() })
      starts.push({ start: s, headerLength: info.headerLength ?? info.envelopeLength, plaintextLength: info.plaintextLength, labels: { ...info.appMetadata } })
      break
    } catch {}
  }
}
console.log(JSON.stringify(starts, null, 1))
console.log('true boundaries', parts.reduce((acc, p) => { acc.push((acc.at(-1) ?? 0) + p.length); return acc }, []).slice(0, -1), 'true plaintext sizes', sizes)
