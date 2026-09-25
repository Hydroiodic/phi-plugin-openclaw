import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SqliteStore } from '../src/sqlite.mjs'

test('SQLite persists credentials and ranking across close/reopen; expiry and negative ranges work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-db-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'phi.sqlite')
  let db = new SqliteStore(file)
  await db.set('user:1', 'secret')
  await db.set('expiring', '1', { PX: 30 })
  assert.equal(await db.ttl('user:1'), -1)
  assert.equal(await db.zAdd('rank', { value: 'b', score: -15 }), 1)
  assert.equal(await db.zAdd('rank', { value: 'a', score: -15 }), 1)
  assert.equal(await db.zAdd('rank', { value: 'c', score: -14 }), 1)
  assert.equal(await db.zAdd('rank', { value: 'c', score: -13 }), 0)
  db.close()
  await delay(40)
  db = new SqliteStore(file)
  try {
    assert.equal(await db.get('user:1'), 'secret')
    assert.equal(await db.get('expiring'), null)
    assert.equal(await db.ttl('expiring'), -2)
    assert.deepEqual(await db.zRange('rank', 0, -1), ['a', 'b', 'c'])
    assert.deepEqual(await db.zRange('rank', -2, -1, 'WITHSCORES'), ['b', '-15', 'c', '-13'])
    assert.equal(await db.zRank('rank', 'b'), 1)
    assert.equal(await db.zRank('rank', 'absent'), null)
    assert.equal(await db.zCount('rank', -15, -14), 2)
    assert.equal(await db.del('rank'), 1)
    assert.equal(await db.zCard('rank'), 0)
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  } finally {
    db.close()
  }
})

test('scan remains complete when deleting each returned page', async () => {
  const db = new SqliteStore()
  try {
    for (let i = 0; i < 257; i++) await db.set(`legacy:${i}`, i)
    await db.set('keep', '1')
    let cursor = 0,
      removed = 0
    do {
      const page = await db.scan(cursor, { MATCH: 'legacy:*', COUNT: 17 })
      removed += await db.del(page.keys)
      cursor = page.cursor
    } while (cursor)
    assert.equal(removed, 257)
    assert.deepEqual(await db.keys(), ['keep'])
    await assert.rejects(db.set('bad', '1', { EX: -1 }))
  } finally {
    db.close()
  }
})

test('all sorted-set operations expire entries and enforce their type consistently', async t => {
  const db = new SqliteStore()
  t.after(() => db.close())
  const operations = [
    ['zScore', ['a'], null],
    ['zCard', [], 0],
    ['zCount', [-Infinity, Infinity], 0],
    ['zRank', ['a'], null],
    ['zRange', [0, -1], []],
    ['zRem', ['a'], 0],
  ]
  for (const [method, args, expected] of operations) {
    await db.zAdd('expired', { score: 1, value: 'a' })
    db.db.prepare('UPDATE entries SET expires=0 WHERE key=?').run('expired')
    assert.deepEqual(await db[method]('expired', ...args), expected, method)
    assert.equal(await db.ttl('expired'), -2)
    await db.set('string', 'value')
    await assert.rejects(db[method]('string', ...args), /WRONGTYPE/, method)
  }
  await db.zAdd('rank', { score: 1, value: 'a' })
  await assert.rejects(db.get('rank'), /WRONGTYPE/)
  await assert.rejects(db.zAdd('string', { score: 1, value: 'a' }), /WRONGTYPE/)
  assert.equal(await db.get('string'), 'value')
})

test('SQLite validates numeric boundaries without partial writes or leaking raw SQL errors', async t => {
  const db = new SqliteStore()
  t.after(() => db.close())
  await db.set('keep', 'original')
  for (const options of [
    { PX: Infinity },
    { PX: NaN },
    { PX: null },
    { PX: 0.1 },
    { PX: Number.MAX_SAFE_INTEGER },
    { EX: 0 },
    { EX: 1, PX: 1 },
    null,
  ]) {
    await assert.rejects(db.set('keep', 'changed', options), /Invalid expiry/)
    assert.equal(await db.get('keep'), 'original')
  }
  for (const value of [1.5, -1, NaN, Infinity, '', null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(db.scan(value), /Invalid cursor/)
    await assert.rejects(db.scan(0, { COUNT: value }), /Invalid count/)
  }
  for (const value of [0.5, NaN, Infinity, '', null]) await assert.rejects(db.zRange('rank', value, 1), /Invalid range start/)
  for (const score of [NaN, Infinity, '', null]) await assert.rejects(db.zAdd('rank', { score, value: 'a' }), /Invalid score/)
  await db.zAdd('rank', { score: 1, value: 'a' })
  assert.deepEqual(await db.zRange('rank', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), ['a'])
  assert.deepEqual(await db.zRange('rank', 0, -2), [])
  assert.equal(await db.zCount('rank', -Infinity, Infinity), 1)
  assert.deepEqual((await db.scan('0', { COUNT: '1' })).keys, ['keep'])
})

test('SQLite nested transactions roll back locally, reject asynchronous callbacks and close idempotently', async () => {
  const db = new SqliteStore()
  const insert = key => db.db.prepare("INSERT INTO entries(key,value,kind) VALUES(?,'value','string')").run(key)
  db.transaction(() => {
    insert('outer')
    assert.throws(
      () =>
        db.transaction(() => {
          insert('inner')
          throw new Error('cancel inner')
        }),
      /cancel inner/,
    )
    insert('outer-after')
  })
  assert.deepEqual(await db.keys(), ['outer', 'outer-after'])
  assert.throws(
    () =>
      db.transaction(() => {
        insert('rollback')
        throw new Error('cancel outer')
      }),
    /cancel outer/,
  )
  assert.equal(await db.get('rollback'), null)
  assert.throws(() => db.transaction(async () => insert('async')), /synchronous callback/)
  assert.equal(await db.get('async'), null)
  assert.throws(
    () =>
      db.transaction(() => {
        insert('promise')
        return Promise.resolve()
      }),
    /synchronous callback/,
  )
  assert.equal(await db.get('promise'), null)
  db.close()
  assert.doesNotThrow(() => db.close())
  await assert.rejects(db.get('outer'), /store is closed/)
  assert.throws(() => db.transaction(() => null), /store is closed/)
})

test('changing key types cleans dependent rows and removing a final member removes its key', async t => {
  const db = new SqliteStore()
  t.after(() => db.close())
  await db.zAdd('rank', { score: 1, value: 'a' })
  await db.set('rank', 'replacement')
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 0)
  await db.del('rank')
  await db.zAdd('rank', { score: 1, value: 'a' })
  assert.equal(await db.zRem('rank', 'a'), 1)
  assert.deepEqual(await db.keys(), [])
})
