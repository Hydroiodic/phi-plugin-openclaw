import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { buildIllustrations } from '../scripts/build-illustrations.mjs'
import { IllustrationRepository, illustrationReference, validateIllustrationIndex, parseIllustrationChecksums } from '../src/illustrations.mjs'
import { ResourceRepository, ensureResources, REQUIRED_INFO, sha256 } from '../src/resources.mjs'
import { buildResources } from '../scripts/build-resources.mjs'
import { OpenClawPlatform } from '../src/platform.mjs'
import { serveRepository } from './resource-server.mjs'
import { verifyIllustrations } from '../scripts/verify-resources.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=', 'base64')
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-shared-art-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'illustrations'), output = path.join(root, 'public')
  await fs.mkdir(path.join(input, 'ill'), { recursive: true })
  for (const name of ['曲目 A.png', 'duplicate.png']) await fs.writeFile(path.join(input, 'ill', name), png)
  const built = await buildIllustrations({ input, output })
  const server = await serveRepository(output)
  t.after(() => server.close())
  const config = { resourceBaseUrl: server.url }, dataRoot = path.join(root, 'state')
  const cacheRoot = new ResourceRepository({ config, dataRoot, env: {} }).root
  const warnings = []
  const create = () => {
    const repo = new IllustrationRepository({ baseUrl: server.url, cacheRoot, logger: { warn: text => warnings.push(text) } })
    t.after(() => repo.close()); return repo
  }
  return { root, input, output, built, server, config, dataRoot, cacheRoot, create, warnings,
    reference: illustrationReference('ill', '曲目 A.png'), index: JSON.parse(await fs.readFile(path.join(output, 'illustrations/index.json'), 'utf8')) }
}

test('shared catalog is version-free, content-addressed, deduplicated and reproducible', async t => {
  const f = await fixture(t)
  assert.equal(f.built.files, 2); assert.equal(f.built.objects, 1)
  assert.equal(Object.hasOwn(f.index, 'version'), false)
  assert.equal(Object.hasOwn(f.index, 'createdAt'), false)
  assert.equal(f.index.files['ill/曲目 A.png'].path, f.index.files['ill/duplicate.png'].path)
  const bytes = await fs.readFile(path.join(f.output, 'illustrations/index.json'))
  await buildIllustrations({ input: f.input, output: f.output })
  assert.deepEqual(await fs.readFile(path.join(f.output, 'illustrations/index.json')), bytes)
  assert.deepEqual(await fs.readdir(f.output), ['illustrations'])
})

test('catalog rejects unsafe names, object hashes, sizes and duplicate checksums', async t => {
  const f = await fixture(t)
  for (const mutate of [
    x => { x.files['../bad.png'] = x.files['ill/曲目 A.png'] },
    x => { x.files['ill/DUPLICATE.png'] = x.files['ill/duplicate.png'] },
    x => { x.files['ill/duplicate.png'].path = 'v/3.20.0/image.png' },
    x => { x.files['ill/duplicate.png'].bytes = 0 },
    x => { x.files['ill/duplicate.png'].bytes++ },
    x => { x.archives[0].sha256 = 'bad' },
    x => { x.archives = [] },
  ]) { const index = structuredClone(f.index); mutate(index); assert.throws(() => validateIllustrationIndex(index)) }
  assert.throws(() => parseIllustrationChecksums(Buffer.from(`${'a'.repeat(64)}  index.json\n`.repeat(2))))
})

test('lazy fetch deduplicates simultaneous aliases, verifies bytes and reuses offline cache', async t => {
  const f = await fixture(t), repo = f.create()
  const files = await Promise.all([f.reference, f.reference, illustrationReference('ill', 'duplicate.png')].map(ref => repo.resolve(ref)))
  assert.equal(new Set(files).size, 1)
  assert.deepEqual(await fs.readFile(files[0]), png)
  assert.equal(f.server.requests.filter(url => url.includes('/objects/')).length, 1)
  assert.equal(f.server.requests.some(url => url.endsWith('.zip')), false)
  await f.server.close()
  assert.equal(await f.create().resolve(f.reference), files[0])
})

test('corrupt cache refetches; corrupt downloads never become renderable images', async t => {
  const f = await fixture(t), repo = f.create(), local = await repo.resolve(f.reference)
  await fs.writeFile(local, 'broken')
  assert.equal(await repo.resolve(f.reference), local)
  assert.deepEqual(await fs.readFile(local), png)
  await fs.unlink(local)
  const object = path.join(f.output, 'illustrations', f.index.files['ill/曲目 A.png'].path)
  await fs.writeFile(object, Buffer.alloc(png.length))
  await assert.rejects(repo.resolve(f.reference), /SHA-256/)
  assert.equal(await fs.stat(local).catch(() => null), null)
  assert.equal(await repo.prepare(f.reference), repo.fallback)
  assert.equal(await repo.prepare(f.reference), repo.fallback)
  assert.equal(f.warnings.length, 1)
})

test('full packages and individual downloads share one verified object cache', async t => {
  const f = await fixture(t), repo = f.create()
  const installed = await repo.installAll()
  assert.equal(installed.files, 2)
  const count = f.server.requests.length
  assert.deepEqual(await fs.readFile(await repo.resolve(f.reference)), png)
  assert.equal(f.server.requests.length, count)
  const zipCount = f.server.requests.filter(url => url.endsWith('.zip')).length
  assert.equal((await repo.installAll()).downloaded, 0)
  assert.equal(f.server.requests.filter(url => url.endsWith('.zip')).length, zipCount)
})

test('corrupt catalog and ZIP are rejected without replacing cached images', async t => {
  const f = await fixture(t), repo = f.create(), local = await repo.resolve(f.reference)
  const catalog = path.join(f.output, 'illustrations/index.json'), original = await fs.readFile(catalog)
  await fs.writeFile(catalog, '{}')
  await assert.rejects(repo.loadIndex({ refresh: true }), /SHA-256/)
  assert.equal(await repo.resolve(f.reference), local)
  await fs.writeFile(catalog, original)
  await fs.unlink(local)
  await fs.writeFile(path.join(f.output, 'illustrations', f.index.archives[0].path), 'bad ZIP')
  await assert.rejects(repo.installAll(), /SHA-256/)
  assert.equal(await fs.stat(local).catch(() => null), null)
  assert.equal((await fs.readdir(repo.root)).some(name => name.startsWith('.download-')), false)
})

test('game upgrades reuse the shared artwork without embedding it in version manifests', async t => {
  const f = await fixture(t), info = path.join(f.root, 'song-data')
  await fs.mkdir(path.join(info, 'DLC'), { recursive: true }); await fs.mkdir(path.join(info, 'oldInfo'))
  for (const name of REQUIRED_INFO) {
    await fs.mkdir(path.dirname(path.join(info, name)), { recursive: true })
    await fs.writeFile(path.join(info, name), name.endsWith('.json') ? '{}' : 'fixture')
  }
  await buildResources({ info, output: f.output, version: '3.20.0', gameCode: 154 })
  const first = await ensureResources({ config: f.config, dataRoot: f.dataRoot, env: {} })
  const local = await f.create().resolve(f.reference)
  await buildResources({ info, output: f.output, version: '3.21.0', gameCode: 155 })
  const second = await ensureResources({ config: f.config, dataRoot: f.dataRoot, env: {}, refresh: true })
  assert.notEqual(first.infoPath, second.infoPath)
  assert.equal(first.illustrationPath, second.illustrationPath)
  const count = f.server.requests.length
  assert.equal(await f.create().resolve(f.reference), local)
  assert.equal(f.server.requests.length, count)
  assert.deepEqual(Object.keys(second.manifest.packages), ['song-data'])
  assert.notEqual(new ResourceRepository({ config: { resourceBaseUrl: f.server.url + 'mirror/' }, dataRoot: f.dataRoot, env: {} }).root, f.cacheRoot)
})

test('a new song refreshes the shared catalog without a game-version dependency', async t => {
  const f = await fixture(t), repo = f.create(), local = await repo.resolve(f.reference)
  for (const name of ['new.png', 'newer.png']) await fs.writeFile(path.join(f.input, 'ill', name), png)
  await buildIllustrations({ input: f.input, output: f.output })
  assert.deepEqual(await Promise.all(['new.png', 'newer.png'].map(name => repo.resolve(illustrationReference('ill', name)))), [local, local])
  assert.equal(f.server.requests.filter(url => url.includes('/objects/')).length, 1)
})

test('preparation preserves prototypes, aliases and cyclic render data without mutating input', async t => {
  const f = await fixture(t), repo = f.create()
  class Record { get name() { return 'record' } }
  const item = Object.assign(new Record(), { illustration: f.reference, buffer: png }), input = { item, items: [item] }; input.self = input
  const output = await repo.prepare(input)
  assert.notEqual(output, input); assert.equal(output.self, output)
  assert.equal(output.item, output.items[0]); assert.equal(output.item.name, 'record')
  assert.equal(output.item.buffer, png); assert.equal(input.item.illustration, f.reference)
  assert.deepEqual(await fs.readFile(output.item.illustration), png)
})

test('direct image replies receive verified local bytes, not opaque references or remote URLs', async t => {
  const f = await fixture(t), platform = new OpenClawPlatform({ dataRoot: path.join(f.root, 'platform') })
  platform.illustrations = f.create(); t.after(() => platform.close())
  const payload = await platform.payload(platform.segment.image(f.reference))
  assert.equal(payload.mediaUrls.length, 1)
  assert.deepEqual(await fs.readFile(payload.mediaUrls[0]), png)
})

test('cache symlinks, source symlinks and corrupt published hash objects fail safely', async t => {
  const f = await fixture(t), repo = f.create()
  await fs.mkdir(f.cacheRoot, { recursive: true })
  await fs.symlink(f.input, repo.root)
  await assert.rejects(repo.loadIndex(), /符号链接/)
  await fs.unlink(repo.root)
  await fs.symlink(path.join(f.input, 'ill/duplicate.png'), path.join(f.input, 'ill/link.png'))
  await assert.rejects(buildIllustrations({ input: f.input, output: f.output }), /符号链接/)
  await fs.unlink(path.join(f.input, 'ill/link.png'))
  const object = path.join(f.output, 'illustrations', f.index.files['ill/duplicate.png'].path)
  await fs.writeFile(object, 'bad')
  await assert.rejects(buildIllustrations({ input: f.input, output: f.output }), /哈希不符/)
  assert.equal(sha256(await fs.readFile(path.join(f.output, 'illustrations/index.json'))), sha256(Buffer.from(JSON.stringify(f.index, null, 2) + '\n')))
})

test('closing the image service aborts an in-flight transfer and prevents later use', async t => {
  const f = await fixture(t)
  let connected; const started = new Promise(resolve => { connected = resolve })
  const server = http.createServer((_req, res) => { res.writeHead(200); res.flushHeaders(); connected() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const repo = new IllustrationRepository({ baseUrl: `http://127.0.0.1:${server.address().port}/`, cacheRoot: path.join(f.root, 'abort') })
  const pending = repo.resolve(f.reference); const rejected = assert.rejects(pending)
  await started; await repo.close(); await rejected
  await assert.rejects(repo.resolve(f.reference), /关闭/)
})

test('standalone verifier checks ZIPs, objects, source hashes and missing files', async t => {
  const f = await fixture(t)
  const reader = { root: f.output, remote: false, async read(relative) { return { bytes: await fs.readFile(path.join(f.output, relative)) } } }
  assert.equal((await verifyIllustrations(reader, () => {})).files, 2)
  const source = path.join(f.input, 'ill/duplicate.png')
  await fs.writeFile(source, 'changed')
  await assert.rejects(verifyIllustrations(reader, () => {}), /内容不一致/)
  await fs.writeFile(source, png)
  const object = path.join(f.output, 'illustrations', f.index.files['ill/duplicate.png'].path)
  await fs.writeFile(object, Buffer.alloc(png.length))
  await assert.rejects(verifyIllustrations(reader, () => {}), /SHA-256/)
  await fs.writeFile(object, png)
  const archive = path.join(f.output, 'illustrations', f.index.archives[0].path)
  await fs.writeFile(archive, 'bad')
  await assert.rejects(verifyIllustrations(reader, () => {}), /大小不符/)
  await fs.unlink(archive)
  await assert.rejects(verifyIllustrations(reader, () => {}), /ENOENT/)
})
