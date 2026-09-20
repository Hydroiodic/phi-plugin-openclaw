import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlatform } from '../src/platform.mjs'
import { getPlatformAdapter, setPlatformAdapter } from '../components/platform/index.js'
import getNotes from '../model/user/getNotes.js'
import * as moneyApps from '../apps/money.js'

test('Notes transfers resolve OpenClaw users and never cross channel or bot account boundaries', async t => {
  const original = getPlatformAdapter(), adapter = createPlatform(), balances = new Map(), replies = []
  setPlatformAdapter(adapter)
  t.after(() => { adapter.close(); setPlatformAdapter(original) })
  const event = (senderId, extra = {}) => adapter.fromContext({ channel: 'qqbot', senderId, senderName: senderId, accountId: 'one', ...extra }, reply => replies.push(reply.text))
  const sender = event('alice'), recipient = event('bob'), otherBot = event('bob', { accountId: 'two' }), otherChannel = event('bob', { channel: 'telegram' })
  balances.set(sender.user_id, 100)
  balances.set(recipient.user_id, 10)
  t.mock.method(getNotes, 'getNotesData', async id => ({ money: balances.get(id) || 0 }))
  t.mock.method(getNotes, 'putNotesData', async (id, data) => { balances.set(id, data.money) })
  const App = Object.values(moneyApps).find(value => typeof value === 'function')
  const app = new App()
  for (const target of ['bob', '<@bob>', 'qqbot:one:bob']) {
    sender.msg = `/phi send ${target} 10`
    await app.send(sender)
    await adapter.flush(sender)
    assert.match(replies.at(-1), /转账成功/)
  }
  assert.equal(balances.get(sender.user_id), 70)
  assert.equal(balances.get(recipient.user_id), 34)
  for (const target of ['missing', otherBot.user_id, otherChannel.user_id, 'qqbot:two:bob', '../../outside']) {
    sender.msg = `/phi send ${target} 10`
    await app.send(sender)
    await adapter.flush(sender)
    assert.match(replies.at(-1), /未找到此用户/)
  }
  assert.equal(balances.get(sender.user_id), 70)
  assert.equal(balances.get(recipient.user_id), 34)
  for (const amount of ['-10', 'Infinity', 'NaN', '1000']) {
    sender.msg = `/phi send bob ${amount}`
    await app.send(sender)
    await adapter.flush(sender)
    assert.doesNotMatch(replies.at(-1), /转账成功/)
  }
  assert.equal(balances.get(sender.user_id), 70)
  assert.equal(balances.get(recipient.user_id), 34)
})
