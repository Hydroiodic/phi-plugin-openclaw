import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AtomicFileWriter } from '../model/filesystem/atomicFile.js'
import files from '../model/filesystem/getFile.js'

test('failed atomic replacement preserves old data and cleans only its temporary file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-atomic-test-')),
    target = path.join(root, 'save.json')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(target, '{"value":1}')
  const writer = new AtomicFileWriter({
    ...fs,
    renameSync() {
      throw new Error('synthetic disk failure')
    },
  })
  assert.throws(() => writer.write(target, '{"value":2}'), /disk failure/)
  assert.equal(fs.readFileSync(target, 'utf8'), '{"value":1}')
  assert.deepEqual(fs.readdirSync(root), ['save.json'])
})

test('file repository handles serialization, malformed data and awaited deletion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-files-test-')),
    target = path.join(root, 'nested/save.json')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(files.SetFile(target, { value: 1 }), true)
  assert.deepEqual(files.FileReader(target), { value: 1 })
  assert.equal(files.SetFile(target, undefined), false)
  assert.deepEqual(files.FileReader(target), { value: 1 })
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  assert.equal(await files.DelFile(target), true)
  assert.equal(fs.existsSync(target), false)
  assert.equal(await files.DelFile(target), false)
  assert.equal(await files.DelFile(path.dirname(target)), false)
  fs.writeFileSync(target, '{broken')
  assert.equal(files.FileReader(target), false)
})
