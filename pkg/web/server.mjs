// Tiny static server for the bench page + bundled service worker (127.0.0.1 only).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
export function startServer(port = 9000) {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const file = u.pathname === '/' ? 'index.html' : u.pathname === '/sw.js' ? 'dist/sw.js' : u.pathname === '/page.js' ? 'dist/page.js' : null
    if (!file) { res.writeHead(404); return res.end() }
    const body = await readFile(join(here, file))
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' })
    res.end(body)
  })
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)))
}
