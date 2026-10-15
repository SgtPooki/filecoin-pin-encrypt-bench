// node bin/report-table.mjs  -> markdown tables from results/*.json
import { readdirSync, readFileSync } from 'node:fs'
const dir = new URL('../results/', import.meta.url).pathname
const rows = readdirSync(dir).filter((f) => /^(video673|video4g5|rand1g|rand5g|dedup512m|bundle)-(raw|car|tar)\.json$/.test(f)).map((f) => JSON.parse(readFileSync(dir + f, 'utf8')))
const order = { video673: 1, video4g5: 2, rand1g: 3, rand5g: 4, dedup512m: 5, bundle: 6 }
rows.sort((a, b) => order[a.input] - order[b.input] || a.fmt.localeCompare(b.fmt))
const MB = (b) => (b / 1e6).toFixed(b < 1e7 ? 1 : 0)
const GBs = (bytes, ms) => (bytes / 1e9 / (ms / 1000)).toFixed(2)
const inputBytes = { video673: 673223862, video4g5: 4541818176, rand1g: 1073741824, rand5g: 5368709120, dedup512m: 536870912, bundle: 881713112 }
console.log('### Encrypt side (two-pass CAR builds, no plaintext temp file for any format)\n')
console.log('| input | fmt | input MB | envelope MB | overhead | plan/pass1 ms | encrypt ms | total ms | GB/s | peak RSS MB |')
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const r of rows) {
  const e = r.encrypt, ib = inputBytes[r.input]
  console.log(`| ${r.input} | ${r.fmt} | ${MB(ib)} | ${MB(e.envelopeBytes)} | ${((e.envelopeBytes / ib - 1) * 100).toFixed(2)}% | ${e.planMs} | ${e.encryptMs} | ${e.totalMs} | ${GBs(ib, e.totalMs)} | ${(e.timeMaxRss / 1e6).toFixed(0)} |`)
}
console.log('\n### Streaming decrypt from the local gateway (single pass, CLI style)\n')
console.log('| input | fmt | decrypt ms | GB/s | first plaintext ms | list ms | peak RSS MB | bytes match |')
console.log('|---|---|---:|---:|---:|---:|---:|---|')
for (const r of rows) {
  const d = r.decrypt, ib = inputBytes[r.input]
  console.log(`| ${r.input} | ${r.fmt} | ${d.totalMs} | ${GBs(ib, d.totalMs)} | ${d.firstPlainMs} | ${d.listMs != null ? Math.round(d.listMs) : ''} | ${(d.timeMaxRss / 1e6).toFixed(0)} | ${r.verify.ok ? 'yes' : 'NO'} |`)
}
console.log('\n### Random reads: 20 offsets x 64 KiB via HTTP Range + decryptRange (per-leaf reader for CAR)\n')
console.log('| input | fmt | prep requests | prep KB | TTFB median ms | TTFB max ms | avg KB fetched/seek | all correct |')
console.log('|---|---|---:|---:|---:|---:|---:|---|')
for (const r of rows) {
  const s = r.seek
  console.log(`| ${r.input} | ${r.fmt} | ${s.prepRequests} | ${(s.prepBytes / 1e3).toFixed(0)} | ${s.ttfbMedianMs} | ${s.ttfbMaxMs} | ${(s.bytesPerSeekAvg / 1e3).toFixed(0)} | ${s.allOk ? 'yes' : 'NO'} |`)
}
