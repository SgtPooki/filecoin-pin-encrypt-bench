// Candidate 3: ustar/PAX tar payload (tar-stream). Rooted at basename(input); symlinks skipped.
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pack as tarPack, extract as tarExtract } from 'tar-stream'
import { walkInput } from './car-payload.mjs'

export const CONTENT_TYPE = 'application/x-tar'

/** Returns { plan, stream(): ReadableStream<Uint8Array> }. Plaintext length is not known up front (PAX records). */
export async function buildTarPayload(inputPath) {
  const plan = await walkInput(inputPath)
  function stream() {
    const pack = tarPack()
    ;(async () => {
      try {
        for (const d of plan.dirs) await new Promise((res, rej) => pack.entry({ name: `${d}/`, type: 'directory', mode: 0o755 }, (e) => (e ? rej(e) : res())))
        for (const f of plan.files) {
          const entry = pack.entry({ name: f.rel, type: 'file', size: f.size, mode: 0o644 })
          await pipeline(createReadStream(f.abs, { highWaterMark: 1 << 20 }), entry)
        }
        pack.finalize()
      } catch (e) { pack.destroy(e) }
    })()
    return ReadableStream.from(pack)
  }
  return { plan, stream }
}

const unsafePath = (name) => {
  if (name.startsWith('/') || name.includes('\0')) return true
  return name.split('/').some((s) => s === '..')
}

/** Streaming extract into outDir (must exist, created 0700 by caller). Returns { files, dirs, skipped }. */
export async function extractTar(webStream, outDir, { onList } = {}) {
  const ex = tarExtract()
  const out = { files: 0, dirs: 0, skipped: [], bytes: 0 }
  const done = new Promise((resolve, reject) => {
    const drain = (stream) => new Promise((r) => { stream.on('end', r); stream.resume() })
    ex.on('entry', (header, stream, next) => {
      ;(async () => {
        if (unsafePath(header.name)) throw new Error(`unsafe path in archive: ${header.name}`)
        const dest = join(outDir, header.name)
        if (header.type === 'directory') { await mkdir(dest, { recursive: true, mode: 0o700 }); out.dirs++; await drain(stream) }
        else if (header.type === 'file') {
          await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
          onList?.(header.name, header.size)
          const fh = await open(dest, 'wx', 0o600)
          await pipeline(stream, fh.createWriteStream())
          out.files++; out.bytes += header.size
        } else { out.skipped.push(`${header.type}:${header.name}`); await drain(stream) }
      })().then(next, (e) => { reject(e); ex.destroy(e) })
    })
    ex.on('finish', () => resolve(out))
    ex.on('error', reject)
  })
  try {
    for await (const chunk of webStream) { if (!ex.write(chunk)) await new Promise((r) => ex.once('drain', r)) }
    ex.end()
  } catch (e) { ex.destroy(e) }
  return done
}

export { parseTarHeader, parsePax, walkTarHeaders } from './tar-headers.mjs'
