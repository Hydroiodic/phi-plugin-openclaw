import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createCipheriv } from 'node:crypto'
import JSZip from 'jszip'
import { CloudTransport } from '../lib/cloudTransport.js'
import { CloudSaveArchive } from '../lib/cloudSaveArchive.js'
import TapTapHelper from '../lib/TapTap/TapTapHelper.js'
import LCHelper from '../lib/TapTap/LCHelper.js'
import PhigrosUser from '../lib/PhigrosUser.js'
import { SAVE_KEY, SAVE_IV } from '../lib/saveCipher.js'

const required = ['gameProgress', 'user', 'settings', 'gameRecord']
async function archive(overrides = {}, options = {}) {
    const zip = new JSZip()
    for (const name of required) if (overrides[name] !== null) zip.file(name, overrides[name] ?? Buffer.alloc(17, 1))
    for (const [name, bytes] of Object.entries(overrides)) if (!required.includes(name)) zip.file(name, bytes)
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', ...options })
}

test('cloud transport bounds advertised and streamed bodies, cancels readers and sanitizes errors', async () => {
    let cancelled = 0
    for (const declared of [false, true]) {
        const transport = new CloudTransport({ maxBytes: 8, fetcher: async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(9)) }, cancel() { cancelled++ },
        }), { headers: declared ? { 'content-length': '9' } : {} }) })
        await assert.rejects(transport.json('https://example.invalid'), { code: 'CLOUD_SIZE' })
    }
    assert.equal(cancelled, 2)
    const badJson = new CloudTransport({ fetcher: async () => new Response('private-token-not-json') })
    await assert.rejects(badJson.json('https://example.invalid'), error => error.code === 'CLOUD_JSON' && !String(error).includes('private-token'))
    const badNetwork = new CloudTransport({ fetcher: async () => { throw new Error('Authorization: private-network-token') } })
    await assert.rejects(badNetwork.json('https://example.invalid?private-query'), error => error.code === 'CLOUD_NETWORK' && !String(error).includes('private'))
    await assert.rejects(badNetwork.json('file:///private/token'), { code: 'CLOUD_URL' })
    await assert.rejects(badNetwork.json('https://user:secret@example.invalid'), { code: 'CLOUD_URL' })
})

test('cloud transport has a total deadline for stalled headers and stalled response bodies', async () => {
    for (const fetcher of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ pull() {} }))]) {
        const transport = new CloudTransport({ fetcher, timeoutMs: 10 })
        await Promise.all([assert.rejects(transport.json('https://example.invalid'), { code: 'CLOUD_TIMEOUT' }), delay(25)])
    }
    const controller = new AbortController(); controller.abort()
    const transport = new CloudTransport({ fetcher: async () => { throw new Error('must not fetch') } })
    await assert.rejects(transport.json('https://example.invalid', { signal: controller.signal }), { code: 'CLOUD_ABORTED' })
})

test('TapTap polling preserves non-200 pending responses and bounded failures remain retryable', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: false, data: { error: 'authorization_pending' } }), { status: 400 }))
    const request = { deviceId: 'synthetic', data: { device_code: 'synthetic' } }
    assert.equal((await TapTapHelper.checkQRCodeResult(request)).data.error, 'authorization_pending')
    await assert.rejects(TapTapHelper.requestLoginQrCode(), { code: 'CLOUD_HTTP' })
    globalThis.fetch = async () => new Response('private-bad-json')
    assert.equal(await TapTapHelper.checkQRCodeResult(request), null)
    await assert.rejects(LCHelper.loginAndGetToken({ openid: 'synthetic' }), error => !String(error).includes('private-bad-json'))
    globalThis.fetch = async () => new Response('oversize', { headers: { 'content-length': '999999999' } })
    assert.equal(await TapTapHelper.checkQRCodeResult(request), null)
})

test('cloud archive validates required files, entry count, sizes, safe names and CRC', async () => {
    const parser = new CloudSaveArchive()
    assert.deepEqual(Object.keys(await parser.read(await archive())), required)
    await assert.rejects(parser.read(Buffer.from('private-not-zip')), /ZIP/)
    await assert.rejects(parser.read(await archive({ user: null })), /缺少必要文件/)
    await assert.rejects(parser.read(await archive({ '../unsafe': Buffer.from('secret') })), /不安全/)
    await assert.rejects(new CloudSaveArchive({ maxArchiveBytes: 32 }).read(await archive()), /大小限制/)
    await assert.rejects(new CloudSaveArchive({ maxEntries: 3 }).read(await archive()), /文件数量/)
    await assert.rejects(new CloudSaveArchive({ maxEntryBytes: 32 }).read(await archive({ gameRecord: Buffer.alloc(1024) })), /大小限制/)
    await assert.rejects(new CloudSaveArchive({ maxTotalBytes: 64 }).read(await archive()), /大小限制/)
    const damaged = await archive()
    const directory = damaged.indexOf(Buffer.from('504b0102', 'hex'))
    damaged.writeUInt32LE(0, directory + 16)
    await assert.rejects(parser.read(damaged), /损坏/)
})

test('forged ZIP uncompressed sizes cannot bypass actual streaming limits', async () => {
    const bytes = await archive({ gameRecord: Buffer.alloc(128 * 1024, 7) })
    let offset = 0
    while ((offset = bytes.indexOf(Buffer.from('504b0102', 'hex'), offset)) !== -1) {
        const length = bytes.readUInt16LE(offset + 28)
        if (bytes.subarray(offset + 46, offset + 46 + length).toString() === 'gameRecord') bytes.writeUInt32LE(17, offset + 24)
        offset += 46 + length
    }
    await assert.rejects(new CloudSaveArchive({ maxEntryBytes: 1024 }).read(bytes), /损坏|安全限制/)
})

function encrypt(bytes) {
    const cipher = createCipheriv('aes-256-cbc', SAVE_KEY, SAVE_IV)
    return Buffer.concat([Buffer.from([1]), cipher.update(bytes), cipher.final()])
}

test('PhigrosUser downloads and parses a bounded complete snapshot; failures preserve existing records', async t => {
    const files = { gameProgress: encrypt(Buffer.alloc(17)), user: encrypt(Buffer.alloc(4)),
        settings: encrypt(Buffer.alloc(26)), gameRecord: encrypt(Buffer.from([0])) }
    let bytes = await archive(files)
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(bytes)))
    const user = new PhigrosUser('a'.repeat(25))
    user.getSaveInfo = async () => { user.saveInfo = { gameFile: { url: 'https://example.invalid/save' }, summary: { saveVersion: 2 } }; return user.saveInfo }
    await user.buildRecord()
    assert.deepEqual(user.gameRecord, {})
    assert.deepEqual(user.gameProgress.money, [0, 0, 0, 0, 0])
    assert.equal(user.Recordver, 1)
    const existing = user.gameRecord = { previous: [] }
    bytes = await archive({ ...files, settings: Buffer.from([1, 2, 3]) })
    await assert.rejects(user.buildRecord(), /存档内容损坏/)
    assert.equal(user.gameRecord, existing)
    bytes = await archive({ ...files, gameRecord: Buffer.from([99, 2, 3]) })
    await assert.rejects(user.buildRecord(), /版本已更新/)
    assert.equal(user.gameRecord, existing)
})
