import { createWriter } from 'protons-runtime'
for (const v of [2n ** 31n - 1n, 2n ** 31n, 3891799298n, 2n ** 32n]) {
  const w = createWriter(); w.uint64(v)
  console.log(String(v), Buffer.from(w.finish()).toString('hex'))
}
