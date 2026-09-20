import assert from 'node:assert/strict'
import test from 'node:test'
import { phisstk } from '../apps/session.js'
import Config from '../components/Config.js'
import { createPlatform } from '../src/platform.mjs'
import { getPlatformAdapter, setPlatformAdapter } from '../components/platform/index.js'
import getBanGroup from '../model/user/getBanGroup.js'
import getNotes from '../model/user/getNotes.js'
import { UserCredentials } from '../model/user/userCredentials.js'
import getQRcode from '../lib/getQRcode.js'

const qrData = { device_code: 'synthetic-device-code', expires_in: 60, qrcode_url: 'https://example.invalid/login', interval: 1 }
const authorization = { success: true, data: { kid: 'synthetic-kid', mac_key: 'synthetic-key', scope: 'public_profile', access_token: 'synthetic-access' } }
const token = 'B'.repeat(25)
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })
const stageOf = url => String(url).includes('/device/code') ? 'request' : String(url).includes('/account/profile/') ? 'profile' : String(url).endsWith('/users') ? 'login' : 'poll'

function setup(t, signal) {
    const original = getPlatformAdapter(), adapter = createPlatform(), replies = [], bindings = []
    setPlatformAdapter(adapter)
    t.after(() => { setPlatformAdapter(original); adapter.close() })
    const config = Config.getUserCfg
    t.mock.method(Config, 'getUserCfg', (name, key) => key === 'TapTapLoginQRcode' ? false : config.call(Config, name, key))
    t.mock.method(getBanGroup, 'get', async () => false)
    t.mock.method(getNotes, 'getNotesData', async () => ({ allowApiUsage: false }))
    t.mock.method(UserCredentials.prototype, 'getSessionToken', async () => null)
    t.mock.method(UserCredentials.prototype, 'bindLocallyWithSessionToken', async (value, global) => { bindings.push({ value, global }); return null })
    const event = commandBody => adapter.fromContext({ channel: 'qqbot', senderId: 'synthetic-user', commandBody, signal }, payload => { replies.push(payload.text); return true })
    const run = async (command = '/phi gbbind qrcode') => {
        const e = event(command)
        const result = await new phisstk().bind(e)
        await adapter.flush(e)
        assert.equal((await adapter.redis.keys('*qrcode*')).length, 0, 'QR ownership and TTL keys must always be cleared')
        return result
    }
    return { adapter, replies, bindings, run }
}

test('actual QR binding retries a network-null result and pending HTTP response before binding both regions', async t => {
    const fixture = setup(t)
    t.mock.method(getQRcode, 'wait', async () => {})
    let polls = 0
    t.mock.method(globalThis, 'fetch', async url => {
        switch (stageOf(url)) {
            case 'request': return response({ success: true, data: qrData })
            case 'poll': {
                polls++
                if (polls % 3 === 1) throw new Error('synthetic network interruption')
                if (polls % 3 === 2) return response({ success: false, data: { error: 'authorization_waiting' } }, 400)
                return response(authorization)
            }
            case 'profile': return response({ data: { openid: 'synthetic-openid' } })
            case 'login': return response({ sessionToken: token })
        }
    })
    await fixture.run('/phi cnbind qrcode')
    await fixture.run('/phi gbbind qrcode')
    assert.equal(polls, 6)
    assert.deepEqual(fixture.bindings, [{ value: token, global: false }, { value: token, global: true }])
    assert.equal(fixture.replies.filter(text => text?.includes('已扫描')).length, 2)
})

test('QR binding rejects invalid expiry, URL and success data without polling forever or binding old credentials', async t => {
    const fixture = setup(t)
    let data = qrData, malformedSuccess = false, polls = 0, profiles = 0
    t.mock.method(globalThis, 'fetch', async url => {
        switch (stageOf(url)) {
            case 'request': return response({ success: true, data })
            case 'poll': polls++; return response(malformedSuccess ? { success: true, data: {} } : authorization)
            default: profiles++; throw new Error('must not exchange malformed authorization')
        }
    })
    for (const expires_in of [undefined, 0, -1, Infinity, NaN, '60']) {
        data = { ...qrData, expires_in }
        await fixture.run()
    }
    for (const override of [{ qrcode_url: 'javascript:alert(1)' }, { qrcode_url: 'https://user:secret@example.invalid' }, { device_code: '' }]) {
        data = { ...qrData, ...override }
        await fixture.run()
    }
    assert.equal(polls, 0)
    data = qrData; malformedSuccess = true
    await fixture.run()
    assert.equal(polls, 1)
    assert.equal(profiles, 0)
    assert.deepEqual(fixture.bindings, [])
    assert.ok(fixture.replies.some(text => text?.includes('扫码绑定失败')))
})

test('QR polling expires at the original bounded deadline after repeated null responses', async t => {
    const fixture = setup(t)
    let now = Date.now(), polls = 0
    t.mock.method(Date, 'now', () => now)
    t.mock.method(getQRcode, 'wait', async ms => { now += ms })
    t.mock.method(globalThis, 'fetch', async url => {
        if (stageOf(url) === 'request') return response({ success: true, data: { ...qrData, expires_in: 1 } })
        polls++; throw new Error('temporary network error')
    })
    await fixture.run()
    assert.equal(polls, 1)
    assert.deepEqual(fixture.bindings, [])
    assert.ok(fixture.replies.some(text => text?.includes('操作超时')))
    assert.equal(getQRcode.validateRequest({ deviceId: 'test', data: { ...qrData, expires_in: 999999 } }, 270).seconds, 270)
})

for (const phase of ['request', 'poll', 'wait', 'profile', 'login']) {
    test(`QR cancellation interrupts ${phase}, clears cache and never binds`, async t => {
        const controller = new AbortController(), fixture = setup(t, controller.signal), started = Promise.withResolvers()
        if (phase === 'wait') {
            const wait = getQRcode.wait
            t.mock.method(getQRcode, 'wait', async (ms, signal) => { started.resolve(); return wait.call(getQRcode, ms, signal) })
        }
        t.mock.method(globalThis, 'fetch', async (url, options) => {
            const stage = stageOf(url)
            if (stage === phase) {
                started.resolve()
                return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
            }
            switch (stage) {
                case 'request': return response({ success: true, data: { ...qrData, interval: 30 } })
                case 'poll': return response(phase === 'wait' ? { success: false, data: { error: 'authorization_pending' } } : authorization)
                case 'profile': return response({ data: { openid: 'synthetic-openid' } })
                case 'login': return response({ sessionToken: token })
            }
        })
        const running = fixture.run()
        await started.promise
        controller.abort()
        await running
        assert.deepEqual(fixture.bindings, [])
        assert.ok(!fixture.replies.some(text => text?.includes('正在绑定')))
    })
}
