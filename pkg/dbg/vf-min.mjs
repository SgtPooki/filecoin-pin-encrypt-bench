import { createVerifiedFetch } from '@helia/verified-fetch'
const vf = await createVerifiedFetch({ gateways: ['http://127.0.0.1:8080'], routers: [], allowLocal: true, allowInsecure: true })
const t0 = performance.now()
const res = await vf('ipfs://bafybeifr3ghiauykvfafhprylbhiwfqwoshsbp3kfybc2r5j3gsvkmkoyy', { headers: { range: 'bytes=0-1023' } })
console.log('status', res.status, res.headers.get('content-range'), Math.round(performance.now() - t0) + 'ms')
const b = new Uint8Array(await res.arrayBuffer()); console.log('len', b.length, Math.round(performance.now() - t0) + 'ms')
const full = await vf('ipfs://bafybeifr3ghiauykvfafhprylbhiwfqwoshsbp3kfybc2r5j3gsvkmkoyy')
let n = 0; for await (const c of full.body) n += c.length; console.log('full', full.status, n, Math.round(performance.now() - t0) + 'ms')
await vf.stop(); process.exit(0)
