import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function serveRepository(root) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    requests.push(req.url)
    const target = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname)
    if (!target.startsWith(path.resolve(root) + path.sep)) {
      res.writeHead(403).end()
      return
    }
    try {
      const bytes = await fs.readFile(target)
      res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    close: () =>
      new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      }),
  }
}
