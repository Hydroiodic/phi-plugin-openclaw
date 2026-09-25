import test from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'
import ByteReader from '../lib/ByteReader.js'
import SaveManager from '../lib/SaveManager.js'
import PhigrosUser from '../lib/PhigrosUser.js'

test('binary reader preserves fixed-width types, varints, and multibyte UTF-8 strings', () => {
  const value = '曲'.repeat(80)
  const writer = new ByteReader(Buffer.alloc(256))
  writer.putByte(255)
  writer.putShort(65535)
  writer.putInt(-12345)
  writer.putFloat(98.25)
  writer.putString(value)
  const reader = new ByteReader(writer.data.subarray(0, writer.position))
  assert.equal(reader.getByte(), 255)
  assert.equal(reader.getShort(), 65535)
  assert.equal(reader.getInt(), -12345)
  assert.equal(reader.getFloat(), 98.25)
  assert.equal(reader.getString(), value)
  assert.equal(reader.remaining(), 0)
})

test('binary skips consume exactly one variable-length value or string', () => {
  const reader = new ByteReader(Buffer.from([0x80, 1, 2, 0x61, 0x62, 42]))
  reader.skipVarInt()
  reader.skipString()
  assert.equal(reader.getByte(), 42)
  assert.equal(reader.remaining(), 0)
  assert.throws(() => reader.skipVarInt(-1), RangeError)
  reader.skipVarInt(0)
})

test('truncated buffers fail without moving the read cursor or returning partial data', () => {
  for (const [bytes, method] of [
    [[], 'getByte'],
    [[1], 'getShort'],
    [[1, 2, 3], 'getInt'],
    [[1], 'getFloat'],
    [[0x80], 'getVarInt'],
    [[5, 65], 'getString'],
    [[5, 65], 'getBytes'],
    [[0x80], 'skipString'],
  ]) {
    const reader = new ByteReader(Buffer.from(bytes))
    assert.throws(() => reader[method](), RangeError)
    assert.equal(reader.position, 0)
  }
  for (const position of [-1, 2, 0.5, NaN]) assert.throws(() => new ByteReader(Buffer.alloc(1), position), RangeError)
  for (const invalid of ['0', 'gg', '01zz']) assert.throws(() => new ByteReader(invalid), TypeError)
})

test('binary writes and replacements reject capacity violations before changing data', () => {
  const reader = new ByteReader(Buffer.alloc(2))
  assert.throws(() => reader.putInt(123), RangeError)
  assert.throws(() => reader.putString('abc'), RangeError)
  assert.throws(() => reader.replaceBytes(3, Buffer.alloc(0)), RangeError)
  assert.equal(reader.position, 0)
  assert.deepEqual(reader.data, Buffer.alloc(2))
  reader.insertBytes(Buffer.from([1]))
  assert.deepEqual(reader.data, Buffer.from([1, 0, 0]))
})

test('CN/global cloud requests isolate authentication and bound request duration and size', async t => {
  const calls = []
  t.mock.method(axios, 'get', async (url, config) => {
    calls.push({ url, config })
    return { data: url.endsWith('/users/me') ? { objectId: 'synthetic"object', nickname: 'Player' } : { results: [] } }
  })
  const cn = new SaveManager(false),
    global = new SaveManager(true)
  await Promise.all([cn.getPlayerInfo('cn-synthetic'), global.getPlayerInfo('global-synthetic')])
  await cn.saveArray('cn-synthetic', 'synthetic"object')
  assert.ok(new URL(calls[0].url).hostname.endsWith('.cn'))
  assert.ok(new URL(calls[1].url).hostname.endsWith('.com'))
  assert.notEqual(calls[0].config.headers['X-LC-Id'], calls[1].config.headers['X-LC-Id'])
  assert.equal(calls[0].config.headers['X-LC-Session'], 'cn-synthetic')
  assert.equal(calls[1].config.headers['X-LC-Session'], 'global-synthetic')
  assert.equal(cn.headers['X-LC-Session'], undefined)
  assert.equal(global.headers['X-LC-Session'], undefined)
  assert.equal(JSON.parse(calls[2].config.params.where).user.objectId, 'synthetic"object')
  for (const { config } of calls) {
    assert.equal(config.timeout, 15000)
    assert.equal(config.maxRedirects, 0)
    assert.ok(config.maxContentLength > 0)
  }
})

test('cloud validation rejects malformed responses and strips credential-bearing network errors', async t => {
  const manager = new SaveManager(false)
  t.mock.method(axios, 'get', async () => ({ data: { results: null } }))
  await assert.rejects(manager.getPlayerInfo('secret'), /用户信息格式无效/)
  await assert.rejects(manager.saveArray('secret', 'object'), /存档列表格式无效/)
  t.mock.method(axios, 'get', async () => {
    throw new Error('network failed: session=secret')
  })
  await assert.rejects(manager.getPlayerInfo('secret'), error => {
    assert.doesNotMatch(String(error), /secret/)
    assert.equal(error.cause, undefined)
    return /超时/.test(error.message)
  })
  for (const invalid of [undefined, '', `${'A'.repeat(25)}/../outside`, 'A'.repeat(26)]) {
    assert.throws(() => new PhigrosUser(invalid), /SessionToken格式错误/)
  }
})
