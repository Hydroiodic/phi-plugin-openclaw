import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import JSZip from 'jszip'
import { ResourceRepository, ResourceError, resourceOptions, ensureResources, listResourceVersions, extractArchive, REQUIRED_INFO, sha256, validateManifest, validateResourceIndex } from '../src/resources.mjs'
import { buildResources } from '../scripts/build-resources.mjs'
import { IllustrationRepository, illustrationReference } from '../src/illustrations.mjs'
import { serveRepository } from './resource-server.mjs'

async function fixture(t, version = '3.20.0') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-resource-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const info = path.join(root, 'input'), output = path.join(root, 'public'), dataRoot = path.join(root, 'state')
  for (const name of [...REQUIRED_INFO, 'DLC/test.json', 'oldInfo/test.json']) {
    await fs.mkdir(path.dirname(path.join(info, name)), { recursive: true })
    await fs.writeFile(path.join(info, name), name.endsWith('.json') ? '{}' : 'fixture')
  }
  const build = extra => buildResources({ output, version, gameVersion: '3.20.0', gameCode: 154, info, ...extra })
  await build()
  const server = await serveRepository(output)
  t.after(() => server.close())
  return { root, info, output, dataRoot, build, server, config: { resourceBaseUrl: server.url } }
}

test('resource options: environment override, pin validation, HTTPS and credential policy', () => {
  assert.equal(resourceOptions({ resourceBaseUrl: 'https://example.com/custom' }, {}).baseUrl, 'https://example.com/custom/')
  assert.equal(resourceOptions({ resourceBaseUrl: 'https://ignored.example' }, { PHI_RESOURCE_BASE_URL: 'https://mirror.example/prefix/', PHI_RESOURCE_VERSION: '3.20.0-r2' }).version, '3.20.0-r2')
  for (const resourceBaseUrl of ['http://example.com/', 'file:///tmp/', 'https://user:secret@example.com/', 'https://example.com/?token=secret']) assert.throws(() => resourceOptions({ resourceBaseUrl }, {}))
  assert.throws(() => resourceOptions({ resourceVersion: '../../escape' }, {}))
})

test('game-version resource IDs match the OpenClaw schema and reject the old date scheme', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'))
  const pattern = new RegExp(schema.configSchema.properties.resourceVersion.pattern)
  for (const version of ['latest', '3.20.0', '3.20.0-r1', '3.20.0-r10']) {
    assert.equal(pattern.test(version), true)
    assert.equal(resourceOptions({ resourceVersion: version }, {}).version, version)
  }
  for (const version of ['2026.09.20.1', '03.20.0', '3.020.0', '3.20', '3.20.0-r0', '3.20.0-r01', '3.20.0/../escape']) {
    assert.equal(pattern.test(version), false)
    assert.throws(() => resourceOptions({ resourceVersion: version }, {}))
  }
})

test('publisher derives the game version, checks consistency and sorts numeric game versions', async t => {
  const f = await fixture(t)
  await f.build({ version: '3.9.0', gameVersion: undefined })
  const release = await f.build({ version: '3.20.10', gameVersion: undefined })
  await f.build({ version: '3.20.2', gameVersion: undefined })
  assert.equal(release.manifest.game.version, '3.20.10')
  assert.equal(Object.hasOwn(release.manifest, 'createdAt'), false)
  const latest = JSON.parse(await fs.readFile(path.join(f.output, 'latest.json'), 'utf8'))
  assert.equal(latest.version, '3.20.10')
  assert.equal(Object.hasOwn(latest, 'date'), false)
  assert.equal((await fs.readFile(path.join(f.output, 'index.tab'), 'utf8')).split('\n')[0], 'version\tphigros\tcode\tpackages')
  assert.deepEqual((await listResourceVersions(f.config, {})).map(entry => entry.version), ['3.20.10', '3.20.2', '3.20.0', '3.9.0'])
  await assert.rejects(f.build({ version: '3.21.0', gameVersion: '3.20.0' }), /相同的游戏版本/)
  assert.throws(() => validateManifest({ ...release.manifest, game: { version: '3.20.0', code: 154 } }), /游戏版本一致/)
})

test('publish, list, download, persistent offline cache and concurrent first use', async t => {
  const f = await fixture(t)
  assert.equal((await listResourceVersions(f.config, {}))[0].version, '3.20.0')
  const results = await Promise.all([1, 2].map(() => ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })))
  assert.equal(results[0].infoPath, results[1].infoPath)
  assert.equal(f.server.requests.filter(url => url.endsWith('.zip')).length, 1)
  assert.equal(await fs.readFile(path.join(results[0].infoPath, 'info.csv'), 'utf8'), 'fixture')
  const count = f.server.requests.length
  await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })
  assert.equal(f.server.requests.length, count)
  await assert.rejects(f.build(), /禁止覆盖/)
  await f.server.close()
  assert.equal((await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })).manifest.version, '3.20.0')
})

test('resource minimum plugin version is enforced without release-specific exceptions', async t => {
  const f = await fixture(t)
  const manifest = JSON.parse(await fs.readFile(path.join(f.output, 'v/3.20.0/metadata.json'), 'utf8'))
  assert.equal(manifest.minPluginVersion, '0.1.0')
  assert.doesNotThrow(() => validateManifest(manifest))
  for (const minPluginVersion of ['0.1.1', '0.2.0', '1.0.0', '1.0.1', '2.0.0']) {
    assert.throws(() => validateManifest({ ...manifest, minPluginVersion }), /更新的插件版本/)
  }
  assert.throws(() => validateManifest({ ...manifest, version: '3.20.0-r1', minPluginVersion: '1.0.0' }), /更新的插件版本/)
})

test('refresh, pinned rollback, numeric latest ordering and mirror isolation', async t => {
  const f = await fixture(t)
  await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })
  await f.build({ version: '3.20.0-r10' })
  await f.build({ version: '3.20.0-r2' })
  assert.equal((await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })).manifest.version, '3.20.0')
  assert.equal((await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {}, refresh: true })).manifest.version, '3.20.0-r10')
  assert.equal((await ensureResources({ dataRoot: f.dataRoot, config: { ...f.config, resourceVersion: '3.20.0-r2' }, env: {} })).manifest.version, '3.20.0-r2')
  await assert.rejects(ensureResources({ dataRoot: f.dataRoot, config: { resourceBaseUrl: f.server.url + 'missing/' }, env: {} }), /HTTP 404/)
})

test('damaged archive fails integrity and leaves the active release usable', async t => {
  const f = await fixture(t)
  const installed = await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })
  const update = await f.build({ version: '3.20.0-r1' })
  await fs.writeFile(path.join(f.output, update.manifest.packages['song-data'].archives[0].path), 'bad ZIP')
  await assert.rejects(ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {}, refresh: true }), /SHA-256/)
  assert.equal((await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })).infoPath, installed.infoPath)
})

test('optional illustration packages and game metadata are downloaded independently', async t => {
  const f = await fixture(t)
  const illustrations = path.join(f.root, 'art'); await fs.mkdir(path.join(illustrations, 'ill'), { recursive: true })
  await fs.writeFile(path.join(illustrations, 'ill', 'fixture.png'), 'fake-test-image')
  await f.build({ version: '3.20.0-r1', illustrations, partBytes: 16000 })
  const plain = await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })
  assert.equal(plain.manifest.game.code, 154)
  assert.equal(f.server.requests.filter(url => /illustrations.*zip$/.test(url)).length, 0)
  const full = await ensureResources({ dataRoot: f.dataRoot, config: { ...f.config, downloadIllustrations: true }, env: {} })
  assert.deepEqual(Object.keys(full.manifest.packages), ['song-data'])
  assert.equal(full.illustrationPath.includes('/v/'), false)
  const images = new IllustrationRepository(full)
  t.after(() => images.close())
  assert.equal(await fs.readFile(await images.resolve(illustrationReference('ill', 'fixture.png')), 'utf8'), 'fake-test-image')
  assert.equal(f.server.requests.filter(url => /song-data.*zip$/.test(url)).length, plain.manifest.packages['song-data'].archives.length)
})

test('ZIP rejects traversal, symlinks, executable files, expansion mismatch and cross-part duplicate names', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-resource-zip-')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const [name, options, limit] of [['../escape.json', {}, 10], ['evil.json', { unixPermissions: 0o120777 }, 10], ['evil.js', {}, 10], ['large.json', {}, 1]]) {
    const zip = new JSZip(); zip.file(name, '1234567890', options)
    const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
    await assert.rejects(extractArchive(bytes, { bytes: bytes.length, sha256: sha256(bytes), unpackedBytes: limit, fileCount: 1 }, root, 'song-data'))
  }
  const zip = new JSZip(); zip.file('safe.json', '{}')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }), archive = { bytes: bytes.length, sha256: sha256(bytes), unpackedBytes: 2, fileCount: 1 }, seen = new Set()
  await extractArchive(bytes, archive, root, 'song-data', seen)
  await assert.rejects(extractArchive(bytes, archive, root, 'song-data', seen), /重复/)
})

test('resource cache recovers a corrupt current pointer without redownloading or overwriting installed data', async t => {
  const f = await fixture(t)
  const repository = new ResourceRepository({ dataRoot: f.dataRoot, config: f.config, env: {} })
  const installed = await repository.ensure()
  const count = f.server.requests.filter(url => url.endsWith('.zip')).length
  await fs.writeFile(path.join(repository.root, 'current.json'), '{invalid')
  assert.equal((await repository.ensure()).infoPath, installed.infoPath)
  assert.equal(f.server.requests.filter(url => url.endsWith('.zip')).length, count)
  await fs.writeFile(path.join(installed.infoPath, '.complete.json'), '{invalid')
  await assert.rejects(repository.ensure(), /手动移走损坏缓存/)
  assert.equal(await fs.readFile(path.join(installed.infoPath, 'info.csv'), 'utf8'), 'fixture')
})

test('resource cache serializes different options and retries cleanly after a failed request', async t => {
  const f = await fixture(t)
  const illustrations = path.join(f.root, 'art')
  await fs.mkdir(path.join(illustrations, 'ill'), { recursive: true })
  await fs.writeFile(path.join(illustrations, 'ill/sample.png'), 'image')
  const release = await f.build({ version: '3.20.0-r1', illustrations })
  const [plain, full] = await Promise.all([
    ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} }),
    ensureResources({ dataRoot: f.dataRoot, config: { ...f.config, downloadIllustrations: true }, env: {} }),
  ])
  assert.equal(plain.infoPath, full.infoPath)
  assert.equal(f.server.requests.filter(url => /song-data.*zip$/.test(url)).length, release.manifest.packages['song-data'].archives.length)
  const update = await f.build({ version: '3.20.0-r2' })
  const archive = path.join(f.output, update.manifest.packages['song-data'].archives[0].path)
  const original = await fs.readFile(archive)
  await fs.writeFile(archive, 'broken')
  await assert.rejects(ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {}, refresh: true }), /SHA-256/)
  await fs.writeFile(archive, original)
  assert.equal((await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {}, refresh: true })).manifest.version, '3.20.0-r2')
  await assert.rejects(ensureResources({ dataRoot: f.dataRoot, config: { ...f.config, resourceVersion: '9.0.0' }, env: {} }), /未发布版本 9\.0\.0/)
})

test('malformed metadata produces resource errors and rejects duplicate version pointers', async t => {
  const f = await fixture(t)
  const valid = JSON.parse(await fs.readFile(path.join(f.output, 'v/3.20.0/metadata.json'), 'utf8'))
  for (const packages of [null, [], { 'song-data': {} }, { 'song-data': { archives: [null] } }, { 'song-data': valid.packages['song-data'], illustrations: null }]) {
    assert.throws(() => validateManifest({ ...valid, packages }), ResourceError)
  }
  assert.throws(() => resourceOptions({ resourceBaseUrl: 'not a URL' }, {}), ResourceError)
  const index = JSON.parse(await fs.readFile(path.join(f.output, 'index.json'), 'utf8'))
  assert.throws(() => validateResourceIndex({ ...index, releases: [...index.releases, ...index.releases] }), /重复版本/)
  assert.throws(() => validateResourceIndex({ ...index, releases: [{ ...index.releases[0], packages: 'song-data' }] }), ResourceError)
})

test('interrupted and oversized HTTP responses produce bounded, actionable errors', async t => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/large/')) { res.writeHead(200, { 'Content-Length': 3 * 1024 * 1024 }).end('tiny'); return }
    res.writeHead(200, { 'Content-Length': 100 })
    res.flushHeaders()
    res.write('{')
    setImmediate(() => res.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/`
  await assert.rejects(listResourceVersions({ resourceBaseUrl: base }, {}), /资源请求失败或传输中断/)
  await assert.rejects(listResourceVersions({ resourceBaseUrl: `${base}large/` }, {}), /大小限制/)
})

test('publisher preserves required empty directories and produces reproducible ZIPs', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.info, 'DLC/test.json'))
  await fs.unlink(path.join(f.info, 'oldInfo/test.json'))
  const first = await f.build({ version: '3.20.0-r1' })
  const second = await f.build({ version: '3.20.0-r1', output: path.join(f.root, 'second') })
  assert.deepEqual(first.manifest, second.manifest)
  const bytes = await fs.readFile(path.join(f.output, first.manifest.packages['song-data'].archives[0].path))
  const zip = await JSZip.loadAsync(bytes)
  for (const entry of Object.values(zip.files)) assert.equal(entry.date.toISOString(), '2000-01-01T00:00:00.000Z', entry.name)
  const installed = await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })
  assert.equal((await fs.stat(path.join(installed.infoPath, 'DLC'))).isDirectory(), true)
  assert.equal((await fs.stat(path.join(installed.infoPath, 'oldInfo'))).isDirectory(), true)
})

test('publisher repacks downloaded metadata without duplicating or changing notices', async t => {
  const f = await fixture(t)
  const initial = await f.build({ version: '3.20.0-r1' })
  const installed = await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })
  const rebuilt = await f.build({ version: '3.20.0-r2', info: installed.infoPath })
  for (const kind of ['song-data']) {
    const content = manifest => manifest.packages[kind].archives.map(({ sha256, bytes, unpackedBytes, fileCount }) => ({ sha256, bytes, unpackedBytes, fileCount }))
    assert.deepEqual(content(rebuilt.manifest), content(initial.manifest), kind)
    const noticeNames = []
    for (const archive of rebuilt.manifest.packages[kind].archives) {
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(f.output, archive.path)))
      noticeNames.push(...Object.values(zip.files).filter(entry => !entry.dir && entry.name.startsWith('LICENSES/phi-plugin-openclaw/')).map(entry => entry.name))
    }
    assert.equal(noticeNames.length, 3)
    assert.equal(new Set(noticeNames).size, 3)
  }
})

test('publisher rejects changed and unknown reserved notices instead of silently replacing them', async t => {
  const f = await fixture(t)
  const installed = await ensureResources({ dataRoot: f.dataRoot, config: f.config, env: {} })
  const noticeDir = path.join(installed.infoPath, 'LICENSES/phi-plugin-openclaw')
  const notice = path.join(noticeDir, 'NOTICE.md'), original = await fs.readFile(notice)
  await fs.writeFile(notice, 'different attribution')
  await assert.rejects(f.build({ version: '3.20.0-r1', info: installed.infoPath }), /说明文件.*不一致.*不能覆盖/)
  assert.equal(await fs.readFile(notice, 'utf8'), 'different attribution')
  await fs.writeFile(notice, original)
  for (const name of ['additional.txt', 'unknown.bin', 'notice.md']) {
    const file = path.join(noticeDir, name)
    await fs.writeFile(file, original)
    await assert.rejects(f.build({ version: '3.20.0-r1', info: installed.infoPath }), /保留目录.*未知说明文件/)
    assert.deepEqual(await fs.readFile(file), original)
    await fs.unlink(file)
  }
  assert.equal(await fs.stat(path.join(f.output, 'v/3.20.0-r1')).catch(() => null), null)
  assert.equal((await fs.readdir(f.output)).some(name => name.startsWith('.publish-')), false)
})

test('publisher rejects unsafe and case-colliding paths before committing a version', async t => {
  const f = await fixture(t)
  for (const [name, expected] of [['bad:name.json', /不安全路径/], ['INFO.csv', /文件名重复/]]) {
    await fs.writeFile(path.join(f.info, name), '{}')
    await assert.rejects(f.build({ version: '3.20.0-r1' }), expected)
    assert.equal(await fs.stat(path.join(f.output, 'v/3.20.0-r1')).catch(() => null), null)
    await fs.unlink(path.join(f.info, name))
  }
  await fs.mkdir(path.join(f.info, 'Help'))
  await fs.writeFile(path.join(f.info, 'Help/other.json'), '{}')
  await assert.rejects(f.build({ version: '3.20.0-r1' }), /路径大小写冲突/)
  await assert.rejects(f.build({ output: path.join(f.info, 'public') }), /输出目录不能/)
})

test('publisher lock prevents lost index updates and permits retry without deleting existing releases', async t => {
  const f = await fixture(t)
  const versions = ['3.20.0-r1', '3.20.0-r2']
  const results = await Promise.allSettled(versions.map(version => f.build({ version })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const failed = results.findIndex(result => result.status === 'rejected')
  assert.match(results[failed].reason.message, /已有发布任务/)
  await f.build({ version: versions[failed] })
  assert.deepEqual((await listResourceVersions(f.config, {})).map(entry => entry.version), ['3.20.0-r2', '3.20.0-r1', '3.20.0'])
  assert.equal((await fs.readdir(f.output)).some(name => name.startsWith('.publish-')), false)
})

test('resource CLI reports invalid flags and extra arguments without a stack trace', () => {
  for (const args of [['--unknown'], ['list', 'unexpected']]) {
    const result = spawnSync(process.execPath, ['scripts/resources.mjs', ...args], { encoding: 'utf8', cwd: new URL('../', import.meta.url) })
    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stderr, /\n\s+at /)
    assert.equal(result.stdout, '')
  }
})
