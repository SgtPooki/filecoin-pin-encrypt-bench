// Probe @helia/verified-fetch (trustless gateway client) against a local gateway serving the outer CAR.
import { createVerifiedFetch } from '@helia/verified-fetch'
const [gateway, root] = process.argv.slice(2)
const vf = await createVerifiedFetch({ gateways: [gateway], routers: [], allowLocal: true, allowInsecure: true })
for (const [label, url, init] of [
  ['path into file', `ipfs://${root}/foo`, {}],
  ['range on file', `ipfs://${root}`, { headers: { Range: 'bytes=0-1023' } }],
  ['path into file, car', `ipfs://${root}/foo?format=car`, {}],
]) {
  try {
    const res = await vf(url, { ...init, signal: AbortSignal.timeout(10000) })
    const body = await res.arrayBuffer()
    console.log(label, '->', res.status, res.headers.get('content-type'), body.byteLength, 'bytes', res.status >= 400 ? JSON.stringify(new TextDecoder().decode(body).slice(0, 200)) : '')
  } catch (e) { console.log(label, '-> threw', e.name, e.message.slice(0, 200)) }
}
await vf.stop()
