import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPlatform, OpenClawPlatform, userIdentity } from '../src/platform.mjs'
import { getPlatformAdapter, setPlatformAdapter, platform } from '../components/platform/index.js'

const context = (adapter, overrides = {}) => adapter.fromContext({ channel: 'qqbot', senderId: 'test', ...overrides }, () => {})

test('full adapter replacement preserves class methods and removes previous runtime state', () => {
  const original = getPlatformAdapter(), first = createPlatform(), second = createPlatform()
  try {
    first.resourceInfoPath = '/first/resources'
    setPlatformAdapter(first)
    assert.equal(getPlatformAdapter(), first)
    assert.ok(getPlatformAdapter() instanceof OpenClawPlatform)
    assert.equal(platform.getAdapterName({ platform: 'qqbot' }), 'QQBot')
    setPlatformAdapter({ getBotNickname: () => 'test override' })
    assert.equal(platform.getBotNickname(), 'test override')
    assert.equal(platform.getPackageVersion(), '0.1.0')
    setPlatformAdapter(second)
    assert.equal(getPlatformAdapter(), second)
    assert.equal(platform.resourceInfoPath, undefined)
    assert.equal(platform.getBotNickname(), 'OpenClaw')
  } finally { setPlatformAdapter(original); first.close(); second.close() }
})

test('interactive contexts validate expiry, preserve replacements, and close cleanly', async () => {
  const adapter = createPlatform()
  class Interactive extends adapter.PluginBase { answer() {} }
  const first = new Interactive(), second = new Interactive()
  try {
    first.e = second.e = context(adapter)
    for (const timeout of [NaN, Infinity, -1, 0, 2 ** 31]) assert.throws(() => first.setContext('answer', false, timeout), RangeError)
    assert.throws(() => first.setContext('missing'), /处理方法/)
    assert.equal(first.setContext('answer', false, 0.01), true)
    assert.equal(second.setContext('answer'), true)
    assert.equal(first.finish('answer'), false, 'Old instance cannot cancel its replacement')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(adapter.getContext(first.e).instance, second)
    assert.equal(second.finish('different'), false)
    assert.equal(second.finish('answer'), true)
    assert.equal(adapter.hasContext(first.e), false)
    second.setContext('answer', true)
    assert.equal(adapter.getContext(first.e).isGroup, true)
    adapter.close()
    assert.equal(adapter.hasContext(first.e), false)
    assert.equal(second.setContext('answer'), false)
  } finally { adapter.close() }
})

test('contexts expire and remain isolated for delimiter-containing conversation identities', async () => {
  const adapter = createPlatform()
  class Interactive extends adapter.PluginBase { answer() {} }
  try {
    const first = new Interactive(), second = new Interactive()
    first.e = { chatId: 'a:b', user_id: 'c' }
    second.e = { chatId: 'a', user_id: 'b:c' }
    first.setContext('answer', false, 0.01)
    assert.equal(adapter.hasContext(second.e), false)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(adapter.hasContext(first.e), false)
  } finally { adapter.close() }
})

test('invalid identity and malformed member caches fail closed without disclosing cache values', async () => {
  const logs = [], adapter = createPlatform({ logger: { warn: text => logs.push(text) } })
  try {
    for (const senderId of ['', '   ', undefined, null]) assert.throws(() => context(adapter, { senderId }), /身份/)
    const e = context(adapter)
    const id = userIdentity('qqbot', 'default', 'other')
    await adapter.redis.set(`phiPlugin:knownUser:${id}`, 'not-json-secret')
    assert.equal(await adapter.pickMember(e, 'other'), null)
    assert.equal(logs.length, 1)
    assert.doesNotMatch(logs[0], /not-json-secret/)
    await adapter.redis.set(`phiPlugin:knownUser:${id}`, JSON.stringify({ channel: 'qqbot', account: 'default', user_id: e.user_id }))
    assert.equal(await adapter.pickMember(e, 'other'), null)
    assert.equal(await adapter.pickMember(e, ''), null)
  } finally { adapter.close() }
})

test('payload conversion rejects malformed data and cleans partially generated media files', async () => {
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-payload-'))
  const adapter = createPlatform({ mediaRoot })
  try {
    const cyclic = ['text']; cyclic.push(cyclic)
    await assert.rejects(adapter.payload(cyclic), /循环引用/)
    await assert.rejects(adapter.payload(adapter.segment.image('base64://%%%%')), /base64/)
    await assert.rejects(adapter.payload(adapter.segment.image('data:text/plain;base64,YQ==')), /data URL/)
    await assert.rejects(adapter.payload(adapter.segment.image(Buffer.alloc(0))), /为空/)
    await assert.rejects(adapter.payload(adapter.segment.image('https://user:secret@example.invalid/a.png')), /凭据/)
    await assert.rejects(adapter.payload([adapter.segment.image(Buffer.from([137, 80, 78, 71])), cyclic]), /循环引用/)
    assert.deepEqual(await fs.readdir(mediaRoot), [])
    const array = ['reusable']
    assert.deepEqual(await adapter.payload([array, array, 0, false, null]), { text: 'reusablereusable0' })
    const payload = await adapter.payload(adapter.segment.image('data:image/png;base64,iVBORw=='))
    assert.deepEqual(await fs.readFile(payload.mediaUrls[0]), Buffer.from([137, 80, 78, 71]))
  } finally { adapter.close(); await fs.rm(mediaRoot, { recursive: true, force: true }) }
})
