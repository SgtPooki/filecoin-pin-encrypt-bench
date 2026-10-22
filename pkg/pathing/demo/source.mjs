// A FEE RandomAccessSource over HTTP Range that survives gateways which answer a Range with the whole object
// (inbrowser.link does this once it holds the full file). No HEAD: the size comes from the first Range reply.
// `onEvent(text)` reports progress to the page.
export async function openSource(url, onEvent = () => {}) {
  const stats = { requests: 0, bytes: 0 }
  let whole = null
  const get = async (offset, length) => {
    stats.requests++
    const res = await fetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` }, cache: 'no-store' })
    if (res.status === 206) return res
    if (res.status === 200) {
      // the gateway returned everything; keep it and serve every later range from memory
      onEvent('gateway returned the whole envelope for a Range request, serving ranges from memory from now on')
      whole = new Uint8Array(await res.arrayBuffer())
      stats.bytes += whole.length
      return null
    }
    throw new Error(`Range request failed: ${res.status}`)
  }
  onEvent('asking the gateway for the envelope header')
  const first = await get(0, 4096)
  let size
  let head
  if (first) {
    size = Number(/\/(\d+)$/.exec(first.headers.get('content-range'))?.[1])
    head = new Uint8Array(await first.arrayBuffer())
    stats.bytes += head.length
  } else {
    size = whole.length
    head = whole.subarray(0, 4096)
  }
  onEvent(`envelope is ${size} bytes`)
  return {
    size,
    stats,
    async openRange(offset, length) {
      const end = Math.min(offset + length, size)
      if (whole) return new Blob([whole.subarray(offset, end)]).stream()
      if (offset === 0 && end <= head.length) return new Blob([head.subarray(0, end)]).stream()
      const res = await get(offset, end - offset)
      if (!res) return new Blob([whole.subarray(offset, end)]).stream()
      return res.body.pipeThrough(new TransformStream({ transform(chunk, c) { stats.bytes += chunk.length; c.enqueue(chunk) } }))
    },
  }
}
