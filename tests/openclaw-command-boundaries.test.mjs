import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../src/commands.mjs'
import { createPlatform } from '../src/platform.mjs'

test('pending group context cannot capture credential commands or host commands', async t => {
  const adapter = createPlatform(), replies = [], inputs = []
  t.after(() => adapter.close())
  class Interaction extends adapter.PluginBase {
    constructor() { super({ rule: [{ reg: '^/phi choose$', fnc: 'choose' }] }) }
    async choose(e) { this.e = e; this.setContext('answer', true); await adapter.reply(e, '选择') }
    async answer(e) { inputs.push(e.msg) }
  }
  const router = createRouter({ interaction: Interaction }, adapter)
  const event = msg => adapter.fromContext({ channel: 'qqbot', senderId: 'test', isGroup: true, conversationId: 'group', commandBody: msg }, payload => replies.push(payload.text))
  await router.dispatch(event('/phi choose'))
  assert.equal(adapter.hasContext(event('1')), true)
  await router.dispatch(event('/gbbind secret'))
  assert.match(replies.at(-1), /私聊/)
  assert.equal(await router.dispatch(event('/help')), false)
  assert.equal(await router.dispatch(event('/another-plugin')), false)
  assert.deepEqual(inputs, [])
  await router.dispatch(event('/phi reply 取消'))
  assert.equal(adapter.hasContext(event('1')), false)
  assert.match(replies.at(-1), /已取消/)
})

test('unknown explicit Phigros commands return guidance instead of falling through to a model', async t => {
  const adapter = createPlatform(), replies = []
  t.after(() => adapter.close())
  const router = createRouter({}, adapter)
  const e = adapter.fromContext({ channel: 'qqbot', senderId: 'test', commandBody: '/phi unknown' }, payload => replies.push(payload.text))
  assert.equal(await router.dispatch(e), true)
  assert.match(replies[0], /未识别.*\/phi help/)
})

test('zero-priority commands precede default priority and invalid handlers fail at startup', async t => {
  const adapter = createPlatform(), observed = []
  t.after(() => adapter.close())
  class Default extends adapter.PluginBase {
    constructor() { super({ rule: [{ reg: '^/phi test$', fnc: 'run' }] }) }
    async run() { observed.push('default'); return true }
  }
  class First extends Default { constructor() { super(); this.priority = 0 } async run() { observed.push('first'); return true } }
  const router = createRouter({ default: Default, first: First }, adapter)
  await router.dispatch(adapter.fromContext({ channel: 'qqbot', senderId: 'test', commandBody: '/phi test' }, () => true))
  assert.deepEqual(observed, ['first'])
  class Invalid extends adapter.PluginBase { constructor() { super({ rule: [{ reg: '^/phi test$', fnc: 'absent' }] }) } }
  assert.throws(() => createRouter({ invalid: Invalid }, adapter), /Invalid command handler/)
})
