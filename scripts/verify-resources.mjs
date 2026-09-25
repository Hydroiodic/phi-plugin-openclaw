#!/usr/bin/env node
// Standalone integrity verifier for a phi-plugin-openclaw resources/v1 tree.
// Requires Node.js 22.16+ and no npm dependencies.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-r([1-9]\d*))?$/
const HASH = /^[a-f0-9]{64}$/
const MAX_INDEX = 2 * 1024 * 1024
const MAX_ARCHIVE = 128 * 1024 * 1024
const MAX_UNPACKED = 512 * 1024 * 1024
const MAX_FILE = 32 * 1024 * 1024
const MAX_FILES = 10000
const REQUIRED_INFO = [
  'info.csv', 'infolist.json', 'notesInfo.json', 'oldNotesInfo.json', 'spinfo.json',
  'nicklist.yaml', 'chaplist.yaml', 'avatar.txt', 'tips.txt', 'notice.json',
  'jrrp.json', 'sentences.json', 'help.json', 'help/api.json',
]
const REQUIRED_LICENSES = [
  'LICENSES/phi-plugin-openclaw/GPL-3.0.txt',
  'LICENSES/phi-plugin-openclaw/resources-Apache-2.0.txt',
  'LICENSES/phi-plugin-openclaw/NOTICE.md',
]

class IntegrityError extends Error {
  constructor(message) { super(message); this.name = 'IntegrityError' }
}
const check = (condition, message) => { if (!condition) throw new IntegrityError(message) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const parseJson = (bytes, label) => {
  try { return JSON.parse(bytes.toString('utf8')) }
  catch (error) { throw new IntegrityError(`${label} 不是有效 JSON：${error.message}`) }
}
function versionParts(version) {
  const match = VERSION.exec(version)
  check(match, `资源版本格式无效：${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || 0)]
}
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}
function safeRelative(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 240, `路径为空或过长：${String(value)}`)
  check(!value.startsWith('/') && !/[\\:%\x00-\x1f\x7f]/.test(value), `路径含危险字符：${value}`)
  check(value.split('/').every(part => part && !part.startsWith('.') && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part)), `路径不安全：${value}`)
  return value
}
const allowedFile = (name, kind) => (kind === 'song-data'
  ? /\.(json|csv|ya?ml|txt|md)$/i
  : /\.(png|jpe?g|webp|txt|md)$/i).test(name)
  || /(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE|AUTHORS)(?:\.[A-Za-z0-9.-]+)?$/i.test(name)

class LocalReader {
  constructor(root, sourceRoot) { this.root = path.resolve(root); this.sourceRoot = sourceRoot; this.label = this.root; this.remote = false; this.warnings = [] }
  async read(relative, maxBytes) {
    safeRelative(relative)
    const target = path.resolve(this.root, relative)
    check(target.startsWith(this.root + path.sep), `本地路径越界：${relative}`)
    let current = this.root
    for (const part of ['', ...relative.split('/')]) {
      if (part) current = path.join(current, part)
      try { check(!(await fs.lstat(current)).isSymbolicLink(), `资源不允许符号链接：${relative}`) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    let stat
    try { stat = await fs.stat(target) } catch { throw new IntegrityError(`缺少文件：${relative}`) }
    check(stat.isFile(), `不是普通文件：${relative}`)
    check(stat.size <= maxBytes, `${relative} 超过读取上限：${stat.size} bytes`)
    return { bytes: await fs.readFile(target), headers: null }
  }
}

class RemoteReader {
  constructor(root, strictHttp = false) {
    const base = new URL(root)
    check(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), '远端地址必须是 HTTPS（本机测试允许 HTTP）。')
    check(!base.username && !base.password && !base.search && !base.hash, '远端地址不能带凭据、查询参数或片段。')
    base.pathname = base.pathname.replace(/\/*$/, '/')
    this.root = base.href; this.label = base.href; this.remote = true; this.strictHttp = strictHttp; this.warnings = []
  }
  warn(message) {
    if (this.strictHttp) throw new IntegrityError(message)
    if (!this.warnings.includes(message)) this.warnings.push(message)
  }
  async read(relative, maxBytes, expectedType) {
    const url = new URL(safeRelative(relative).split('/').map(encodeURIComponent).join('/'), this.root)
    let response
    try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) }) }
    catch (error) { throw new IntegrityError(`请求失败 ${url.href}：${error.message}`) }
    check(response.ok, `${relative} 返回 HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length') || 0)
    check(!length || length <= maxBytes, `${relative} 的 Content-Length 超过上限：${length}`)
    const contentType = response.headers.get('content-type') || ''
    if (expectedType && !contentType.toLowerCase().startsWith(expectedType)) this.warn(`${relative} 的 Content-Type 是 ${contentType || '未设置'}，建议设置为 ${expectedType}`)
    const cache = response.headers.get('cache-control') || ''
    if (/^(?:index\.json|index\.tab|latest\.json|illustrations\/(?:index\.json|SHA256SUMS))$/.test(relative)) {
      if (!cache) this.warn(`${relative} 未设置 Cache-Control，建议使用 public, max-age=60, must-revalidate`)
    } else if (!/\bimmutable\b/i.test(cache)) {
      this.warn(`${relative} 未使用 immutable 缓存，建议使用 public, max-age=31536000, immutable`)
    }
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      check(size <= maxBytes, `${relative} 下载超过上限 ${maxBytes} bytes`)
      chunks.push(chunk)
    }
    check(!length || length === size, `${relative} 的 Content-Length=${length}，实际收到 ${size}`)
    return { bytes: Buffer.concat(chunks), headers: response.headers }
  }
}

function validatePointer(pointer, label) {
  check(pointer && typeof pointer === 'object' && !Array.isArray(pointer), `${label} 必须是对象`)
  check(pointer.schemaVersion === 1, `${label}.schemaVersion 必须为 1`)
  versionParts(pointer.version)
  check(pointer.manifest === `v/${pointer.version}/metadata.json`, `${label}.manifest 必须指向自身版本的 metadata.json`)
  check(HASH.test(pointer.sha256), `${label}.sha256 无效`)
  check(pointer.game && pointer.game.version === pointer.version.split('-r')[0], `${label}.game.version 与资源版本不一致`)
  check(Number.isSafeInteger(pointer.game.code) && pointer.game.code > 0, `${label}.game.code 无效`)
  check(Array.isArray(pointer.packages) && pointer.packages.includes('song-data'), `${label}.packages 缺少 song-data`)
  check(pointer.packages.length === 1 && pointer.packages[0] === 'song-data', `${label}.packages 必须为 song-data`)
}
function validateManifest(manifest, pointer) {
  const label = `${pointer.version}/metadata.json`
  check(manifest && typeof manifest === 'object' && !Array.isArray(manifest), `${label} 必须是对象`)
  check(manifest.schemaVersion === 1 && manifest.dataFormat === 'phi-info-v1', `${label} 的 schemaVersion/dataFormat 不受支持`)
  check(manifest.version === pointer.version, `${label} 的版本与索引不一致`)
  check(manifest.game?.version === pointer.game.version && manifest.game?.code === pointer.game.code, `${label} 的游戏版本与索引不一致`)
  check(manifest.version.split('-r')[0] === manifest.game.version, `${label} 的资源版本与游戏版本不一致`)
  check(/^\d+\.\d+\.\d+$/.test(manifest.minPluginVersion), `${label}.minPluginVersion 无效`)
  check(manifest.packages && typeof manifest.packages === 'object' && !Array.isArray(manifest.packages), `${label}.packages 无效`)
  const kinds = Object.keys(manifest.packages)
  check(JSON.stringify(kinds) === JSON.stringify(pointer.packages), `${label} 与索引的 packages 顺序或内容不一致`)
  const archivePaths = new Set()
  for (const kind of kinds) {
    const pack = manifest.packages[kind]
    check(Array.isArray(pack?.archives) && pack.archives.length > 0 && pack.archives.length <= 256, `${label}.${kind}.archives 数量无效`)
    pack.archives.forEach((archive, index) => {
      const expected = `v/${manifest.version}/${kind}-${String(index + 1).padStart(3, '0')}.zip`
      check(archive.path === expected, `${label} 分包路径应为 ${expected}`)
      check(!archivePaths.has(archive.path), `${label} 分包路径重复：${archive.path}`); archivePaths.add(archive.path)
      check(HASH.test(archive.sha256), `${archive.path} 的 SHA-256 无效`)
      for (const [field, maximum] of [['bytes', MAX_ARCHIVE], ['unpackedBytes', MAX_UNPACKED], ['fileCount', MAX_FILES]]) {
        check(Number.isSafeInteger(archive[field]) && archive[field] > 0 && archive[field] <= maximum, `${archive.path}.${field} 无效`)
      }
    })
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()
function crc32(bytes) {
  let crc = 0xffffffff
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ crc >>> 8
  return (crc ^ 0xffffffff) >>> 0
}
function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 65557)
  for (let offset = bytes.length - 22; offset >= minimum; offset--) if (bytes.readUInt32LE(offset) === 0x06054b50) return offset
  throw new IntegrityError('ZIP 缺少 End of Central Directory')
}
function decodeName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new IntegrityError('ZIP 文件名不是有效 UTF-8') }
}
function inspectZip(bytes, archive, kind, seen) {
  check(bytes.length === archive.bytes, `${archive.path} 大小不符：清单 ${archive.bytes}，实际 ${bytes.length}`)
  check(sha256(bytes) === archive.sha256, `${archive.path} SHA-256 校验失败`)
  const eocd = findEndOfCentralDirectory(bytes)
  check(bytes.readUInt16LE(eocd + 4) === 0 && bytes.readUInt16LE(eocd + 6) === 0, `${archive.path} 不允许多磁盘 ZIP`)
  const entries = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12), centralOffset = bytes.readUInt32LE(eocd + 16)
  check(entries !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff, `${archive.path} 不支持 ZIP64`)
  check(entries <= MAX_FILES && eocd + 22 + bytes.readUInt16LE(eocd + 20) === bytes.length, `${archive.path} EOCD 或注释长度无效`)
  check(centralOffset + centralSize === eocd, `${archive.path} 中央目录位置无效`)
  let cursor = centralOffset, files = 0, total = 0
  const ranges = [], names = [], jsonFiles = [], hashes = new Map()
  for (let index = 0; index < entries; index++) {
    check(cursor + 46 <= eocd && bytes.readUInt32LE(cursor) === 0x02014b50, `${archive.path} 中央目录项 ${index + 1} 无效`)
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32)
    const disk = bytes.readUInt16LE(cursor + 34), external = bytes.readUInt32LE(cursor + 38), localOffset = bytes.readUInt32LE(cursor + 42)
    check(!(flags & 1) && !(flags & 0x40), `${archive.path} 不允许加密文件`)
    check(method === 0 || method === 8, `${archive.path} 使用不支持的压缩方法 ${method}`)
    check(disk === 0 && compressed !== 0xffffffff && uncompressed !== 0xffffffff && localOffset !== 0xffffffff, `${archive.path} 的 ZIP64/磁盘字段无效`)
    check(cursor + 46 + nameLength + extraLength + commentLength <= eocd, `${archive.path} 中央目录越界`)
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = decodeName(rawName), directory = name.endsWith('/'), normalized = safeRelative(directory ? name.slice(0, -1) : name)
    check(!seen.has(normalized.toLowerCase()), `${archive.path} 与同包其他分包重名：${normalized}`); seen.add(normalized.toLowerCase())
    const mode = external >>> 16 & 0xffff, fileType = mode & 0o170000
    check(!fileType || fileType === (directory ? 0o040000 : 0o100000), `${archive.path} 包含链接或特殊文件：${name}`)
    check(localOffset + 30 <= centralOffset && bytes.readUInt32LE(localOffset) === 0x04034b50, `${archive.path} 的本地文件头无效：${name}`)
    check(bytes.readUInt16LE(localOffset + 8) === method, `${archive.path} 压缩方法字段不一致：${name}`)
    const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)
    check(localName.equals(rawName), `${archive.path} 中央目录与本地文件名不一致：${name}`)
    const start = localOffset + 30 + localNameLength + localExtraLength, end = start + compressed
    check(start <= end && end <= centralOffset, `${archive.path} 压缩数据越界：${name}`)
    ranges.push([localOffset, end, name])
    const compressedBytes = bytes.subarray(start, end)
    let content
    try {
      content = method === 0 ? Buffer.from(compressedBytes)
        : inflateRawSync(compressedBytes, { maxOutputLength: Math.min(MAX_FILE, uncompressed + 1) })
    } catch (error) { throw new IntegrityError(`${archive.path} 解压失败 ${name}：${error.message}`) }
    check(content.length === uncompressed && content.length <= MAX_FILE, `${archive.path} 解压大小不符或单文件过大：${name}`)
    check(crc32(content) === checksum, `${archive.path} CRC32 校验失败：${name}`)
    if (directory) check(content.length === 0, `${archive.path} 目录项不应有内容：${name}`)
    else {
      check(allowedFile(normalized, kind), `${archive.path} 包含不允许的文件类型：${normalized}`)
      files++; total += content.length; names.push(normalized)
      hashes.set(normalized, sha256(content))
      if (kind === 'song-data' && normalized.endsWith('.json')) jsonFiles.push([normalized, content])
      if (kind === 'song-data' && /\.(json|csv|ya?ml|txt|md)$/i.test(normalized)) {
        try { new TextDecoder('utf-8', { fatal: true }).decode(content) }
        catch { throw new IntegrityError(`${archive.path} 文本不是有效 UTF-8：${normalized}`) }
      }
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  check(cursor === eocd, `${archive.path} 中央目录长度不符`)
  ranges.sort((a, b) => a[0] - b[0])
  for (let index = 1; index < ranges.length; index++) check(ranges[index - 1][1] <= ranges[index][0], `${archive.path} ZIP 数据区重叠`)
  check(files === archive.fileCount, `${archive.path} 文件数不符：清单 ${archive.fileCount}，实际 ${files}`)
  check(total === archive.unpackedBytes, `${archive.path} 解压总大小不符：清单 ${archive.unpackedBytes}，实际 ${total}`)
  for (const [name, content] of jsonFiles) parseJson(content, `${archive.path}:${name}`)
  return { files, total, names, hashes }
}

async function sourceFiles(root, prefix = '', kind = 'song-data') {
  const result = new Map()
  const directory = path.join(root, prefix)
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) }
  catch { throw new IntegrityError(`无法读取曲目源目录：${directory}`) }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    check(!entry.name.startsWith('.'), `song-data/ 含不会被发布的隐藏项：${name}`)
    check(!entry.isSymbolicLink(), `song-data/ 不允许符号链接：${name}`)
    if (entry.isDirectory()) {
      for (const [child, hash] of await sourceFiles(root, name, kind)) result.set(child, hash)
    } else {
      check(entry.isFile(), `song-data/ 含特殊文件：${name}`)
      safeRelative(name)
      check(allowedFile(name, kind), `${kind}/ 含不会被发布的文件类型：${name}`)
      const bytes = await fs.readFile(path.join(root, name))
      check(bytes.length <= MAX_FILE, `song-data/ 单文件超过 32 MiB：${name}`)
      result.set(name, sha256(bytes))
    }
  }
  return result
}

async function compareSource(root, published, kind = 'song-data') {
  const source = await sourceFiles(root, '', kind)
  const packaged = new Map([...published].filter(([name]) => !name.startsWith('LICENSES/phi-plugin-openclaw/')))
  const missing = [...source.keys()].filter(name => !packaged.has(name))
  const extra = [...packaged.keys()].filter(name => !source.has(name))
  const changed = [...source].filter(([name, hash]) => packaged.has(name) && packaged.get(name) !== hash).map(([name]) => name)
  const summary = values => values.slice(0, 5).join(', ') + (values.length > 5 ? ` 等 ${values.length} 项` : '')
  check(!missing.length, `发布文件缺少 ${kind}/ 源文件：${summary(missing)}`)
  check(!extra.length, `发布文件含 ${kind}/ 中不存在的文件：${summary(extra)}`)
  check(!changed.length, `发布文件与 ${kind}/ 内容不一致：${summary(changed)}`)
  return source.size
}

function parseChecksums(bytes, version, expected) {
  const text = bytes.toString('utf8')
  check(text.endsWith('\n'), `v/${version}/SHA256SUMS 末尾应有换行`)
  const values = new Map()
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([^/\r\n]+)$/.exec(line)
    check(match, `v/${version}/SHA256SUMS 行格式错误：${line}`)
    check(!values.has(match[2]), `v/${version}/SHA256SUMS 文件名重复：${match[2]}`)
    values.set(match[2], match[1])
  }
  check(values.size === expected.size, `v/${version}/SHA256SUMS 条目数量不符`)
  for (const [name, hash] of expected) check(values.get(name) === hash, `v/${version}/SHA256SUMS 与清单不一致：${name}`)
}

async function verifyVersion(reader, pointer, log) {
  const manifestResult = await reader.read(pointer.manifest, MAX_INDEX, 'application/json')
  check(sha256(manifestResult.bytes) === pointer.sha256, `${pointer.manifest} SHA-256 与索引不一致`)
  const manifest = parseJson(manifestResult.bytes, pointer.manifest)
  validateManifest(manifest, pointer)
  const checksumExpected = new Map([['metadata.json', pointer.sha256]])
  const packageNames = {}, packageHashes = {}
  for (const [kind, pack] of Object.entries(manifest.packages)) {
    const seen = new Set(), names = [], hashes = new Map()
    for (const archive of pack.archives) {
      const result = await reader.read(archive.path, Math.min(MAX_ARCHIVE, archive.bytes + 1), 'application/zip')
      const inspected = inspectZip(result.bytes, archive, kind, seen)
      names.push(...inspected.names)
      for (const [name, hash] of inspected.hashes) hashes.set(name, hash)
      checksumExpected.set(path.basename(archive.path), archive.sha256)
      log(`  ✓ ${path.basename(archive.path)}：${inspected.files} 文件，${inspected.total} bytes`)
    }
    packageNames[kind] = names
    packageHashes[kind] = hashes
    for (const license of REQUIRED_LICENSES) check(names.includes(license), `${pointer.version}/${kind} 缺少许可文件 ${license}`)
    if (kind === 'song-data') {
      for (const required of REQUIRED_INFO) check(names.includes(required), `${pointer.version}/song-data 缺少 ${required}`)
      check(names.some(name => name.startsWith('DLC/') && name.endsWith('.json')), `${pointer.version}/song-data 的 DLC/ 为空`)
      check(names.some(name => name.startsWith('oldInfo/') && name.endsWith('.json')), `${pointer.version}/song-data 的 oldInfo/ 为空`)
    }
  }
  const sums = await reader.read(`v/${pointer.version}/SHA256SUMS`, MAX_INDEX, 'text/plain')
  parseChecksums(sums.bytes, pointer.version, checksumExpected)
  log(`✓ ${pointer.version}：游戏 ${manifest.game.version} (${manifest.game.code})，${Object.keys(packageNames).join(', ')}`)
  return { manifest, packageHashes }
}

export async function verifyIllustrations(reader, log) {
  const prefix = 'illustrations/'
  const result = await reader.read(prefix + 'index.json', 8 * 1024 ** 2, 'application/json')
  const index = parseJson(result.bytes, prefix + 'index.json')
  check(index?.schemaVersion === 1 && index.files && typeof index.files === 'object' && !Array.isArray(index.files), '曲绘索引格式无效')
  check(!Object.hasOwn(index, 'version'), '公共曲绘索引不应绑定游戏版本')
  const entries = Object.entries(index.files), names = new Set(), objects = new Map()
  check(entries.length > 0 && entries.length <= 20000, '曲绘文件数量无效')
  let total = 0
  for (const [name, file] of entries) {
    safeRelative(name)
    check(/^(ill|illLow|illBlur|SP|chap|chartimg|table)\/.+\.(png|jpe?g|webp)$/i.test(name), `曲绘路径无效：${name}`)
    check(!names.has(name.toLowerCase()), `曲绘文件重复：${name}`); names.add(name.toLowerCase())
    check(HASH.test(file?.sha256) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_FILE, `曲绘校验字段无效：${name}`)
    check(file.path === `objects/${file.sha256.slice(0, 2)}/${file.sha256}${path.extname(name).toLowerCase()}`, `曲绘对象路径无效：${name}`)
    check(!objects.has(file.path) || objects.get(file.path).bytes === file.bytes, `相同曲绘对象大小不一致：${name}`)
    objects.set(file.path, file); total += file.bytes
  }
  check(total <= 8 * 1024 ** 3, '曲绘总大小超出限制')
  check(Array.isArray(index.archives) && index.archives.length > 0 && index.archives.length <= 256, '曲绘分包数量无效')
  const sums = new Map(), sumsBytes = (await reader.read(prefix + 'SHA256SUMS', MAX_INDEX, 'text/plain')).bytes
  for (const line of sumsBytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}(index\.json|packages\/[a-f0-9]{64}\.zip)$/.exec(line)
    check(match && !sums.has(match[2]), '曲绘 SHA256SUMS 格式或条目重复')
    sums.set(match[2], match[1])
  }
  check(sums.get('index.json') === sha256(result.bytes) && sums.size === index.archives.length + 1, '曲绘索引 SHA-256 或校验条目数量不符')
  const seen = new Set(), packaged = new Map(), archives = new Set()
  for (const archive of index.archives) {
    check(HASH.test(archive?.sha256) && archive.path === `packages/${archive.sha256}.zip` && !archives.has(archive.path), '曲绘分包路径或哈希无效')
    archives.add(archive.path)
    check(sums.get(archive.path) === archive.sha256, '曲绘分包与 SHA256SUMS 不一致')
    for (const [field, max] of [['bytes', MAX_ARCHIVE], ['unpackedBytes', MAX_UNPACKED], ['fileCount', MAX_FILES]]) {
      check(Number.isSafeInteger(archive[field]) && archive[field] > 0 && archive[field] <= max, `曲绘分包 ${field} 无效`)
    }
    const bytes = (await reader.read(prefix + archive.path, archive.bytes, 'application/zip')).bytes
    const inspected = inspectZip(bytes, archive, 'illustrations', seen)
    for (const [name, hash] of inspected.hashes) {
      check(Object.hasOwn(index.files, name) && index.files[name].sha256 === hash, `曲绘 ZIP 与索引不一致：${name}`)
      packaged.set(name, hash)
    }
    log(`  ✓ 曲绘分包 ${archives.size}/${index.archives.length}：${inspected.files} 文件`)
  }
  check(packaged.size === entries.length, '曲绘 ZIP 文件数与索引不一致')
  for (const [relative, file] of objects) {
    const contentType = /\.png$/i.test(relative) ? 'image/png' : /\.webp$/i.test(relative) ? 'image/webp' : 'image/jpeg'
    const bytes = (await reader.read(prefix + relative, file.bytes, contentType)).bytes
    check(bytes.length === file.bytes && sha256(bytes) === file.sha256, `曲绘对象大小或 SHA-256 校验失败：${relative}`)
    const image = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      || bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    check(image, `曲绘文件不是支持的图片格式：${relative}`)
  }
  if (!reader.remote) {
    const source = path.join(path.dirname(reader.root), 'illustrations')
    if ((await fs.stat(source).catch(() => null))?.isDirectory()) {
      const count = await compareSource(source, packaged, 'illustrations')
      log(`✓ illustrations/：${count} 个源文件与共享索引、ZIP、对象完全一致`)
    }
  }
  log(`✓ 共享曲绘：${entries.length} 文件，${objects.size} 个独立对象，${archives.size} 个分包，${total} bytes`)
  return { files: entries.length, objects: objects.size, archives: archives.size, bytes: total }
}

export async function verifyRepository(target, { strictHttp = false, log = console.log } = {}) {
  let reader
  if (/^https?:\/\//i.test(target)) reader = new RemoteReader(target, strictHttp)
  else {
    const requestedRoot = path.resolve(target)
    let root = requestedRoot, sourceRoot
    try { await fs.access(path.join(root, 'index.json')) }
    catch {
      try { await fs.access(path.join(root, 'public', 'index.json')); root = path.join(root, 'public') }
      catch { throw new IntegrityError(`在 ${root} 或其 public/ 下找不到 index.json`) }
    }
    const sourceCandidate = path.join(root === requestedRoot ? path.dirname(root) : requestedRoot, 'song-data')
    try { if ((await fs.stat(sourceCandidate)).isDirectory()) sourceRoot = sourceCandidate } catch {}
    reader = new LocalReader(root, sourceRoot)
  }
  log(`检查资源仓库：${reader.label}`)
  const indexResult = await reader.read('index.json', MAX_INDEX, 'application/json')
  const latestResult = await reader.read('latest.json', 16384, 'application/json')
  const tabResult = await reader.read('index.tab', MAX_INDEX, 'text/plain')
  const index = parseJson(indexResult.bytes, 'index.json'), latest = parseJson(latestResult.bytes, 'latest.json')
  check(index?.schemaVersion === 1 && Array.isArray(index.releases) && index.releases.length > 0 && index.releases.length <= 10000, 'index.json 的 schemaVersion 或 releases 无效')
  const versions = new Set()
  index.releases.forEach((pointer, position) => {
    validatePointer(pointer, `index.json.releases[${position}]`)
    check(!versions.has(pointer.version), `index.json 版本重复：${pointer.version}`); versions.add(pointer.version)
    if (position) check(compareVersions(index.releases[position - 1].version, pointer.version) > 0, 'index.json 必须按资源版本从新到旧严格排序')
  })
  validatePointer(latest, 'latest.json')
  check(JSON.stringify(latest) === JSON.stringify(index.releases[0]), 'latest.json 必须与 index.json 第一项完全一致')
  const expectedTab = ['version\tphigros\tcode\tpackages', ...index.releases.map(item =>
    [item.version, item.game.version, item.game.code, item.packages.join(',')].join('\t'))].join('\n') + '\n'
  check(tabResult.bytes.toString('utf8') === expectedTab, 'index.tab 与 index.json 不一致')
  log(`✓ 索引：${index.releases.length} 个版本，latest=${latest.version}`)
  const errors = []
  for (const pointer of index.releases) {
    try {
      const verified = await verifyVersion(reader, pointer, log)
      if (pointer.version === latest.version && reader.sourceRoot) {
        const count = await compareSource(reader.sourceRoot, verified.packageHashes['song-data'])
        log(`✓ song-data/：${count} 个源文件与 latest ZIP 完全一致`)
      }
    }
    catch (error) { errors.push(error); log(`✗ ${pointer.version}：${error.message}`) }
  }
  check(errors.length === 0, `${errors.length} 个版本校验失败`)
  const illustrations = await verifyIllustrations(reader, log)
  for (const warning of reader.warnings) log(`⚠ ${warning}`)
  log(`\n校验通过：${index.releases.length} 个版本，${reader.warnings.length} 个 HTTP 配置警告。`)
  return { versions: index.releases.map(item => item.version), latest: latest.version, illustrations, warnings: reader.warnings }
}

function usage() {
  return `用法：
  node verify.mjs                         检查当前目录；若有 public/ 则检查 public/
  node verify.mjs /path/to/public         检查指定本地发布目录
  node verify.mjs https://host/path/v1/   完整下载并检查远端仓库
  node verify.mjs --strict-http URL       将 Content-Type/Cache-Control 建议视为错误`
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) { console.log(usage()); process.exit(0) }
  const strictHttp = args.includes('--strict-http')
  const positionals = args.filter(arg => arg !== '--strict-http')
  if (positionals.length > 1) { console.error(usage()); process.exit(2) }
  try { await verifyRepository(positionals[0] || process.cwd(), { strictHttp }) }
  catch (error) {
    console.error(`\n校验失败：${error.message}`)
    process.exitCode = 1
  }
}
