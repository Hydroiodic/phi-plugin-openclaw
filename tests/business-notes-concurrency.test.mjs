import test from 'node:test'
import assert from 'node:assert/strict'
import { UserDataLock } from '../model/user/userDataLock.js'
import getNotes from '../model/user/getNotes.js'
import PluginData from '../model/user/pluginData.js'
import { buildingRecord } from '../model/user/userCredentials.js'
import { phimoney } from '../apps/money.js'
import getBanGroup from '../model/user/getBanGroup.js'
import send from '../model/render/send.js'
import picmodle from '../model/render/picmodle.js'
import getInfo from '../model/game/getInfo.js'
import { getPlatformAdapter } from '../components/platform/index.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function storeFixture(t, entries) {
  const records = new Map(Object.entries(entries).map(([key, value]) => [key, { ...new PluginData({ money: value }) }]))
  t.mock.method(getNotes, 'getNotesData', async id => {
    const data = structuredClone(records.get(id) || { money: 0 })
    await tick()
    return new PluginData(data)
  })
  t.mock.method(getNotes, 'putNotesData', (id, data) => {
    getNotes.assertBalance(data.money)
    records.set(id, JSON.parse(JSON.stringify(data)))
    return true
  })
  return records
}

test('ordered user locks support reentry, release on failure and avoid opposite-order deadlocks', async () => {
  const lock = new UserDataLock(),
    observed = []
  await Promise.all([
    lock.run(['a', 'b'], async () => {
      observed.push('first')
      await lock.run(['a'], async () => {
        observed.push('nested')
        await tick()
      })
    }),
    lock.run(['b', 'a'], () => observed.push('second')),
  ])
  assert.deepEqual(observed, ['first', 'nested', 'second'])
  await assert.rejects(
    lock.run(['a'], () => {
      throw new Error('synthetic failure')
    }),
    /synthetic/,
  )
  await lock.run(['a'], () => observed.push('recovered'))
  assert.equal(lock.pending.size, 0)
  await assert.rejects(
    lock.run(['a'], () => lock.run(['b'], () => {})),
    /嵌套/,
  )
  assert.equal(lock.pending.size, 0)
})

test('simultaneous transfers into one account preserve every credit and debit', async t => {
  const records = storeFixture(t, { a: 100, b: 100, c: 100, target: 0 })
  const results = await Promise.all(['a', 'b', 'c'].map(sender => getNotes.transfer(sender, 'target', 50)))
  assert.ok(results.every(result => result.status === 'success'))
  assert.equal(records.get('target').money, 120)
  for (const sender of ['a', 'b', 'c']) assert.equal(records.get(sender).money, 50)
  await Promise.all([getNotes.transfer('a', 'b', 10), getNotes.transfer('b', 'a', 10)])
  assert.equal(records.get('a').money, 48)
  assert.equal(records.get('b').money, 48)
})

test('detached async work cannot reuse ownership after its original lock has been released', async () => {
  const lock = new UserDataLock()
  let wake,
    release,
    started,
    detached,
    ran = false
  const trigger = new Promise(resolve => {
    wake = resolve
  })
  await lock.run(['a'], () => {
    detached = trigger.then(() =>
      lock.run(['a'], () => {
        ran = true
      }),
    )
  })
  const ready = new Promise(resolve => {
    started = resolve
  })
  const pending = lock.run(['a'], async () => {
    started()
    await new Promise(resolve => {
      release = resolve
    })
  })
  await ready
  wake()
  await tick()
  assert.equal(ran, false)
  release()
  await Promise.all([pending, detached])
  assert.equal(ran, true)
  assert.equal(lock.pending.size, 0)
})

test('double-spending, fractional inflation and overflow are rejected', async t => {
  const records = storeFixture(t, { sender: 100, a: 0, b: 0, full: Number.MAX_SAFE_INTEGER })
  const results = await Promise.all([getNotes.transfer('sender', 'a', 100), getNotes.transfer('sender', 'b', 100)])
  assert.equal(results.filter(result => result.status === 'success').length, 1)
  assert.equal(records.get('sender').money, 0)
  for (const amount of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => getNotes.transfer('a', 'b', amount), /正整数/)
  }
  await assert.rejects(getNotes.transfer('a', 'full', 1), /安全范围/)
  assert.equal(records.get('a').money, 80)
})

test('a recipient write failure compensates the sender and unlocks both accounts', async t => {
  const records = storeFixture(t, { sender: 100, target: 0 })
  const write = getNotes.putNotesData
  let fail = true
  t.mock.method(getNotes, 'putNotesData', (id, data) => {
    if (id === 'target' && fail) {
      fail = false
      return false
    }
    return write(id, data)
  })
  await assert.rejects(getNotes.transfer('sender', 'target', 50), /转入方/)
  assert.equal(records.get('sender').money, 100)
  assert.equal(records.get('target').money, 0)
  assert.equal((await getNotes.transfer('sender', 'target', 50)).status, 'success')
  assert.equal(records.get('sender').money, 50)
  assert.equal(records.get('target').money, 40)
})

test('concurrent task refresh awards a completed task only once and preserves settings updates', async t => {
  const records = storeFixture(t, { player: 100 })
  records.get('player').task = [{ song: 'Synthetic.0', finished: false, reward: 25, request: { rank: 'IN', type: 'score', value: 900000 } }]
  const save = { gameRecord: { 'Synthetic.0': [null, null, { score: 1000000, acc: 100 }] }, saveInfo: { summary: { rankingScore: 15 } } }
  const results = await Promise.all([
    ...Array.from({ length: 5 }, () => buildingRecord(undefined, save, { user_id: 'player' })),
    getNotes.update('player', data => {
      data.showB30Analysis = false
    }),
  ])
  assert.equal(
    results.slice(0, 5).reduce((sum, value) => sum + value[1], 0),
    25,
  )
  assert.equal(records.get('player').money, 125)
  assert.equal(records.get('player').task[0].finished, true)
  assert.equal(records.get('player').showB30Analysis, false)
})

test('simultaneous real sign handlers pay the daily award once alongside incoming transfers', async t => {
  const records = storeFixture(t, { player: 0, sender: 100 })
  const messages = []
  t.mock.method(getBanGroup, 'get', async () => false)
  t.mock.method(send, 'getsave_result', async () => false)
  t.mock.method(send, 'send_with_At', async (_event, message) => {
    messages.push(message)
    return true
  })
  t.mock.method(picmodle, 'common', async () => 'synthetic-image')
  t.mock.method(getInfo, 'getill', () => 'synthetic-art')
  t.mock.method(getPlatformAdapter().redis, 'get', async () => JSON.stringify([50, { hitokoto: 'Synthetic quote' }]))
  const oldNotice = getInfo.noticeJson
  getInfo.noticeJson = { code: 0 }
  t.after(() => {
    getInfo.noticeJson = oldNotice
  })
  const command = new phimoney()
  const event = () => ({ msg: '/phi sign', user_id: 'player', isPrivate: true, isGroup: false })
  await Promise.all([command.sign(event()), command.sign(event()), getNotes.transfer('sender', 'player', 50)])
  const success = messages.flat().filter(message => typeof message === 'string' && /恭喜您获得了/.test(message))
  assert.equal(success.length, 1)
  const award = Number(success[0].match(/获得了(\d+)个Note/)[1])
  assert.equal(records.get('player').money, 40 + award)
  assert.equal(records.get('player').sign_history.length, 1)
})
