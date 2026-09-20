import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createPlatform, userIdentity } from '../src/platform.mjs'
import { createRouter, normalizeCommand, isPhigrosCommand } from '../src/commands.mjs'

test('the adapter implements every platform method referenced by business modules', () => {
  const adapter = createPlatform(), required = new Set()
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) scan(file)
      else if (file.endsWith('.js')) for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bplatform\.([A-Za-z_$][\w$]*)\s*\(/g)) required.add(match[1])
    }
  }
  try {
    for (const folder of ['apps', 'model', 'components']) scan(new URL(`../${folder}`, import.meta.url).pathname)
    for (const name of required) assert.equal(typeof adapter[name], 'function', `Missing platform.${name}`)
  } finally { adapter.close() }
})

test('tag command event clones retain identity, shared reply tracking and delivery', async () => {
  const adapter = createPlatform(), replies = []
  try {
    const original = adapter.fromContext({ channel: 'qqbot', senderId: 'test', commandBody: '/phi settag Credits #tag' }, reply => replies.push(reply.text))
    const clone = adapter.cloneEvent(original, { msg: '/phi settag Credits' })
    assert.equal(clone.user_id, original.user_id)
    assert.equal(clone.chatId, original.chatId)
    assert.equal(original.msg, '/phi settag Credits #tag')
    clone.reply('tag-menu')
    await adapter.flush(original)
    assert.deepEqual(replies, ['tag-menu'])
    assert.equal(original._replyCount, 1)
  } finally { adapter.close() }
})

test('canonical command forms and group sender isolation', async () => {
  assert.equal(normalizeCommand('/b30'), '/phi b30')
  for (const region of ['gb', 'cn']) {
    assert.equal(isPhigrosCommand(`/${region}bind qrcode`), true)
    assert.equal(isPhigrosCommand(`<@123> /${region}bind qrcode`), true)
    assert.equal(normalizeCommand(`/${region}bind qrcode`), `/phi ${region}bind qrcode`)
    assert.equal(isPhigrosCommand(`/${region}绑定${'A'.repeat(25)}`), true)
    assert.equal(isPhigrosCommand(`/${region}bind${'A'.repeat(25)}`), true)
  }
  assert.equal(isPhigrosCommand('/bind-another-plugin'), false)
  assert.equal(normalizeCommand('<@123> /b30'), '/phi b30')
  assert.equal(normalizeCommand('[CQ:at,qq=123] /phib30'), '/phi b30')
  assert.equal(normalizeCommand('/phi 单曲成绩 Rrhar\'il'), '/phi 单曲成绩 Rrhar\'il')
  assert.equal(normalizeCommand('聊天里提到 /b30'), '聊天里提到 /b30')
  assert.equal(normalizeCommand('/help'), '/help')
  assert.equal(normalizeCommand('/phi help'), '/phi help')
  const adapter = createPlatform()
  const event = overrides => adapter.fromContext({ channel: 'qqbot', accountId: 'bot', senderId: 'alice', isGroup: true, from: 'qqbot:group:group1', ...overrides }, () => {})
  try {
    const a = event({}), b = event({ senderId: 'bob' })
    assert.notEqual(a.user_id, b.user_id)
    assert.equal(a.group_id, b.group_id)
    assert.equal(a.user_id, event({ from: 'qqbot:direct:alice', isGroup: false }).user_id)
    assert.notEqual(a.user_id, event({ accountId: 'other' }).user_id)
    assert.notEqual(a.user_id, event({ channel: 'telegram' }).user_id)
    assert.equal(event({ senderId: '../../evil' }).user_id.includes('/'), false)
    assert.equal(a.isMaster, false)
    assert.throws(() => event({ senderId: '' }), /身份/)
  } finally { adapter.close() }
})

test('credentials stay private; commands outrank game listeners; async replies drain; contexts are scoped', async () => {
  const adapter = createPlatform()
  const replies = []
  const event = (commandBody, overrides = {}) => adapter.fromContext({ channel: 'qqbot', senderId: 'alice', isGroup: false, from: 'dm', commandBody, ...overrides }, p => { replies.push(p); return true })
  class Scores extends adapter.PluginBase {
    constructor() { super({ rule: [{ reg: '^/phi b30$', fnc: 'score' }, { reg: '^/phi choose$', fnc: 'choose' }] }) }
    async score(e) { adapter.reply(e, 'B30'); await Promise.resolve() }
    async choose(e) { this.e = e; this.setContext('answer'); adapter.reply(e, '请选择') }
    async answer(e) { adapter.reply(e, `选择:${e.msg}`); this.finish('answer') }
  }
  class Games extends adapter.PluginBase {
    constructor() { super({ rule: [{ reg: '^.*$', fnc: 'guess' }] }) }
    async guess() { return false }
  }
  class Bind extends adapter.PluginBase {
    constructor() { super({ rule: [{ reg: '^/phi (bind|绑定).*$', fnc: 'bind' }] }) }
    async bind(e) { await adapter.reply(e, 'bound') }
  }
  const router = createRouter({ b19: Scores, guessGame: Games, session: Bind }, adapter)
  const run = async e => { const result = await router.dispatch(e); await adapter.flush(e); return result }
  try {
    assert.equal(await run(event('/b30')), true)
    assert.equal(replies.at(-1).text, 'B30')
    assert.equal(await run(event('无关聊天')), false)
    assert.equal(await run(event('/bind token', { isGroup: true })), true)
    assert.match(replies.at(-1).text, /私聊/)
    assert.equal(await run(event('/绑定token', { isGroup: true })), true)
    assert.match(replies.at(-1).text, /私聊/)
    await run(event('/phi choose'))
    assert.equal(adapter.hasContext(event('1', { senderId: 'bob' })), false)
    assert.equal(adapter.hasContext(event('1', { from: 'another' })), false)
    assert.equal(await run(event('/phi reply 2')), true)
    assert.equal(replies.at(-1).text, '选择:2')
    assert.equal(adapter.hasContext(event('3')), false)
    await run(event('/phi choose'))
    await run(event('<@123> /phi reply 1'))
    assert.equal(replies.at(-1).text, '选择:1')
  } finally { adapter.close() }
})

test('command authorization does not grant administrator rights', async () => {
  const adapter = createPlatform({ config: { admins: ['qqbot:one:alice'] } })
  try {
    const ctx = { channel: 'qqbot', accountId: 'one', senderId: 'alice', isAuthorizedSender: true }
    assert.equal(adapter.fromContext(ctx, () => {}).isMaster, true)
    assert.equal(adapter.fromContext({ ...ctx, accountId: 'two' }, () => {}).isMaster, false)
    assert.equal(adapter.fromContext({ ...ctx, senderId: 'bob' }, () => {}).isMaster, false)
    assert.equal(userIdentity('qqbot', 'one', 'alice'), adapter.fromContext(ctx, () => {}).user_id)
  } finally { adapter.close() }
})
import { redactLog } from '../src/platform.mjs'

test('legacy logger redacts session tokens and common authorization fields', () => {
  const secret = 'abc123DEF456abc123DEF456x'
  assert.equal(secret.length, 25)
  const output = redactLog(`存档 ${secret} Authorization: Bearer private-key access_token=opaque-key`)
  assert.ok(!output.includes(secret) && !output.includes('private-key') && !output.includes('opaque-key'))
})
