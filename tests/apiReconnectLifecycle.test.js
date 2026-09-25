import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import axios from 'axios'
import Config from '../components/Config.js'
import { AutoSeekApi } from '../model/api/autoSeekApi.js'
import { APIBASEURL } from '../model/game/constNum.js'
import { setApiVersionBlocked, SUPPORTED_API_VERSION } from '../model/api/apiVersion.js'
import botApiAuth from '../model/api/botApiAuth.js'
import botSyncService from '../model/api/botSyncService.js'
import aliasProposalService from '../model/api/aliasProposalService.js'

function deferred() {
    /** @type {(value?: any) => void} */
    let resolve = () => {}
    const promise = new Promise(done => {
        resolve = done
    })
    return { promise, resolve }
}

/** @param {import('node:test').TestContext} t */
function service(t, retryDelayMs = 30_000) {
    const api = new AutoSeekApi({ retryDelayMs })
    setApiVersionBlocked(false)
    t.mock.method(Config, 'getUserCfg', () => true)
    t.after(async () => {
        await api.close()
        setApiVersionBlocked(false)
    })
    return api
}

test('API retry timer is shared, cancelled immediately, and never restarts after close', async t => {
    const api = service(t)
    const request = t.mock.method(axios, 'get', async () => assert.fail('must not request before retry delay'))
    const first = api.seekApi()
    assert.equal(api.seekApi(), first)
    assert.equal(api.seekingApi, true)
    const closing = api.close()
    assert.equal(api.close(), closing)
    await closing
    await first
    assert.equal(api.seekingApi, false)
    assert.equal(api.retryPromise, undefined)
    t.mock.method(Config, 'getUserCfg', () => assert.fail('closed service must not read config'))
    await api.seekApi()
    await api.testStatus()
    assert.equal(request.mock.callCount(), 0)
})

test('closing API service aborts shared status requests and keeps default HTTPS verification', async t => {
    const api = service(t)
    /** @type {AbortSignal | undefined} */
    let signal
    let calls = 0
    t.mock.method(axios, 'get', (/** @type {string} */ url, /** @type {{timeout: number, signal: AbortSignal}} */ options) => {
        calls++
        assert.equal(url, `${APIBASEURL}/status`)
        assert.equal(options.timeout, 5000)
        assert.equal(Object.hasOwn(options, 'httpsAgent'), false)
        assert.equal(Object.hasOwn(options, 'rejectUnauthorized'), false)
        const requestSignal = options.signal
        signal = requestSignal
        return new Promise((resolve, reject) =>
            requestSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        )
    })
    const first = api.testStatus()
    assert.equal(api.testStatus(), first)
    assert.equal(calls, 1)
    await api.close()
    await first
    assert.ok(signal)
    assert.equal(signal.aborted, true)
    assert.equal(api.waitApi, false)
    assert.equal(api.openPhiPluginApi, false)
    assert.equal(api.retryPromise, undefined)
})

test('API shutdown drains current identity recovery without starting later synchronization', async t => {
    const api = service(t),
        entered = deferred(),
        identity = deferred()
    t.mock.method(axios, 'get', async () => ({ status: 200, data: { version: SUPPORTED_API_VERSION } }))
    t.mock.method(botApiAuth, 'recoverAfterReconnect', async () => {
        entered.resolve()
        return identity.promise
    })
    t.mock.method(botSyncService, 'recoverAfterReconnect', async () => assert.fail('must not synchronize after shutdown'))
    t.mock.method(aliasProposalService, 'initialize', async () => assert.fail('must not initialize after shutdown'))
    const work = api.testStatus()
    await entered.promise
    let closed = false
    const stopping = api.close().then(() => {
        closed = true
    })
    await Promise.resolve()
    assert.equal(closed, false)
    identity.resolve({ clientId: 'test-client' })
    await Promise.all([work, stopping])
    assert.equal(closed, true)
    assert.equal(api.openPhiPluginApi, false)
})

test('pending API retry exits without another request when API is disabled', async t => {
    const api = service(t, 1)
    let enabled = true
    t.mock.method(Config, 'getUserCfg', () => enabled)
    const request = t.mock.method(axios, 'get', async () => {
        throw new Error('offline')
    })
    await api.testStatus()
    assert.equal(request.mock.callCount(), 1)
    const retry = api.retryPromise
    assert.ok(retry)
    enabled = false
    // A referenced test timer keeps Node alive while the service's timer is unref'ed.
    await delay(10)
    await retry
    assert.equal(request.mock.callCount(), 1)
    assert.equal(api.seekingApi, false)
    assert.equal(api.openPhiPluginApi, false)
})

test('API retry performs one recovery chain and stops after a successful reconnect', async t => {
    const api = service(t, 1)
    let calls = 0,
        recovered = 0
    t.mock.method(axios, 'get', async () => {
        if (++calls === 1) throw new Error('offline')
        return { status: 200, data: { version: SUPPORTED_API_VERSION } }
    })
    t.mock.method(botApiAuth, 'recoverAfterReconnect', async () => ({ clientId: 'test-client' }))
    t.mock.method(botSyncService, 'recoverAfterReconnect', async () => {
        recovered++
    })
    t.mock.method(aliasProposalService, 'initialize', async () => {
        recovered++
    })
    await api.testStatus()
    const retry = api.retryPromise
    await delay(15)
    await retry
    assert.equal(calls, 2)
    assert.equal(recovered, 2)
    assert.equal(api.seekingApi, false)
    assert.equal(api.openPhiPluginApi, true)
})

test('API retry configuration rejects timer overflow and missing boundaries', () => {
    for (const retryDelayMs of [0, -1, 0.5, NaN, Infinity, 2 ** 31]) assert.throws(() => new AutoSeekApi({ retryDelayMs }), RangeError)
})
