// node bin/publish.mjs <envelope.fee>  -> pack as filecoin-pin would (createCarFromPath from the PR worktree dist),
// import the outer CAR into the local Kubo, print { root, url, outerCarBytes }.
import { execFile } from 'node:child_process'
import { stat, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const W = process.env.PIN_WORKTREE ?? (() => { throw new Error('set PIN_WORKTREE to a built filecoin-pin checkout (dist/)') })()
const IPFS = process.env.IPFS_SH ?? 'ipfs'
const [envelope] = process.argv.slice(2)
const { createCarFromPath } = await import(`${W}/dist/core/unixfs/index.js`)
const t0 = performance.now()
const { carPath, rootCid } = await createCarFromPath(envelope, {})
const t1 = performance.now()
const outerCarBytes = (await stat(carPath)).size
await exec(IPFS, ['dag', 'import', '--pin-roots=false', carPath], { maxBuffer: 1 << 24 })
const t2 = performance.now()
await rm(carPath)
console.log(JSON.stringify({ root: rootCid.toString(), url: `http://127.0.0.1:8080/ipfs/${rootCid}`, envelopeBytes: (await stat(envelope)).size, outerCarBytes, packMs: Math.round(t1 - t0), importMs: Math.round(t2 - t1) }))
