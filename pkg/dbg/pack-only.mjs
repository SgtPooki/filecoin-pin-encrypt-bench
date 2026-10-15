const [W, f] = process.argv.slice(2)
const { createCarFromPath } = await import(`${W}/dist/core/unixfs/index.js`)
const r = await createCarFromPath(f, {})
console.log(JSON.stringify({ carPath: r.carPath, rootCid: r.rootCid.toString() }))
