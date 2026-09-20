#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { buildIllustrations } from './build-illustrations.mjs'
import { RESOURCE_VERSION, sha256, validateInfoDirectory, validateManifest, validateResourceIndex, validateResourcePath, allowedResourceFile } from '../src/resources.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
async function writeJson(file, data) { await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`) }
async function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}
function validateNames(items) {
  const names = new Set(), prefixes = new Map()
  for (const { name } of items) {
    validateResourcePath(name)
    if (names.has(name.toLowerCase())) throw new Error(`发布资源文件名重复（不区分大小写）：${name}`)
    names.add(name.toLowerCase())
    const parts = name.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/'), key = prefix.toLowerCase()
      if (prefixes.has(key) && prefixes.get(key) !== prefix) throw new Error(`发布资源路径大小写冲突：${name}`)
      prefixes.set(key, prefix)
    }
  }
}
async function filesIn(root, prefix = '') {
  const files = []
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name.startsWith('.')) continue
    const name = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error(`发布资源禁止符号链接：${name}`)
    if (entry.isDirectory()) files.push(...await filesIn(root, `${name}/`))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`发布资源禁止特殊文件：${name}`)
  }
  return files
}
async function packageFiles(source, kind) {
  const prefix = 'LICENSES/phi-plugin-openclaw/'
  const notices = new Map([['GPL-3.0.txt', 'LICENSE'], ['resources-Apache-2.0.txt', 'resources/LICENSE'], ['NOTICE.md', 'NOTICE.md']]
    .map(([name, file]) => [`${prefix}${name}`, path.join(repo, file)]))
  const items = []
  for (const name of await filesIn(source)) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
      const original = notices.get(name)
      if (!original) throw new Error(`输入在发布器保留目录中包含未知说明文件：${name}`)
      const file = path.join(source, name), expected = await fs.readFile(original)
      if ((await fs.stat(file)).size !== expected.length || !(await fs.readFile(file)).equals(expected)) {
        throw new Error(`输入说明文件与发布器内容不一致，不能覆盖：${name}`)
      }
      // An installed package contains these notices already. Verify them before
      // deduplicating, and append the canonical bytes in the same stable order.
      continue
    }
    if (allowedResourceFile(name, kind)) items.push({ name, file: path.join(source, name) })
  }
  for (const [name, file] of notices) items.push({ name, file })
  validateNames(items)
  return items
}
export async function buildResources({ output, version, gameVersion = version?.split('-r')[0], gameCode, info = process.env.PHI_RESOURCE_SOURCE_DIR, illustrations, partBytes = 32 * 1024 * 1024 }) {
  if (!RESOURCE_VERSION.test(version) || !/^\d+\.\d+\.\d+$/.test(gameVersion) || !Number.isSafeInteger(gameCode) || gameCode < 1) throw new Error('必须提供有效的资源 version 和 game-code；可选 game-version 应为 x.y.z。')
  if (version.split('-r')[0] !== gameVersion) throw new Error('资源 version 必须以相同的游戏版本命名，如 3.20.0 或 3.20.0-r1。')
  if (!Number.isSafeInteger(partBytes) || partBytes < 1024 || partBytes > 64 * 1024 * 1024) throw new Error('分包大小须在 1 KiB 到 64 MiB 之间。')
  if (!info) throw new Error('曲目元数据不在插件仓库内；请用 --info 或 PHI_RESOURCE_SOURCE_DIR 指定外部 song-data 目录。')
  if (typeof output !== 'string' || !output.trim()) throw new Error('必须提供资源输出目录。')
  await validateInfoDirectory(info)
  const root = path.resolve(output), destination = path.join(root, 'v', version)
  for (const source of [info, illustrations].filter(Boolean)) {
    const relative = path.relative(path.resolve(source), root)
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('资源输出目录不能位于输入目录内部。')
  }
  await fs.mkdir(root, { recursive: true })
  const lock = path.join(root, '.publish-lock')
  try { await fs.mkdir(lock) }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`资源仓库已有发布任务；若上次任务异常退出，请确认没有发布进程后移除 ${lock} 再重试。`)
    throw error
  }
  let stage
  try {
    if (await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error })) throw new Error('版本目录已存在，禁止覆盖；请增加版本号。')
    await fs.mkdir(path.join(root, 'v'), { recursive: true })
    let previous = { schemaVersion: 1, releases: [] }
    try { previous = validateResourceIndex(JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8'))) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (previous.releases.some(release => release.version === version)) throw new Error('版本索引已存在此版本，禁止覆盖；请增加版本号。')
    if (previous.releases.some(release => !release.game || !release.packages)) throw new Error('已有资源索引缺少游戏版本或资源包列表。')
    stage = await fs.mkdtemp(path.join(root, '.publish-'))
    const manifest = { schemaVersion: 1, dataFormat: 'phi-info-v1', version, minPluginVersion: '0.1.0', game: { version: gameVersion, code: gameCode }, packages: {} }
    const checksums = []
    for (const [kind, source] of [['song-data', info]]) {
      if (!source) continue
      // Keep distribution notices with the data, not only in the plugin package.
      const items = await packageFiles(source, kind)
      const archives = []; let zip = new JSZip(), bytes = 0, count = 0, part = 0
      const zipDate = new Date('2000-01-01T00:00:00Z')
      // Preserve required empty directories and fix every ZIP timestamp, including
      // directory entries, so an unchanged source yields identical archives.
      if (kind === 'song-data') for (const name of ['DLC/', 'oldInfo/']) zip.file(name, null, { dir: true, date: zipDate, unixPermissions: 0o040755, createFolders: false })
      async function flush() {
        if (!count) return
        const filename = `${kind}-${String(++part).padStart(3, '0')}.zip`
        const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: kind === 'song-data' ? 'DEFLATE' : 'STORE', compressionOptions: { level: 6 }, platform: 'UNIX' })
        await fs.writeFile(path.join(stage, filename), buffer)
        const hash = sha256(buffer)
        archives.push({ path: `v/${version}/${filename}`, sha256: hash, bytes: buffer.length, unpackedBytes: bytes, fileCount: count })
        checksums.push(`${hash}  ${filename}`)
        zip = new JSZip(); bytes = 0; count = 0
      }
      for (const item of items) {
        if ((await fs.stat(item.file)).size > 32 * 1024 * 1024) throw new Error(`单文件超过 32 MiB：${item.name}`)
        const content = await fs.readFile(item.file)
        if (content.length > 32 * 1024 * 1024) throw new Error(`单文件超过 32 MiB：${item.name}`)
        if (count && (bytes + content.length > partBytes || count >= 9000)) await flush()
        // ZIP requires a timestamp field; keep a fixed value for reproducible
        // archives instead of recording a creation or upload time.
        zip.file(item.name, content, { date: zipDate, unixPermissions: 0o100644, createFolders: false })
        bytes += content.length; count++
      }
      await flush(); manifest.packages[kind] = { archives }
    }
    validateManifest(manifest)
    await writeJson(path.join(stage, 'metadata.json'), manifest)
    const manifestHash = sha256(await fs.readFile(path.join(stage, 'metadata.json')))
    checksums.push(`${manifestHash}  metadata.json`)
    await fs.writeFile(path.join(stage, 'SHA256SUMS'), checksums.join('\n') + '\n')
    const pointer = { schemaVersion: 1, version, manifest: `v/${version}/metadata.json`, sha256: manifestHash, game: manifest.game, packages: Object.keys(manifest.packages) }
    const releases = [pointer, ...previous.releases].sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))
    if (illustrations) await buildIllustrations({ input: illustrations, output: root, partBytes })
    await fs.chmod(stage, 0o755)
    await fs.rename(stage, destination)
    // Make all version files available before advancing latest.
    await atomicWrite(path.join(root, 'index.json'), `${JSON.stringify({ schemaVersion: 1, releases }, null, 2)}\n`)
    const table = ['version\tphigros\tcode\tpackages', ...releases.map(item => [item.version, item.game.version, item.game.code, item.packages.join(',')].join('\t'))]
    await atomicWrite(path.join(root, 'index.tab'), table.join('\n') + '\n')
    await atomicWrite(path.join(root, 'latest.json'), `${JSON.stringify(releases[0], null, 2)}\n`)
    return { root, version, packages: Object.keys(manifest.packages), manifest }
  } finally {
    try { if (stage) await fs.rm(stage, { recursive: true, force: true }) }
    finally { await fs.rmdir(lock) }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string', default: 'dist-resources' }, version: { type: 'string' }, 'game-version': { type: 'string' }, 'game-code': { type: 'string' }, info: { type: 'string' }, illustrations: { type: 'string' } } })
    const result = await buildResources({ output: values.output, version: values.version, gameVersion: values['game-version'], gameCode: Number(values['game-code']), info: values.info, illustrations: values.illustrations })
    console.log(`资源已生成：${result.root}\n曲目数据版本：${result.version}\n分包：${result.packages.join(', ')}\n上传 public 内容时先发布版本文件与曲绘对象，再更新曲绘索引和版本索引，最后 latest.json。`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
