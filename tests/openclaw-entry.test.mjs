import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import plugin from '../openclaw.mjs'
import { buildResources } from '../scripts/build-resources.mjs'
import { serveRepository } from './resource-server.mjs'

test('entry resolves configured paths during registration, fetches remote metadata and retries failed first downloads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-entry-test-'))
  const output = path.join(root, 'public')
  await fs.mkdir(output)
  const server = await serveRepository(output)
  const previous = { base: process.env.PHI_RESOURCE_BASE_URL, version: process.env.PHI_RESOURCE_VERSION }
  process.env.PHI_RESOURCE_BASE_URL = server.url
  process.env.PHI_RESOURCE_VERSION = 'latest'
  const commands = new Map(),
    services = []
  let registering = true,
    calls = 0
  t.after(async () => {
    for (const service of services) await service.stop()
    await server.close()
    for (const [key, value] of [
      ['PHI_RESOURCE_BASE_URL', previous.base],
      ['PHI_RESOURCE_VERSION', previous.version],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  plugin.register({
    pluginConfig: { dataDir: 'custom-data' },
    runtime: { state: { resolveStateDir: () => root } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath: value => {
      assert.equal(registering, true)
      calls++
      return path.join(root, value)
    },
    registerCommand: command => commands.set(command.name, command),
    on() {},
    registerService: service => services.push(service),
  })
  registering = false
  assert.equal(calls, 1)
  assert.equal(commands.size, 14)
  assert.ok(commands.has('gbbind') && commands.has('cnbind'))
  assert.ok([...commands.values()].every(command => command.requireAuth === false))
  const context = { senderId: 'test-user', channel: 'qqbot', accountId: 'default', commandBody: '/b30' }
  const failed = await commands.get('b30').handler(context)
  assert.match(failed.text, /资源未就绪/)
  await buildResources({ output, version: '3.20.0', gameVersion: '3.20.0', gameCode: 154 })
  const success = await commands.get('b30').handler(context)
  assert.match(success.text, /请先绑定/)
  assert.ok(await fs.stat(path.join(root, 'custom-data', 'phi.sqlite')))
  assert.equal(calls, 1)
})

test('CLI metadata loading does not touch unavailable runtime APIs', () => {
  plugin.register({
    registrationMode: 'cli-metadata',
    get runtime() {
      throw new Error('unavailable')
    },
  })
})
