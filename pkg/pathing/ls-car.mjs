import { readFile } from 'node:fs/promises'
import { CarBlockIterator } from '@ipld/car'
for (const f of process.argv.slice(2)) {
  const it = await CarBlockIterator.fromBytes(await readFile(f))
  console.log(f.split('/').pop(), 'roots', (await it.getRoots()).map(String))
  for await (const b of it) console.log('  ', b.cid.toString(), b.cid.code === 0x70 ? 'dag-pb' : 'raw', b.bytes.length)
}
