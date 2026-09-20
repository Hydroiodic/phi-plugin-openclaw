import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { phihelp } from '../apps/apiSetting.js'
import { phisong } from '../apps/phisong.js'
import { phiset } from '../apps/manage.js'
import { UserCredentials } from '../model/user/userCredentials.js'
import getBanGroup from '../model/user/getBanGroup.js'
import getChartTag, { ChartTagStore } from '../model/game/getChartTag.js'
import getInfo from '../model/game/getInfo.js'
import Config from '../components/Config.js'
import send from '../model/render/send.js'
import getBackup from '../model/save/getBackup.js'
import { backupPath } from '../model/filesystem/path.js'
import { LocalDataDirectory } from '../model/save/localDataDirectory.js'
import getSave from '../model/save/getSave.js'
import getSaveFromApi from '../model/save/getSaveFromApi.js'

const event = (msg, user = 'business-user') => ({ msg, user_id: user, isMaster: true, isPrivate: true, isGroup: false })
const sampleHistory = { scoreHistory: {}, data: [], rks: [{ date: '2026-01-01', value: 10 }], challengeModeRank: [] }

test('official and SP artwork always use shared references; only explicit custom songs may override images', t => {
    const official = 'Credits.Frums.0', special = 'Anomaly.0', custom = 'Custom.0'
    const ori = getInfo.ori_info, sp = getInfo.sp_info
    t.after(() => { getInfo.ori_info = ori; getInfo.sp_info = sp })
    getInfo.ori_info = { [official]: { id: official, illustration: 'https://unexpected.example/official.png' } }
    getInfo.sp_info = { [special]: { id: special, illustration: 'https://unexpected.example/sp.png' } }
    let enabled = 0
    t.mock.method(Config, 'getUserCfg', name => name === 'config' ? enabled : { [custom]: { id: custom, illustration: 'https://custom.example/image.png' } })
    t.mock.method(getInfo, 'all_info', () => ({ ...getInfo.ori_info, ...getInfo.sp_info, [custom]: { id: custom } }))
    assert.equal(getInfo.getill(official), 'phi-illustration:///ill/Credits.Frums.png')
    assert.equal(getInfo.getill(official, 'low'), 'phi-illustration:///illLow/Credits.Frums.png')
    assert.equal(getInfo.getill(special), 'phi-illustration:///SP/Anomaly.png')
    enabled = 1
    assert.equal(getInfo.getill(custom), 'https://custom.example/image.png')
    assert.equal(getInfo.getill(special), 'phi-illustration:///SP/Anomaly.png')
})

test('updateHistory uploads only the caller history and does not claim success before upload completes', async t => {
    const messages = [], users = []
    let finish
    t.mock.method(send, 'send_with_At', async (_event, message) => messages.push(message))
    t.mock.method(getBanGroup, 'get', async () => false)
    t.mock.method(UserCredentials.prototype, 'getSessionToken', async function () { users.push(this.userId); return 'A'.repeat(25) })
    t.mock.method(UserCredentials.prototype, 'getLocalHistory', async () => sampleHistory)
    t.mock.method(UserCredentials.prototype, 'uploadHistory', async function (data) {
        assert.equal(this.userId, 'requesting-user')
        assert.equal(data, sampleHistory)
        await new Promise(resolve => { finish = resolve })
        return { message: 'ok' }
    })
    const command = new phihelp()
    command.checkApiEnabled = async () => true
    const pending = command.updateHistory(event('/phi updateHistory', 'requesting-user'))
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    assert.equal(messages.length, 0)
    finish()
    assert.equal(await pending, true)
    assert.deepEqual(users, ['requesting-user'])
    assert.match(messages.at(-1), /已上传/)
})

test('updateHistory respects disabled API, missing credentials, empty history and API failures', async t => {
    const messages = []
    let uploads = 0, token = 'A'.repeat(25), history = sampleHistory
    t.mock.method(send, 'send_with_At', async (_event, message) => messages.push(message))
    t.mock.method(getBanGroup, 'get', async () => false)
    t.mock.method(UserCredentials.prototype, 'getSessionToken', async () => token)
    t.mock.method(UserCredentials.prototype, 'getLocalHistory', async () => history)
    t.mock.method(UserCredentials.prototype, 'uploadHistory', async () => { uploads++; return null })
    const command = new phihelp()
    command.checkApiEnabled = async () => false
    assert.equal(await command.updateHistory(event('/phi updateHistory')), false)
    command.checkApiEnabled = async () => true
    token = null
    assert.equal(await command.updateHistory(event('/phi updateHistory')), false)
    assert.match(messages.at(-1), /先绑定/)
    token = 'A'.repeat(25)
    history = { scoreHistory: {}, data: [], rks: [], challengeModeRank: [] }
    assert.equal(await command.updateHistory(event('/phi updateHistory')), true)
    assert.match(messages.at(-1), /暂无/)
    assert.equal(uploads, 0)
    history = sampleHistory
    assert.equal(await command.updateHistory(event('/phi updateHistory')), false)
    assert.equal(uploads, 1)
    assert.equal(messages.some(message => /已上传/.test(message)), false)
})

test('local tag commands add, change and cancel only the caller vote through real handlers', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phi-business-tags-'))
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
    const store = new ChartTagStore(path.join(directory, 'tags.json'))
    const messages = [], originalConfig = Config.getUserCfg
    t.mock.method(Config, 'getUserCfg', (name, key) => key === 'allowChartTag' ? true : originalConfig.call(Config, name, key))
    t.mock.method(getBanGroup, 'get', async () => false)
    t.mock.method(send, 'send_with_At', async (_event, message) => messages.push(message))
    t.mock.method(getInfo, 'fuzzysongsnick', () => ['Synthetic.0'])
    t.mock.method(getInfo, 'info', () => ({ id: 'Synthetic.0', song: 'Synthetic', chart: { IN: {} } }))
    t.mock.method(getChartTag, 'add', (...args) => store.add(...args))
    t.mock.method(getChartTag, 'cancel', (...args) => store.cancel(...args))
    const command = new phisong()
    await command.addtag(event('/phi addtag Synthetic IN 底力', 'first'))
    await command.addtag(event('/phi addtag Synthetic IN 底力', 'second'))
    assert.equal(store.get('Synthetic.0', 'IN')[0].value, 2)
    await command.addtag(event('/phi subtag Synthetic IN 底力', 'first'))
    assert.equal(store.get('Synthetic.0', 'IN', true)[0].value, 0)
    await command.addtag(event('/phi retag Synthetic IN 底力', 'first'))
    assert.equal(store.get('Synthetic.0', 'IN')[0].value, 1)
    assert.deepEqual(store.vote('Synthetic.0', 'IN', '底力'), { agree: ['second'], disagree: [] })
    assert.ok(messages.every(message => /已更新/.test(message)))
    const before = await fs.promises.readFile(store.filePath, 'utf8')
    await command.addtag(event('/phi addtag Synthetic IN 1234567'))
    assert.match(messages.at(-1), /1 至 6/)
    assert.equal(await fs.promises.readFile(store.filePath, 'utf8'), before)
    assert.equal(store.cancel('NeverSeen.0', '底力', 'IN', 'absent'), true)
    assert.deepEqual(store.get('NeverSeen.0', 'IN'), [])
})

test('restore selection snapshots file ordering and rejects blank, fractional and expired choices', async t => {
    const messages = [], restored = []
    const originalReadDir = fs.readdirSync, originalExists = fs.existsSync
    let names = ['b.zip', 'a.zip']
    t.mock.method(fs, 'existsSync', file => file === backupPath ? true : originalExists(file))
    t.mock.method(fs, 'readdirSync', (file, options) => file === backupPath ? names.map(name => ({ name, isFile: () => true })) : originalReadDir(file, options))
    t.mock.method(send, 'send_with_At', async (_event, message) => messages.push(message))
    t.mock.method(getBackup, 'restore', async file => { restored.push(file) })
    const command = new phiset()
    command.setContext = () => {}
    command.finish = () => {}
    await command.restore(event('/phi restore'))
    assert.match(messages.at(-1), /\[0\]a.zip/)
    names = ['new.zip']
    command.e = event('0')
    await command.doRestore()
    assert.deepEqual(restored, [path.join(backupPath, 'a.zip')])
    assert.match(messages.at(-1), /a.zip 恢复成功/)
    for (const invalid of ['', '-1', '0.5', '1e0', '99']) {
        await command.restore(event('/phi restore'))
        command.e = event(invalid)
        await command.doRestore()
        assert.match(messages.at(-1), /序号无效/)
    }
    await command.restore(event('/phi restore'))
    for (const choice of command.restoreChoices.values()) choice.expiresAt = 0
    command.e = event('0')
    await command.doRestore()
    assert.match(messages.at(-1), /已过期/)
    assert.equal(restored.length, 1)
})

test('save repositories reject path-like identities before reads, writes or recursive removal', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phi-business-paths-'))
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
    const paths = new LocalDataDirectory(directory)
    for (const invalid of ['.', '..', '../other', 'x/y', 'x\\y', '/absolute', '', 'A'.repeat(257)]) {
        assert.throws(() => paths.directory(invalid), /标识无效/)
        if (invalid) {
            await assert.rejects(getSave.deleteSaveBySessionToken(invalid), /格式错误/)
            assert.throws(() => getSaveFromApi.deleteSaveByApiId(invalid), /标识无效/)
        }
    }
    await fs.promises.symlink(path.join(directory, 'nonexistent'), path.join(directory, 'linked'))
    assert.throws(() => paths.directory('linked'), /符号链接/)
})
