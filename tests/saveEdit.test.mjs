import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CloudSaveArchive } from '../lib/cloudSaveArchive.js'
import { encryptSaveBytes } from '../lib/saveCipher.js'
import {
    SaveFormatError, decodeEntry, decodeGameRecord, decodeSummary, encodeEntry, encodeGameRecord, encodeSummary,
} from '../lib/saveCodec.js'
import { CloudSaveUploader, md5 } from '../lib/saveUploader.js'
import { CloudTransport } from '../lib/cloudTransport.js'
import { SaveEditService } from '../model/save/saveEditService.js'
import { SAVE_TOOL_NAMES, createSaveTools, resolveRequester, runSaveTool } from '../src/save-tools.mjs'
import { immediateReply, isPhigrosCommand } from '../src/commands.mjs'
import { userIdentity } from '../src/identity.mjs'
import { PhigrosPlugin } from '../src/plugin.mjs'

const SESSION = 'a'.repeat(25)
const TAIL = Buffer.from([9, 8, 7])

function sampleContent() {
    return {
        gameRecord: {
            songs: [
                { id: 'Glaciaxion.SunsetRay.0', fcFlags: 0b100, levels: [null, null, { score: 1000000, acc: 100, fc: true }, { score: 950000, acc: Math.fround(98.5), fc: false }, null] },
                { id: 'Other.Composer.0', fcFlags: 0, levels: [{ score: 700000, acc: Math.fround(80), fc: false }, null, null, null, null] },
            ],
        },
        gameProgress: {
            values: {
                isFirstRun: false, legacyChapterFinished: true, alreadyShowCollectionTip: true, alreadyShowAutoUnlockINTip: true,
                completed: '3.0', songUpdateInfo: 5, challengeModeRank: 345, money: [100, 200, 3, 0, 0],
                unlockFlagOfSpasmodic: 1, unlockFlagOfIgallta: 1, unlockFlagOfRrharil: 1, flagOfSongRecordKey: 0, randomVersionUnlocked: 3,
                chapter8UnlockBegin: true, chapter8UnlockSecondPhase: false, chapter8Passed: false, chapter8SongUnlocked: 7,
            },
            // 最高位是插件不认识的标记，必须原样保留
            flagBytes: [0b10000110, 0b1], tail: TAIL,
        },
        user: { values: { showPlayerId: true, selfIntro: '你好', avatar: 'Introduction', background: 'Glaciaxion' }, flagBytes: [1], tail: Buffer.alloc(0) },
        settings: {
            values: {
                chordSupport: true, fcAPIndicator: true, enableHitSound: true, lowResolutionMode: false, deviceName: 'phone',
                bright: 1, musicVolume: 1, effectVolume: Math.fround(0.5), hitSoundVolume: 1, soundOffset: 0, noteScale: 1,
            },
            flagBytes: [0b0111], tail: Buffer.from([1, 2]),
        },
        summary: {
            values: {
                saveVersion: 6, challengeModeRank: 345, rankingScore: Math.fround(0.5), gameVersion: 120, avatar: 'Introduction',
                cleared: [1, 0, 1, 1], fullCombo: [0, 0, 1, 0], phi: [0, 0, 1, 0],
            },
            flagBytes: [], tail: Buffer.alloc(0),
        },
    }
}

async function buildZip(content = sampleContent()) {
    const plain = {
        gameProgress: encodeEntry('gameProgress', content.gameProgress), user: encodeEntry('user', content.user),
        settings: encodeEntry('settings', content.settings), gameRecord: encodeGameRecord(content.gameRecord),
    }
    const versions = { gameProgress: 4, user: 1, settings: 1, gameRecord: 1 }
    return new CloudSaveArchive().write(Object.entries(plain).map(([name, data]) => ({
        name, compression: 'DEFLATE', data: Buffer.concat([Buffer.of(versions[name]), encryptSaveBytes(data)]),
    })))
}

const catalog = () => ({
    findSongs: query => ({ glaciaxion: ['Glaciaxion.SunsetRay.0'], other: ['Other.Composer.0'], same: ['A.0', 'B.0'] })[query.toLowerCase()] || [],
    songName: id => ({ 'Glaciaxion.SunsetRay.0': 'Glaciaxion', 'Other.Composer.0': 'Other' })[id],
    backgroundName: id => ({ 'Glaciaxion.SunsetRay.0': 'Glaciaxion', 'Other.Composer.0': 'Other' })[id],
    difficulty: (id, level) => ({ 'Glaciaxion.SunsetRay.0': { EZ: 1, HD: 4, IN: 12, AT: 14 }, 'Other.Composer.0': { EZ: 2, HD: 6 } })[id]?.[level],
    isAvatar: name => ['Introduction', 'Glaciaxion'].includes(name),
})

/** 模拟 TapTap 云端：记录最新存档和上传的文件 */
async function fakeCloud(t, { verifyFails = false } = {}) {
    const zip = await buildZip()
    const files = new Map([['https://cloud.test/old', zip]])
    const cloud = {
        save: { objectId: 'save1', summary: encodeSummary(sampleContent().summary), modifiedAt: { iso: '2026-09-01T00:00:00.000Z' }, gameFile: { objectId: 'file-old', url: 'https://cloud.test/old' } },
        uploads: [], rollbacks: [],
    }
    const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-save-backup-'))
    t.after(() => fs.rm(backupRoot, { recursive: true, force: true }))
    const service = new SaveEditService({
        credentials: async userId => userId === 'me' ? { sessionToken: SESSION, isGlobal: false } : null,
        catalog,
        saveManager: () => ({ latestSave: async session => {
            assert.equal(session, SESSION)
            return { save: structuredClone(cloud.save), playerInfo: { objectId: 'user1', nickname: 'Tester' } }
        } }),
        transport: /** @type {any} */ ({ request: async url => ({ bytes: files.get(url) }) }),
        uploader: () => /** @type {any} */ ({
            async upload(request) {
                cloud.uploads.push(request)
                files.set('https://cloud.test/new', verifyFails ? Buffer.from('broken') : request.zip)
                cloud.save = { ...cloud.save, summary: request.summary, gameFile: { objectId: 'file-new', url: 'https://cloud.test/new' } }
                return { fileId: 'file-new', url: 'https://cloud.test/new', modifiedAt: 'now' }
            },
            async pointSaveAt(session, target) { cloud.rollbacks.push(target) },
        }),
        backupRoot: () => backupRoot,
    })
    return { service, cloud, zip, backupRoot }
}

test('save codec round-trips every entry and keeps unknown bits and trailing bytes', () => {
    const content = sampleContent()
    for (const name of ['gameProgress', 'user', 'settings']) {
        const bytes = encodeEntry(name, content[name])
        const decoded = decodeEntry(name, bytes)
        assert.deepEqual(encodeEntry(name, decoded), bytes)
        assert.deepEqual(decoded.values, content[name].values)
    }
    const progress = decodeEntry('gameProgress', encodeEntry('gameProgress', content.gameProgress))
    assert.equal(progress.flagBytes[0] & 0x80, 0x80)
    assert.deepEqual(progress.tail, TAIL)
    const record = encodeGameRecord(content.gameRecord)
    assert.deepEqual(decodeGameRecord(record), content.gameRecord)
    assert.deepEqual(decodeSummary(encodeSummary(content.summary)).values, content.summary.values)
    const truncated = Buffer.from(record)
    truncated[1 + 1 + 'Glaciaxion.SunsetRay.0'.length] = 99
    assert.throws(() => decodeGameRecord(truncated), SaveFormatError)
    assert.throws(() => encodeEntry('user', { ...content.user, values: { ...content.user.values, selfIntro: 'x'.repeat(20000) } }), RangeError)
})

test('save edits are validated atomically and uploads need the confirmation code', async t => {
    const { service, cloud, zip, backupRoot } = await fakeCloud(t)
    await assert.rejects(service.fetch('stranger'), /还没有绑定/)
    await assert.rejects(service.read('me'), /请先读取云存档/)
    const overview = await service.fetch('me')
    assert.match(overview, /Tester/)
    assert.match(overview, /Data：3GB 200MB 100KB/)
    assert.match(await service.read('me', { section: 'records', song: 'glaciaxion' }), /Glaciaxion \[Glaciaxion\.SunsetRay\.0\] IN 12：1000000/)

    await assert.rejects(service.edit('me', { profile: { selfIntro: 'changed' }, records: [{ song: 'glaciaxion', level: 'AT', score: 999999, acc: 50 }] }), /不可能同时出现/)
    assert.equal(await service.read('me', { section: 'changes' }), '没有未上传的修改。')
    await assert.rejects(service.edit('me', { records: [{ song: 'same', level: 'IN', score: 1 }] }), /匹配到多首曲目/)
    await assert.rejects(service.edit('me', { records: [{ song: 'other', level: 'AT', score: 1000000, acc: 100 }] }), /没有 AT 难度/)
    await assert.rejects(service.edit('me', { progress: { money: [2000, 0, 0, 0, 0] } }), /money/)
    await assert.rejects(service.edit('me', { profile: { avatar: 'Nope' } }), /头像/)
    await assert.rejects(service.edit('me', { progress: { challengeModeRank: 99 } }), /课题模式/)
    await assert.rejects(service.stage('me'), /没有未上传的修改/)

    const edited = await service.edit('me', {
        profile: { selfIntro: '今天也要 AP' },
        progress: { money: [0, 0, 4, 0, 0] },
        records: [
            { song: 'glaciaxion', level: 'AT', score: 1000000, acc: 100 },
            { song: 'Other.Composer.0', level: 'EZ', remove: true },
            { song: 'other', level: 'HD', score: 1000000, acc: 100 },
        ],
    })
    assert.match(edited, /共有 5 项/)
    assert.match(edited, /简介|selfIntro/)

    const { code, changes } = await service.stage('me')
    assert.match(code, /^[A-Z2-9]{6}$/)
    assert.equal(changes.length, 5)
    await assert.rejects(service.confirm('me', 'WRONG1'), /确认码不正确/)
    const again = await service.stage('me')
    await service.confirm('me', again.code.toLowerCase())

    assert.equal(cloud.uploads.length, 1)
    const upload = cloud.uploads[0]
    assert.equal(upload.userId, 'user1')
    assert.equal(upload.saveId, 'save1')
    const summary = decodeSummary(upload.summary).values
    assert.deepEqual(summary.phi, [0, 1, 1, 1])
    assert.deepEqual(summary.cleared, [0, 1, 1, 1])
    assert.equal(summary.rankingScore, Math.fround((12 + 14 + 6 + 14 + 12 + 6) / 30))

    // 上传的包按读取流程重新打开后应只包含这些修改
    await service.fetch('me')
    assert.match(await service.read('me', { section: 'profile' }), /今天也要 AP/)
    assert.match(await service.read('me', { section: 'records', song: 'other' }), /HD 6：1000000/)
    const backups = await fs.readdir(path.join(backupRoot, 'me'))
    assert.equal(backups.length, 2)
    assert.deepEqual(await fs.readFile(path.join(backupRoot, 'me', backups.find(name => name.endsWith('.zip')))), zip)
    await assert.rejects(service.confirm('me', again.code), /没有待确认/)
})

test('uploads stop when the cloud save changed and roll back when verification fails', async t => {
    const changed = await fakeCloud(t)
    await changed.service.fetch('me')
    await changed.service.edit('me', { profile: { showPlayerId: false } })
    const pending = await changed.service.stage('me')
    changed.cloud.save = { ...changed.cloud.save, gameFile: { objectId: 'file-synced-from-game', url: 'https://cloud.test/old' } }
    await assert.rejects(changed.service.confirm('me', pending.code), /发生了变化/)
    assert.equal(changed.cloud.uploads.length, 0)

    const broken = await fakeCloud(t, { verifyFails: true })
    await broken.service.fetch('me')
    await broken.service.edit('me', { settings: { musicVolume: 0.25 } })
    const staged = await broken.service.stage('me')
    await assert.rejects(broken.service.confirm('me', staged.code), /恢复为修改前/)
    assert.deepEqual(broken.cloud.rollbacks.map(target => target.fileId), ['file-old'])
})

test('save tools only act for the requester in their own isolated direct session', async () => {
    const base = { requesterSenderId: 'Alice', messageChannel: 'qqbot', agentAccountId: 'bot1' }
    const alice = userIdentity('qqbot', 'bot1', 'Alice')
    assert.equal(resolveRequester({ ...base, sessionKey: 'agent:main:qqbot:direct:alice' }).userId, alice)
    assert.equal(resolveRequester({ ...base, sessionKey: 'agent:main:qqbot:bot1:direct:alice:thread:7' }).userId, alice)
    for (const sessionKey of ['agent:main:main', 'agent:main:direct:alice', 'agent:main:qqbot:group:alice', 'agent:main:qqbot:direct:bob',
        'agent:main:telegram:direct:alice', 'agent:main:qqbot:bot2:direct:alice', undefined]) {
        assert.match(resolveRequester({ ...base, sessionKey }).error, /私聊/, String(sessionKey))
    }
    assert.match(resolveRequester({ sessionKey: 'agent:main:qqbot:direct:alice', messageChannel: 'qqbot' }).error, /无法确认/)

    const calls = []
    const tools = createSaveTools({ ...base, sessionKey: 'agent:main:qqbot:bot1:direct:alice' }, async (...args) => { calls.push(args); return 'ok' })
    assert.deepEqual(tools.map(tool => tool.name), SAVE_TOOL_NAMES)
    const edit = tools.find(tool => tool.name === 'phigros_save_edit')
    assert.equal(edit.parameters.additionalProperties, false)
    assert.equal('user' in edit.parameters.properties || 'userId' in edit.parameters.properties, false)
    assert.deepEqual((await edit.execute('call', { profile: { showPlayerId: true } })).content[0].text, 'ok')
    assert.equal(calls[0][1], alice)

    const group = createSaveTools({ ...base, sessionKey: 'agent:main:qqbot:group:123' }, async () => assert.fail('must not run'))
    const refused = await group[0].execute('call', {})
    assert.match(refused.content[0].text, /私聊/)
    assert.equal(refused.details.ok, false)

    const failing = createSaveTools({ ...base, sessionKey: 'agent:main:qqbot:bot1:direct:alice' }, async () => { throw new Error('secret detail') })
    assert.equal((await failing[0].execute('call', {})).content[0].text, '存档操作失败，请稍后重试。')
})

test('upload tool sends the confirmation code straight to the user', async () => {
    const service = { stage: async () => ({ code: 'ABC234', changes: ['个人资料 selfIntro：「a」 → 「b」'] }) }
    const sent = []
    const reply = await runSaveTool(service, 'phigros_save_upload', 'me', {}, { delivery: { send: async payload => { sent.push(payload.text) } } })
    assert.match(sent[0], /\/phi 确认上传 ABC234/)
    assert.doesNotMatch(reply, /ABC234/)
    const fallback = await runSaveTool(service, 'phigros_save_upload', 'me', {})
    assert.match(fallback, /确认上传 ABC234/)
})

test('confirmation commands are routed and refused in group chats', () => {
    assert.equal(isPhigrosCommand('/phi 确认上传 ABC234'), true)
    assert.match(immediateReply({ commandBody: '/phi 确认上传 ABC234', isGroup: true }), /私聊/)
    assert.equal(immediateReply({ commandBody: '/phi 确认上传 ABC234', isGroup: false }), null)
})

test('uploader follows the LeanCloud and Qiniu flow without leaking the session token', async () => {
    const zip = Buffer.from('zip-bytes')
    const requests = []
    const transport = new CloudTransport({ fetcher: async (url, init) => {
        requests.push({ url: String(url), method: init.method, headers: init.headers, body: init.body, redirect: init.redirect })
        const route = String(url)
        if (route.endsWith('/fileTokens')) {
            return Response.json({ objectId: 'file-new', token: 'up-token', url: 'https://files.test/new', provider: 'qiniu', upload_url: 'https://upload.qiniup.com', bucket: 'bucket', key: 'gamesaves/key/.save' })
        }
        if (route.endsWith('/uploads')) return Response.json({ uploadId: 'upload-1' })
        if (route.endsWith('/uploads/upload-1/1')) return Response.json({ etag: 'etag-1' })
        return Response.json({})
    } })
    const uploader = new CloudSaveUploader({ transport })
    const result = await uploader.upload({ session: SESSION, userId: 'user1', saveId: 'save1', zip, summary: 'c3VtbWFyeQ==' })
    assert.equal(result.fileId, 'file-new')
    const key = Buffer.from('gamesaves/key/.save').toString('base64url')
    assert.deepEqual(requests.map(request => `${request.method} ${request.url.replace(/^https:\/\/[^/]+/, '')}`), [
        'POST /1.1/fileTokens',
        `POST /buckets/bucket/objects/${key}/uploads`,
        `PUT /buckets/bucket/objects/${key}/uploads/upload-1/1`,
        `POST /buckets/bucket/objects/${key}/uploads/upload-1`,
        'POST /1.1/fileCallback',
        'PUT /1.1/classes/_GameSave/save1',
    ])
    assert.ok(requests.every(request => request.redirect === 'error'))
    for (const request of requests) {
        const toLeanCloud = request.url.includes('tapapis')
        assert.equal(request.headers['X-LC-Session'] === SESSION, toLeanCloud, request.url)
    }
    assert.equal(JSON.parse(requests[0].body).metaData._checksum, md5(zip))
    const save = JSON.parse(requests.at(-1).body)
    assert.equal(save.gameFile.objectId, 'file-new')
    assert.equal(save.summary, 'c3VtbWFyeQ==')

    const callbacks = []
    const unsupported = new CloudSaveUploader({ transport: new CloudTransport({ fetcher: async (url, init) => {
        if (String(url).endsWith('/fileTokens')) return Response.json({ objectId: 'f', token: 't', url: 'https://x', provider: 'unknown' })
        callbacks.push(JSON.parse(init.body))
        return Response.json({})
    } }) })
    await assert.rejects(unsupported.upload({ session: SESSION, userId: 'u', saveId: 's', zip, summary: '' }), /不支持的文件存储方式/)
    assert.deepEqual(callbacks, [{ result: false, token: 't' }])
})

test('plugin registers save tools only when enabled and only for allowed channels', async () => {
    const register = (pluginConfig, runSaveTool = async () => 'ok') => {
        const tools = []
        const api = {
            pluginConfig, logger: { info() {}, warn() {}, error() {}, debug() {} }, runtime: { state: { resolveStateDir: () => os.tmpdir() } },
            registerCommand() {}, on() {}, registerService() {}, registerTool: (factory, options) => tools.push({ factory, options }),
        }
        new PhigrosPlugin(api, { createRuntime: async () => ({ runSaveTool }) }).register()
        return tools
    }
    assert.equal(register({ saveEditing: false }).length, 0)
    const [registered] = register({ channels: ['qqbot'] }, async (name, userId) => `${name}:${userId}`)
    assert.deepEqual(registered.options.names, SAVE_TOOL_NAMES)
    const ctx = { requesterSenderId: 'Alice', agentAccountId: 'bot1', sessionKey: 'agent:main:qqbot:bot1:direct:alice' }
    assert.equal(registered.factory({ ...ctx, messageChannel: 'telegram', sessionKey: 'agent:main:telegram:bot1:direct:alice' }), null)
    const tools = registered.factory({ ...ctx, messageChannel: 'qqbot' })
    const result = await tools[0].execute('call', {})
    assert.equal(result.content[0].text, `phigros_save_fetch:${userIdentity('qqbot', 'bot1', 'Alice')}`)
    // 没有 registerTool 的旧版宿主照常注册命令
    new PhigrosPlugin({ pluginConfig: {}, logger: { info() {} }, runtime: {}, registerCommand() {}, on() {}, registerService() {} }).register()
})
