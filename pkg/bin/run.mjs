// node bin/run.mjs <inputName>[,<inputName>...] [fmt,fmt]   -> results/<input>-<fmt>.json
// Per (input, fmt): encrypt -> publish (outer CAR via PR dist + Kubo import) -> streaming decrypt + verify -> 20 seeks.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const B = process.env.BENCH_DIR ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PKG = `${B}/pkg`
const INPUTS = {
  video673: { path: `${B}/media/bbb_sunflower_2160p_60fps_normal.mp4` },
  video4g: { path: `${B}/inputs/bbb_4g.mp4` },
  video4g5: { path: `${B}/inputs/bbb_4g5.mp4` },
  rand1g: { path: `${B}/inputs/rand_1g.bin` },
  rand5g: { path: `${B}/inputs/rand_5g.bin` },
  dedup512m: { path: `${B}/inputs/dedup_512m.bin` },
  manyfiles: { path: `${B}/inputs/manyfiles`, dir: true, seekFile: 'manyfiles/f6000.bin', seekLocal: `${B}/inputs/manyfiles/f6000.bin`, extraSeek: { file: 'manyfiles/f1.bin', local: `${B}/inputs/manyfiles/f1.bin` } },
  bundle: { path: `${B}/inputs/bundle`, dir: true, seekFile: 'bundle/assets/video.mp4', seekLocal: `${B}/inputs/bundle/assets/video.mp4`, extraSeek: { file: 'bundle/docs/small_99.txt', local: `${B}/inputs/bundle/docs/small_99.txt` } },
}
const [inputsArg, fmtsArg] = process.argv.slice(2)
const inputs = inputsArg.split(',')
const fmts = (fmtsArg ?? 'raw,car,tar').split(',')

const sha = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej) })
async function node(args, opts = {}) {
  const t0 = performance.now()
  const { stdout, stderr } = await exec('/usr/bin/time', ['-l', process.execPath, ...args], { cwd: PKG, maxBuffer: 1 << 26, ...opts })
  const rss = Number(/(\d+)\s+maximum resident set size/.exec(stderr)?.[1])
  const lines = stdout.trim().split('\n')
  return { ...JSON.parse(lines.at(-1)), wallMs: Math.round(performance.now() - t0), timeMaxRss: rss }
}
function offsetsFor(size, n = 20) {
  const out = new Set([0, Math.max(0, size - 65536), Math.max(0, size - 1), Math.floor(size / 2)])
  let x = 12345
  while (out.size < n) { x = (x * 1103515245 + 12345) % 2 ** 31; out.add(Math.floor((x / 2 ** 31) * Math.max(1, size - 65536))) }
  return [...out].sort((a, b) => a - b)
}
await mkdir(`${PKG}/results`, { recursive: true })
await mkdir(`${B}/work`, { recursive: true, mode: 0o700 })
for (const name of inputs) {
  const inp = INPUTS[name]
  const inputSha = inp.dir ? undefined : await sha(inp.path)
  const inputSize = inp.dir ? undefined : (await stat(inp.path)).size
  for (const fmt of fmts) {
    if (inp.dir && fmt === 'raw') continue
    const r = { input: name, fmt, inputBytes: inputSize, startedAt: new Date().toISOString() }
    const work = await mkdtemp(`${B}/work/${name}-${fmt}-`)
    try {
      const env = join(work, 'encrypted.fee')
      r.encrypt = await node(['bin/encrypt.mjs', fmt, inp.path, env])
      r.publish = await node(['bin/publish.mjs', env])
      r.peakTempDiskBytes = r.publish.envelopeBytes + r.publish.outerCarBytes
      await rm(env)
      const url = r.publish.url
      const out = join(work, 'dec')
      r.decrypt = await node(['bin/decrypt.mjs', fmt, url, out])
      if (inp.dir) {
        const d = await exec('diff', ['-r', '--no-dereference', '-q', inp.path, join(out, basename(inp.path))]).catch((e) => e)
        const lines = (d.stdout ?? '').trim().split('\n').filter(Boolean)
        r.verify = { ok: lines.every((l) => /Only in .*: (evil_abs_link|evil_rel_link|link_to_large\.bin)$/.test(l)), diffLines: lines.slice(0, 5) }
      } else {
        const outFile = fmt === 'raw' ? join(out, 'payload.bin') : join(out, basename(inp.path))
        const got = await sha(outFile)
        r.verify = { ok: got === inputSha, sha256: got }
      }
      await rm(out, { recursive: true, force: true })
      const seekLocal = inp.seekLocal ?? inp.path
      const seekPath = fmt === 'raw' ? '-' : (inp.seekFile ?? basename(inp.path))
      const size = (await stat(seekLocal)).size
      r.seek = await node(['bin/seek.mjs', fmt, url, seekPath, seekLocal, '65536', offsetsFor(size).join(',')])
      if (inp.extraSeek && fmt !== 'raw') r.seekSmall = await node(['bin/seek.mjs', fmt, url, inp.extraSeek.file, inp.extraSeek.local, '65536', '0'])
      r.ok = r.verify.ok && r.seek.allOk && (r.seekSmall?.allOk ?? true)
    } catch (e) {
      r.error = String(e.stderr ?? e.message ?? e).slice(-2000)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
    await writeFile(`${PKG}/results/${name}-${fmt}.json`, JSON.stringify(r, null, 1))
    console.log(`${name} ${fmt}: ${r.error ? 'ERROR ' + r.error.split('\n').at(-1) : `ok=${r.ok} enc=${r.encrypt.totalMs}ms env=${r.publish.envelopeBytes} dec=${r.decrypt.totalMs}ms rss=${r.decrypt.timeMaxRss} seekTTFBmed=${r.seek.ttfbMedianMs}ms bytes/seek=${r.seek.bytesPerSeekAvg}`}`)
  }
}
