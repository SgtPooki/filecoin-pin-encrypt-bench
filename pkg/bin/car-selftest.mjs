// Build the metadata-first CAR for a path, write it to stdout-named file, print stats.
import { createWriteStream } from 'node:fs'
import { Writable } from 'node:stream'
import { buildCarPayload } from '../lib/car-payload.mjs'
const [input, out] = process.argv.slice(2)
const t0 = performance.now()
const { plan, lay, contentLength, stream } = await buildCarPayload(input)
const t1 = performance.now()
await stream().pipeTo(Writable.toWeb(createWriteStream(out)))
const t2 = performance.now()
console.log(JSON.stringify({ root: lay.root.toString(), contentLength, metadataBlocks: lay.metadata.length, metadataBytes: lay.leaves[0]?.offset ?? lay.total, leaves: lay.leaves.length, files: lay.files.size, dirs: lay.dirs.length, skippedSymlinks: plan.skippedSymlinks, pass1ms: Math.round(t1 - t0), pass2ms: Math.round(t2 - t1), rss: process.resourceUsage().maxRSS }))
