import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { TemplateRenderer } from '../src/renderer.mjs'
import { BrowserResolver } from '../src/browser.mjs'
import { FileWatcherRegistry } from '../components/FileWatcherRegistry.js'

test('template cleanup owns generated files only and preserves source and unrelated HTML', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-template-owner-'))
  const source = path.join(dir, 'source.art'), unrelated = path.join(dir, 'external.html')
  try {
    await fs.writeFile(source, '<div>{{value}}</div>')
    await fs.writeFile(unrelated, 'external')
    const renderer = new TemplateRenderer(); renderer.dir = dir
    const first = renderer.dealTpl('first', { tplFile: source, value: '<secret>' })
    const second = renderer.dealTpl('second', { tplFile: source, value: 'second' })
    assert.equal(renderer.releaseTemplate(source), false)
    assert.equal(renderer.releaseTemplate(unrelated), false)
    assert.equal(renderer.releaseTemplate(first), true)
    assert.equal(renderer.releaseTemplate(first), false)
    renderer.closeTemplates()
    assert.equal(renderer.generatedFiles.size, 0)
    await assert.rejects(fs.access(second), { code: 'ENOENT' })
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'external')
    assert.match(await fs.readFile(source, 'utf8'), /{{value}}/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

for (const fail of [false, true]) {
  test(`screenshot ${fail ? 'failure' : 'success'} removes its private rendered HTML`, async () => {
    const { default: Puppeteer } = await import('../model/render/puppeteer.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-screenshot-owner-'))
    const source = path.join(dir, 'source.art')
    const renderer = new Puppeteer({ idleTimeout: 0 })
    let generated
    try {
      await fs.writeFile(source, '<div>{{value}}</div>')
      renderer.dir = dir
      renderer.browserInit = async () => true
      renderer.browser = { newPage: async () => ({ isClosed: () => true }) }
      renderer.restart = async () => false
      renderer.renderPage = async (_page, _name, file) => {
        generated = file
        assert.match(await fs.readFile(file, 'utf8'), /private score/)
        if (fail) throw new Error('render failed')
        return [Buffer.from('image')]
      }
      const result = await renderer.screenshot('test/help', { tplFile: source, value: 'private score' })
      assert.deepEqual(result, fail ? false : Buffer.from('image'))
      await assert.rejects(fs.access(generated), { code: 'ENOENT' })
      assert.equal(renderer.generatedFiles.size, 0)
      await fs.access(source)
    } finally { renderer.browser = false; await renderer.shutdown(); await fs.rm(dir, { recursive: true, force: true }) }
  })
}

function watcherFixture() {
  const watchers = [], errors = []
  const registry = new FileWatcherRegistry({ watch: () => {
    const watcher = new EventEmitter()
    watcher.close = async () => { watcher.closed = true }
    watchers.push(watcher)
    return watcher
  }, onError: error => errors.push(error) })
  return { registry, watchers, errors }
}

test('watcher initialization errors and premature close settle ready without unhandled events', async () => {
  const { registry, watchers, errors } = watcherFixture()
  try {
    const failed = registry.watch('failure', '/unused/a', () => {})
    watchers[0].emit('error', new Error('watch failed'))
    await assert.rejects(failed.ready, /watch failed/)
    assert.equal(errors.length, 1)
    const closed = registry.watch('closed', '/unused/b', () => {})
    await closed.close()
    await assert.rejects(closed.ready, { code: 'PHI_WATCHER_CLOSED' })
  } finally { await registry.closeAll() }
})

test('watcher callback failures and replaced-watcher close failures remain observable and bounded', async () => {
  const { registry, watchers, errors } = watcherFixture()
  const gate = Promise.withResolvers()
  try {
    registry.watch('same', '/unused/a', async () => { throw new Error('callback failed') })
    watchers[0].emit('change', 'a')
    await new Promise(resolve => setImmediate(resolve))
    assert.match(errors[0].message, /callback failed/)
    watchers[0].close = async () => { await gate.promise; throw new Error('close failed') }
    const replacement = registry.watch('same', '/unused/b', () => {})
    watchers[1].emit('ready')
    await replacement.ready
    let closed = false
    const closing = registry.closeAll().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false, 'closeAll must include retired watchers still closing')
    gate.resolve()
    await closing
    assert.ok(errors.some(error => /close failed/.test(error.message)))
    assert.equal(registry.closing.size, 0)
  } finally { gate.resolve(); await registry.closeAll() }
})

test('changing watcher events or options replaces an otherwise identical path', async () => {
  const { registry, watchers } = watcherFixture()
  try {
    registry.watch('same', '/unused/a', () => {})
    registry.watch('same', '/unused/a', () => {}, ['change', 'unlink'])
    registry.watch('same', '/unused/a', () => {}, ['change', 'unlink'], { ignoreInitial: true })
    assert.equal(watchers.length, 3)
  } finally { await registry.closeAll() }
})

test('browser installs coalesce per cache directory and retry after failures', async () => {
  const requests = [], gate = Promise.withResolvers()
  let fail = false
  const resolver = new BrowserResolver({ candidates: () => [], platform: () => 'linux', buildId: 'test',
    installBrowser: async options => {
      requests.push(options)
      await gate.promise
      if (fail) throw new Error('download failed')
      return { executablePath: path.join(options.cacheDir, 'chrome') }
    } })
  const first = resolver.resolve('/tmp/phi-a'), shared = resolver.resolve('/tmp/phi-a'), second = resolver.resolve('/tmp/phi-b')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 2)
  gate.resolve()
  assert.deepEqual(await Promise.all([first, shared, second]), ['/tmp/phi-a/browser/chrome', '/tmp/phi-a/browser/chrome', '/tmp/phi-b/browser/chrome'])
  assert.equal(resolver.pending.size, 0)
  fail = true
  await assert.rejects(resolver.resolve('/tmp/phi-a'), /download failed/)
  fail = false
  assert.equal(await resolver.resolve('/tmp/phi-a'), '/tmp/phi-a/browser/chrome')
})

test('browser detection rejects non-executable candidates and unsupported automatic platforms', async () => {
  let installs = 0
  const resolver = new BrowserResolver({ candidates: () => ['/directory', '/good/chrome'], executable: file => file === '/good/chrome',
    installBrowser: async () => { installs++; throw new Error('must not install') } })
  assert.equal(await resolver.resolve('/unused'), '/good/chrome')
  assert.equal(installs, 0)
  const unsupported = new BrowserResolver({ candidates: () => [], platform: () => undefined })
  await assert.rejects(unsupported.resolve('/unused'), /不支持自动安装/)
})

test('render errors never expose internal paths or credential text to the user', async () => {
  const { default: pictures } = await import('../model/render/picmodle.js')
  const internal = 'Authorization: Bearer private-access-key /private/data/path'
  const pool = Object.assign(Object.create(Object.getPrototypeOf(pictures)), {
    idle: [0], waiters: [], rendering: new Set(), shuttingDown: false,
    tot: 0, pressureFailed: 0, pressureMaxActive: 0,
    puppeteer: [{ screenshot: async () => { throw new Error(internal) } }],
  })
  const reply = await pool.render('test/image', {}, { scale: 1 })
  assert.match(reply, /图片生成失败/)
  assert.doesNotMatch(reply, /private-access-key|private\/data|Authorization/)
  assert.deepEqual(pool.idle, [0])
  assert.equal(pool.rendering.size, 0)
})
