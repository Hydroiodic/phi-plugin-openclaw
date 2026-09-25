import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import SaveManager from '../lib/SaveManager.js'

async function serve(t, handler) {
  const server = createServer(handler)
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections()
        server.close(error => (error ? reject(error) : resolve()))
      }),
  )
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

for (const isGlobal of [false, true]) {
  test(`${isGlobal ? 'international' : 'CN'} save list uses the canonical endpoint without a redirect`, async t => {
    const requests = []
    const origin = await serve(t, (request, response) => {
      const url = new URL(request.url, 'http://localhost')
      requests.push({ url, session: request.headers['x-lc-session'] })
      if (url.pathname === '/1.1/gamesaves/') {
        response.writeHead(301, { Location: `/1.1/gamesaves${url.search}` })
        response.end()
      } else if (url.pathname === '/1.1/gamesaves') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ results: [{ objectId: 'synthetic-save' }] }))
      } else {
        response.writeHead(404)
        response.end()
      }
    })
    const manager = new SaveManager(isGlobal)
    manager.save = manager.save.replace(new URL(manager.baseUrl).origin, origin)
    assert.deepEqual(await manager.saveArray('synthetic-session', 'synthetic-user'), [{ objectId: 'synthetic-save' }])
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url.pathname, '/1.1/gamesaves')
    assert.equal(requests[0].session, 'synthetic-session')
    assert.equal(requests[0].url.searchParams.get('include'), 'cover,gameFile')
    assert.equal(JSON.parse(requests[0].url.searchParams.get('where')).user.objectId, 'synthetic-user')
  })
}

test('cloud requests still reject redirects without forwarding session credentials', async t => {
  let redirectedRequests = 0
  const destination = await serve(t, (_request, response) => {
    redirectedRequests++
    response.end('{}')
  })
  const source = await serve(t, (_request, response) => {
    response.writeHead(301, { Location: `${destination}/unexpected` })
    response.end()
  })
  const manager = new SaveManager(false)
  await assert.rejects(manager.requestJson(`${source}/redirect`, 'synthetic-secret'), error => {
    assert.match(error.message, /HTTP 301/)
    assert.doesNotMatch(error.message, /synthetic-secret/)
    return true
  })
  assert.equal(redirectedRequests, 0)
})
