import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { BackupArchive, BackupRestoreService } from '../model/save/backupRestoreService.js'
import getBackup from '../model/save/getBackup.js'
import userCredentialStore from '../model/user/userCredentialStore.js'
import send from '../model/render/send.js'

const token = 'A'.repeat(25)
const history = value => ({
  version: 3,
  scoreHistory: {},
  rks: [{ date: `2026-01-0${value}T00:00:00Z`, value }],
  data: [],
  challengeModeRank: [],
})

async function fixture(t, credentialStore = { setSessionToken: async () => {} }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-business-backup-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const service = new BackupRestoreService({
    saveRoot: path.join(directory, 'save'),
    pluginDataRoot: path.join(directory, 'plugin'),
    credentialStore,
  })
  return { directory, service }
}

test('backup restore awaits file and credential writes, merges history, and keeps newer saves', async t => {
  let finish
  const restored = new Map()
  const { service } = await fixture(t, {
    setSessionToken: async (user, value) => {
      await new Promise(resolve => {
        finish = resolve
      })
      restored.set(user, value)
    },
  })
  const saveFile = path.join(service.saveRoot, token, 'save.json')
  const historyFile = path.join(service.saveRoot, token, 'history.json')
  const newer = { session: token, saveInfo: { modifiedAt: { iso: '2026-02-01T00:00:00Z' } } }
  await service.writeJson(saveFile, newer)
  await service.writeJson(historyFile, history(2))
  const zip = new JSZip()
  zip.file(`saveData/${token}/save.json`, JSON.stringify({ session: token, saveInfo: { modifiedAt: { iso: '2026-01-01T00:00:00Z' } } }))
  zip.file(`saveData/${token}/history.json`, JSON.stringify(history(1)))
  zip.file('pluginData/user.json', JSON.stringify({ money: 42 }))
  zip.file('user_token.json', JSON.stringify({ user: token }))
  const plan = await service.prepare(new BackupArchive(zip))
  let completed = false
  const pending = service.apply(plan).then(() => {
    completed = true
  })
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  finish()
  await pending
  assert.equal(restored.get('user'), token)
  assert.deepEqual(JSON.parse(await fs.readFile(saveFile, 'utf8')), newer)
  assert.deepEqual(
    JSON.parse(await fs.readFile(historyFile, 'utf8')).rks.map(item => item.value),
    [1, 2],
  )
  assert.equal(JSON.parse(await fs.readFile(path.join(service.pluginDataRoot, 'user.json'), 'utf8')).money, 42)
  assert.equal(
    (await fs.readdir(path.dirname(saveFile))).some(name => name.endsWith('.tmp')),
    false,
  )
})

test('backup preflight rejects malformed JSON and tokens before applying any data', async t => {
  const { service } = await fixture(t)
  for (const invalid of ['{ secret: "do-not-echo"', '[]', 'null']) {
    const zip = new JSZip()
    zip.file('pluginData/first.json', '{}')
    zip.file('user_token.json', invalid)
    await assert.rejects(service.prepare(new BackupArchive(zip)), error => {
      assert.doesNotMatch(error.message, /do-not-echo/)
      return /JSON/.test(error.message)
    })
    await assert.rejects(fs.stat(service.pluginDataRoot), { code: 'ENOENT' })
  }
  const zip = new JSZip().file('user_token.json', JSON.stringify({ user: '../invalid' }))
  await assert.rejects(service.prepare(new BackupArchive(zip)), /凭证格式无效/)
})

test('backup validation rejects traversal even after JSZip sanitizes archive names', async () => {
  for (const name of ['../pluginData/user.json', 'pluginData/../../user.json', 'pluginData\\user.json', '/pluginData/user.json']) {
    const zip = new JSZip().file(name, '{}', { createFolders: false })
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }))
    assert.throws(() => new BackupArchive(loaded), /不安全/)
  }
  const symlink = new JSZip().file('pluginData/user.json', 'target', { unixPermissions: 0o120777 })
  assert.throws(() => new BackupArchive(symlink), /符号链接/)
})

test('backup restore refuses symlink destinations and unknown data layouts', async t => {
  const { directory, service } = await fixture(t)
  const outside = path.join(directory, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, service.pluginDataRoot)
  await assert.rejects(service.prepare(new BackupArchive(new JSZip().file('pluginData/user.json', '{}'))), /符号链接/)
  for (const name of ['unexpected.json', 'saveData/invalid/save.json', `saveData/${token}/extra.json`, 'pluginData/nested/user.json']) {
    await assert.rejects(service.prepare(new BackupArchive(new JSZip().file(name, '{}'))), /无法识别/)
  }
  assert.deepEqual(await fs.readdir(outside), [])
})

test('backup reader enforces compressed-expansion budgets and entry count', async () => {
  const zip = await JSZip.loadAsync(
    await new JSZip()
      .file('one', 'a'.repeat(4096))
      .file('two', 'b'.repeat(4096))
      .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  )
  const limited = new BackupArchive(zip, { maxFileBytes: 32 })
  await assert.rejects(limited.read(zip.file('one')), /安全限制/)
  const total = new BackupArchive(zip, { maxTotalBytes: 6000 })
  await total.read(zip.file('one'))
  await assert.rejects(total.read(zip.file('two')), /安全限制/)
  assert.throws(() => new BackupArchive(zip, { maxEntries: 1 }), /文件数量/)
})

test('backup restore propagates credential persistence failures instead of reporting success', async t => {
  const { service } = await fixture(t, {
    setSessionToken: async () => {
      throw new Error('synthetic database failure')
    },
  })
  const plan = await service.prepare(new BackupArchive(new JSZip().file('user_token.json', JSON.stringify({ user: token }))))
  await assert.rejects(service.apply(plan), /database failure/)
})

test('fresh installations can create private, complete backups without user data directories', async t => {
  const { directory } = await fixture(t)
  t.mock.method(userCredentialStore, 'listSessionCredentials', async () => new Map())
  t.mock.method(send, 'send_with_At', async () => true)
  const outputRoot = path.join(directory, 'backups')
  const result = await getBackup.backup(
    { msg: '/phi backup' },
    {
      saveRoot: path.join(directory, 'absent-save'),
      pluginDataRoot: path.join(directory, 'absent-plugin'),
      outputRoot,
      includeThemes: false,
    },
  )
  const file = path.join(outputRoot, result.zipName)
  const zip = await JSZip.loadAsync(await fs.readFile(file))
  assert.deepEqual(JSON.parse(await zip.file('user_token.json').async('string')), {})
  assert.deepEqual(await fs.readdir(outputRoot), [result.zipName])
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
})

test('backup collection skips unexpected files and symlinks instead of archiving their targets', async t => {
  const { directory } = await fixture(t)
  const saveRoot = path.join(directory, 'save'),
    pluginDataRoot = path.join(directory, 'plugin'),
    outputRoot = path.join(directory, 'backups')
  await fs.mkdir(path.join(saveRoot, token), { recursive: true })
  await fs.mkdir(pluginDataRoot)
  await fs.writeFile(path.join(saveRoot, token, 'save.json'), '{}')
  await fs.writeFile(path.join(directory, 'outside.json'), '{"mustNotBeArchived":true}')
  await fs.symlink(path.join(directory, 'outside.json'), path.join(saveRoot, token, 'history.json'))
  await fs.symlink(path.join(directory, 'outside.json'), path.join(pluginDataRoot, 'linked.json'))
  await fs.symlink(directory, path.join(saveRoot, 'B'.repeat(25)))
  await fs.writeFile(path.join(saveRoot, 'unexpected.txt'), 'skip')
  t.mock.method(userCredentialStore, 'listSessionCredentials', async () => new Map())
  t.mock.method(send, 'send_with_At', async () => true)
  const result = await getBackup.backup({ msg: '/phi backup' }, { saveRoot, pluginDataRoot, outputRoot, includeThemes: false })
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(outputRoot, result.zipName)))
  assert.ok(zip.file(`saveData/${token}/save.json`))
  assert.equal(zip.file(`saveData/${token}/history.json`), null)
  assert.equal(zip.file('pluginData/linked.json'), null)
  assert.equal(
    Object.keys(zip.files).some(name => name.includes('unexpected')),
    false,
  )
})

test('archive-stream failures leave no final ZIP or unfinished temporary output', async t => {
  const { directory } = await fixture(t)
  const pluginDataRoot = path.join(directory, 'plugin'),
    outputRoot = path.join(directory, 'backups')
  await fs.mkdir(pluginDataRoot)
  const disappearing = path.join(pluginDataRoot, 'user.json')
  await fs.writeFile(disappearing, '{}')
  t.mock.method(userCredentialStore, 'listSessionCredentials', async () => {
    await fs.unlink(disappearing)
    return new Map()
  })
  t.mock.method(send, 'send_with_At', async () => true)
  await assert.rejects(
    getBackup.backup(
      { msg: '/phi backup' },
      {
        saveRoot: path.join(directory, 'absent-save'),
        pluginDataRoot,
        outputRoot,
        includeThemes: false,
      },
    ),
    { code: 'ENOENT' },
  )
  assert.deepEqual(await fs.readdir(outputRoot), [])
})
