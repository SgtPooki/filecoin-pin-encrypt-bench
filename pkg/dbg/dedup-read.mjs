import * as fee from 'filecoin-encryption-envelope'
import { openCarReader } from '../lib/car-seek.mjs'
import { httpSource, headSize } from '../lib/http-source.mjs'
import { keyFromInfo } from '../lib/kdf.mjs'
import { open } from 'node:fs/promises'
const [url, local, offS, lenS] = process.argv.slice(2)
const size = await headSize(url); const src = httpSource(url, size)
const cek = await keyFromInfo(await fee.parse(src))
const r = await openCarReader(src, cek)
const f = r.lay.files.get('dedup_512m.bin')
console.log('leaves', f.leaves.length, 'distinct', new Set(f.leaves.map(l => l.leaf)).size, 'first 6', f.leaves.slice(0, 6).map(l => [l.fileOffset, l.leaf.offset]))
try {
  const parts = []; for await (const c of r.read('dedup_512m.bin', Number(offS), Number(lenS))) parts.push(c)
  const got = Buffer.concat(parts); const fh = await open(local); const exp = Buffer.alloc(got.length); await fh.read(exp, 0, got.length, Number(offS))
  console.log('got', got.length, 'match', got.equals(exp), 'requests', src.stats.requests)
} catch (e) { console.log('ERR', e.message) }
