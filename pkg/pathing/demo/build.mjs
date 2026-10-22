// node pathing/demo/build.mjs            full build: new fixture, new envelope, new key
// KEEP=1 node pathing/demo/build.mjs     page only: keeps .src, dist/encrypted.fee and the key
// Output: pathing/demo/dist/{index.html,page.js,encrypted.fee}. Prints the piece key; it is never written next to the upload.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import * as dagPb from '@ipld/dag-pb'
import { keyspaceKeys, writeTarget } from '/Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/node_modules/@filoz/keysmith/dist/src/index.js'
import { privateKeyToAccount } from '/Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/node_modules/viem/_esm/accounts/index.js'
import { encryptPath } from '/Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/dist/common/encryption.js'
import { newPieceKey } from '/Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/dist/common/keyspace.js'
import { createCarFromPath } from '/Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/dist/core/unixfs/index.js'
import { openCarReader } from '../../lib/car-seek.mjs'

const HERE = new URL('.', import.meta.url).pathname
const SRC = `${HERE}.src/folder`
const DIST = `${HERE}dist`
const keep = process.env.KEEP === '1'

async function bundlePage() {
  await mkdir(DIST, { recursive: true })
  await build({ entryPoints: [`${HERE}page-src.mjs`], bundle: true, format: 'esm', platform: 'browser', outfile: `${DIST}/page.js`, logLevel: 'error' })
  await copyFile(`${HERE}index.html`, `${DIST}/index.html`)
  await rm(`${DIST}/sw.js`, { force: true })
}

if (keep) {
  await bundlePage()
  console.log(JSON.stringify({ dist: DIST, kept: 'encrypted.fee and key unchanged' }))
  process.exit(0)
}

await rm(SRC, { recursive: true, force: true })
await rm(DIST, { recursive: true, force: true })
for (const d of ['docs', 'media', 'data', 'many']) await mkdir(`${SRC}/${d}`, { recursive: true })
await writeFile(`${SRC}/README.md`, `# A private folder\n\n5,000 small files under many/, a 24 MiB binary, a 12 s clip, and this file.\nPacked as a UnixFS CAR, encrypted with a Keysmith piece key, uploaded as one file.\n`)
await writeFile(`${SRC}/docs/notes.txt`, 'notes.txt: a nested path, resolved against the UnixFS directory inside the ciphertext.\n')
await writeFile(`${SRC}/data/big.bin`, randomBytes(24 * 1024 * 1024))
for (let i = 1; i <= 5000; i++) await writeFile(`${SRC}/many/f${String(i).padStart(4, '0')}.txt`, `file ${i} of 5000: lives in a HAMT-sharded directory inside the ciphertext\n`)
// 12 s synthetic clip, faststart so the moov box sits in the first chunks
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${SRC}/media/clip.mp4`])

const OWNER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const { kk, descriptor } = await keyspaceKeys(OWNER, { owner: OWNER.address, keyspace: '0x00112233445566778899aabbccddeeff' })
const key = newPieceKey(writeTarget(descriptor, kk))
await mkdir(DIST, { recursive: true })
const { plan } = await encryptPath(SRC, `${DIST}/encrypted.fee`, key)

// The folder's own CID, as a plain `filecoin-pin add` of the directory would compute it.
const plain = await createCarFromPath(SRC, { isDirectory: true })
await rm(plain.carPath, { force: true })

// Decrypt in memory and read the inner wrapper's single link: it must be that same CID.
const envelope = await readFile(`${DIST}/encrypted.fee`)
const source = { size: envelope.length, openRange: async (o, l) => new Blob([envelope.subarray(o, o + l)]).stream() }
const r = await openCarReader(source, key.cek)
const wrapper = dagPb.decode(r.nodes.get(r.root.toString()).bytes)
const innerFolderCid = wrapper.Links[0].Hash.toString()

await bundlePage()
const hex = Array.from(key.cek).map((b) => b.toString(16).padStart(2, '0')).join('')
console.log(JSON.stringify({
  dist: DIST,
  files: plan.layout.files.size,
  dirs: plan.layout.dirs.length,
  innerBytes: plan.contentLength,
  envelopeBytes: envelope.length,
  metadataBytes: r.metadataBytes,
  labels: key.appMetadata,
  innerFolderCid,
  plainAddCid: plain.rootCid.toString(),
  sameAsPlainAdd: innerFolderCid === plain.rootCid.toString(),
  pieceKeyHex: hex,
}, null, 1))
