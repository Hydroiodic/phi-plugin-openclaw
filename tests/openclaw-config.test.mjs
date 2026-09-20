import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Config } from '../components/Config.js'
import YamlReader from '../components/YamlReader.js'
import { ProjectVersion } from '../components/Version.js'
import { getPlatformAdapter, setPlatformAdapter } from '../components/platform/state.js'

test('malformed or non-mapping YAML retains last good configuration and recovers on change', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-config-test-'))
  const defaults = path.join(root, 'defaults'), local = path.join(root, 'local')
  fs.mkdirSync(defaults)
  fs.writeFileSync(path.join(defaults, 'config.yaml'), 'value: 1\n')
  const listeners = new Map()
  const config = new Config({ configDir: local, defaultDir: defaults, watchers: {
    watch: (key, file, onChange) => { listeners.set(key, onChange); return { close: async () => {} } },
  } })
  t.after(async () => { await config.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const file = path.join(local, 'config.yaml')
  assert.deepEqual(config.getConfig('config'), { value: 1 })
  const change = text => { fs.writeFileSync(file, text); listeners.get('config:config.config')() }
  change('value: [broken')
  assert.deepEqual(config.getConfig('config'), { value: 1 })
  assert.equal(fs.readFileSync(file, 'utf8'), 'value: [broken')
  change('- list')
  assert.deepEqual(config.getConfig('config'), { value: 1 })
  change('renderNum: -1')
  assert.deepEqual(config.getConfig('config'), { value: 1 })
  change('value: 2')
  assert.deepEqual(config.getConfig('config'), { value: 2 })
  assert.throws(() => config.getConfig('../outside'), /Invalid configuration name/)
})

test('YAML writes preserve comments and use private atomic files; malformed files are never rewritten', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-yaml-test-')), file = path.join(root, 'config.yaml')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(file, '# user comment\nvalue: 1\n')
  new YamlReader(file).set('value', 2)
  assert.match(fs.readFileSync(file, 'utf8'), /# user comment\nvalue: 2/)
  assert.deepEqual(fs.readdirSync(root), ['config.yaml'])
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  fs.writeFileSync(file, 'value: [broken')
  assert.throws(() => new YamlReader(file), /YAML/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'value: [broken')
})

test('version metadata follows verified resources without reading README or adding watchers', () => {
  const previous = getPlatformAdapter()
  try {
    setPlatformAdapter({ getPackageVersion: () => '0.1.0', resourceManifest: { game: { version: '3.20.0', code: 154 } } })
    const version = new ProjectVersion()
    assert.equal(version.ver, 'v0.1.0')
    assert.equal(version.phigros, '3.20.0')
    assert.equal(version.phigrosVerNum, 154)
    assert.deepEqual(version.toJSON(), { ver: 'v0.1.0', phigros: '3.20.0', phigrosVerNum: 154 })
    setPlatformAdapter({ resourceManifest: { game: { version: '3.21.0', code: 155 } } })
    assert.equal(version.phigrosVerNum, 155)
  } finally { setPlatformAdapter(previous) }
})
