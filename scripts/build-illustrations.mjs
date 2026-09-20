#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import JSZip from 'jszip'
import { sha256, validateResourcePath } from '../src/resources.mjs'
import { isIllustrationFile, illustrationObjectPath, validateIllustrationIndex } from '../src/illustrations.mjs'
import atomicFileWriter from '../model/filesystem/atomicFile.js'

async function walk(root, prefix = '') {
  const files = []
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name.startsWith('.')) continue
    const name = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error(`曲绘源不允许符号链接：${name}`)
    if (entry.isDirectory()) files.push(...await walk(root, `${name}/`))
    else if (entry.isFile()) {
      validateResourcePath(name)
      if (!isIllustrationFile(name)) throw new Error(`曲绘目录含非图片或未知分类：${name}`)
      files.push(name)
    } else throw new Error(`曲绘目录含特殊文件：${name}`)
  }
  return files
}

/** Publish content-addressed objects before advancing the shared catalog. */
export async function buildIllustrations({ input, output, partBytes = 32 * 1024 ** 2 }) {
  if (!input || !output) throw new Error('请提供曲绘 input 和资源 output 目录。')
  if (!Number.isSafeInteger(partBytes) || partBytes < 1024 || partBytes > 64 * 1024 ** 2) throw new Error('曲绘分包大小无效。')
  const source = path.resolve(input), root = path.join(path.resolve(output), 'illustrations')
  const relative = path.relative(source, root)
  if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('曲绘输出目录不能位于输入目录内。')
  const names = await walk(source), seen = new Set(), prefixes = new Map()
  if (!names.length || names.length > 20000) throw new Error('曲绘目录为空或文件数量过多。')
  for (const name of names) {
    if (seen.has(name.toLowerCase())) throw new Error(`曲绘文件大小写冲突：${name}`)
    seen.add(name.toLowerCase())
    const parts = name.split('/')
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/'), lower = prefix.toLowerCase()
      if (prefixes.has(lower) && prefixes.get(lower) !== prefix) throw new Error(`曲绘目录大小写冲突：${name}`)
      prefixes.set(lower, prefix)
    }
  }
  await fs.mkdir(root, { recursive: true })
  const lock = path.join(root, '.publish-lock')
  try { await fs.mkdir(lock) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('曲绘仓库已有发布任务，请确认任务结束后再构建。'); throw error }
  let stage
  try {
    stage = await fs.mkdtemp(path.join(root, '.publish-'))
    const index = { schemaVersion: 1, files: {}, archives: [] }
    const objects = new Map()
    let zip = new JSZip(), bytes = 0, count = 0
    const date = new Date('2000-01-01T00:00:00Z')
    async function flush() {
      if (!count) return
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX' })
      const hash = sha256(buffer), target = `packages/${hash}.zip`
      await fs.mkdir(path.join(stage, 'packages'), { recursive: true })
      await fs.writeFile(path.join(stage, target), buffer)
      index.archives.push({ path: target, sha256: hash, bytes: buffer.length, unpackedBytes: bytes, fileCount: count })
      zip = new JSZip(); bytes = 0; count = 0
    }
    for (const name of names) {
      const original = path.join(source, name), stat = await fs.stat(original)
      if (!stat.size || stat.size > 32 * 1024 ** 2) throw new Error(`曲绘文件为空或超过 32 MiB：${name}`)
      const content = await fs.readFile(original)
      if (!content.length || content.length > 32 * 1024 ** 2) throw new Error(`曲绘文件大小无效：${name}`)
      const hash = sha256(content), target = illustrationObjectPath(hash, name)
      index.files[name] = { path: target, bytes: content.length, sha256: hash }
      if (!objects.has(target)) {
        await fs.mkdir(path.dirname(path.join(stage, target)), { recursive: true })
        await fs.writeFile(path.join(stage, target), content)
        objects.set(target, hash)
      }
      if (count && (bytes + content.length > partBytes || count >= 9000)) await flush()
      zip.file(name, content, { date, unixPermissions: 0o100644, createFolders: false })
      bytes += content.length; count++
    }
    await flush()
    validateIllustrationIndex(index)
    const indexBytes = Buffer.from(JSON.stringify(index, null, 2) + '\n')
    const sums = [`${sha256(indexBytes)}  index.json`, ...index.archives.map(archive => `${archive.sha256}  ${archive.path}`)].join('\n') + '\n'
    // Never mutate a published hash object. A corrupt existing object is an error.
    for (const [relative, hash] of [...objects, ...index.archives.map(archive => [archive.path, archive.sha256])]) {
      const target = path.join(root, relative)
      try {
        const stat = await fs.lstat(target)
        if (!stat.isFile() || sha256(await fs.readFile(target)) !== hash) throw new Error(`已有曲绘对象内容与哈希不符：${relative}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.rename(path.join(stage, relative), target)
      }
    }
    atomicFileWriter.write(path.join(root, 'index.json'), indexBytes)
    atomicFileWriter.write(path.join(root, 'SHA256SUMS'), sums)
    // Static files must be readable by the web-server user.
    await fs.chmod(path.join(root, 'index.json'), 0o644)
    await fs.chmod(path.join(root, 'SHA256SUMS'), 0o644)
    return { root, files: names.length, objects: objects.size, archives: index.archives.length,
      bytes: Object.values(index.files).reduce((sum, file) => sum + file.bytes, 0) }
  } finally {
    try { if (stage) await fs.rm(stage, { recursive: true, force: true }) }
    finally { await fs.rmdir(lock) }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } })
    console.log(JSON.stringify(await buildIllustrations(values), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
