import * as dagPb from '@ipld/dag-pb'
import { readFileSync } from 'node:fs'
const b = readFileSync(process.argv[2])
console.log('len', b.length, 'hex', Buffer.from(b).toString('hex'))
try { const n = dagPb.decode(b); console.log('links', n.Links.length, n.Links.map(l => [l.Hash.toString().slice(0,16), l.Tsize]), 'data', n.Data?.length) } catch (e) { console.log('decode fail:', e.message) }
