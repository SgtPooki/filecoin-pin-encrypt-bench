// Bulk decrypt in the page: fetch the envelope from the gateway, pipe through fee.decrypt, count bytes.
import * as fee from 'filecoin-encryption-envelope'
import { keyFromInfo } from '../lib/kdf-web.mjs'
import { varintDecode } from '../lib/car-layout.mjs'
window.benchDecrypt = async (url, { parseCar = false } = {}) => {
  const heap = []; const tick = setInterval(() => heap.push(performance.memory?.usedJSHeapSize ?? 0), 250)
  const t0 = performance.now()
  const res = await fetch(url)
  let n = 0, pieces = 0, blocks = 0, carry = new Uint8Array(0), headerDone = false
  const plain = res.body.pipeThrough(fee.decrypt((i) => keyFromInfo(i, 'bench-password')))
  const reader = plain.getReader()
  for (;;) {
    const { value, done } = await reader.read(); if (done) break
    n += value.length; pieces++
    if (parseCar) { // incremental section counter: header once, then varint-length sections; carry only an incomplete tail
      let buf = carry.length ? (() => { const b = new Uint8Array(carry.length + value.length); b.set(carry); b.set(value, carry.length); return b })() : value
      let pos = 0
      for (;;) {
        const d = varintDecode(buf, pos); if (!d) break
        const [len, vl] = d
        if (pos + vl + len > buf.length) break
        if (!headerDone) headerDone = true; else blocks++
        pos += vl + len
      }
      carry = buf.subarray(pos)
    }
  }
  clearInterval(tick)
  const ms = performance.now() - t0
  return { bytes: n, pieces, blocks, ms: Math.round(ms), gbps: +(n / 1e9 / (ms / 1000)).toFixed(2), heapPeakMB: Math.round(Math.max(0, ...heap) / 1e6) }
}
