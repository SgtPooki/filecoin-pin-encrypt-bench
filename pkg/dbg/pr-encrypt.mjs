const [W, input, out] = process.argv.slice(2)
const { encryptFileWithPassword } = await import(`${W}/dist/common/encryption.js`)
const { stat } = await import('node:fs/promises')
const size = (await stat(input)).size
const t0 = performance.now()
await encryptFileWithPassword(input, size, out, 'bench-password')
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), size, maxRssKB: process.resourceUsage().maxRSS }))
