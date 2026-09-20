import test from 'node:test'
import assert from 'node:assert/strict'
import { phiset } from '../apps/manage.js'
import getBackup from '../model/save/getBackup.js'
import { createPlatform } from '../src/platform.mjs'

test('backup keeps the command alive until the archive and final reply are ready', async t => {
  const adapter = createPlatform(), replies = []
  t.after(() => adapter.close())
  const e = adapter.fromContext({ channel: 'qqbot', senderId: 'test', commandBody: '/phi backup' }, reply => replies.push(reply.text))
  e.isMaster = true
  let finish, completed = false
  t.mock.method(getBackup, 'backup', async event => {
    await new Promise(resolve => { finish = resolve })
    await adapter.reply(event, 'synthetic-backup-ready')
  })
  const pending = new phiset().backup(e).then(() => { completed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof finish, 'function')
  assert.equal(completed, false)
  finish()
  await pending
  await adapter.flush(e)
  assert.ok(replies.includes('synthetic-backup-ready'))
  assert.equal(completed, true)
})
