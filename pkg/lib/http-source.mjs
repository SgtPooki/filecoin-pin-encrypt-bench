// RandomAccessSource (FEE) over HTTP Range against an IPFS gateway path, with counters.
// `bytes` counts ciphertext bytes actually read from the network, so an open-ended
// range that the reader cancels early is charged only for what was consumed.
export function httpSource(url, size, { cache = globalThis.process?.env?.BENCH_CACHE === '1' } = {}) {
  const stats = { requests: 0, bytes: 0, firstByteMs: [], cacheHits: 0 }
  // ponytail: optional exact-span cache (64 entries) to model a viewer that keeps recently decrypted chunks
  const cached = new Map()
  return {
    size,
    stats,
    async openRange(offset, length) {
      const key = `${offset}-${length}`
      if (cache && cached.has(key)) { stats.cacheHits++; return new Blob([cached.get(key)]).stream() }
      if (cache && length <= 1 << 20) {
        const res = await fetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` } })
        if (res.status !== 206) throw new Error(`expected 206, got ${res.status}`)
        const buf = new Uint8Array(await res.arrayBuffer())
        stats.requests++; stats.bytes += buf.length
        if (cached.size >= 64) cached.delete(cached.keys().next().value)
        cached.set(key, buf)
        return new Blob([buf]).stream()
      }
      const t0 = performance.now()
      stats.requests++
      const res = await fetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` } })
      if (res.status !== 206) throw new Error(`expected 206, got ${res.status}`)
      let first = true
      return res.body.pipeThrough(new TransformStream({
        transform(chunk, c) { if (first) { first = false; stats.firstByteMs.push(performance.now() - t0) } stats.bytes += chunk.length; c.enqueue(chunk) },
      }))
    },
  }
}

export async function headSize(url) {
  const res = await fetch(url, { method: 'HEAD' })
  if (!res.ok) throw new Error(`HEAD ${url} -> ${res.status}`)
  return Number(res.headers.get('content-length'))
}

/** Full-object streaming fetch (no Range), for CLI-style decrypt. */
export async function streamUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.body
}

/** Read exactly `n` bytes from a stream then cancel it. */
export async function readPrefix(stream, n) {
  const reader = stream.getReader()
  const parts = []; let got = 0
  while (got < n) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value); got += value.length
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(got, n)); let o = 0
  for (const p of parts) { const take = Math.min(p.length, out.length - o); out.set(p.subarray(0, take), o); o += take; if (o >= out.length) break }
  return out
}
