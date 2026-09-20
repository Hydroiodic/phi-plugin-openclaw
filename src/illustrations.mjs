import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ResourceError, sha256, validateResourcePath, downloadResource, extractArchive } from './resources.mjs'
import atomicFileWriter from '../model/filesystem/atomicFile.js'
import { ILLUSTRATION_PREFIX } from '../model/filesystem/illustrationReference.js'
export { ILLUSTRATION_PREFIX, illustrationReference } from '../model/filesystem/illustrationReference.js'

export const ILLUSTRATION_DIRS = ['ill', 'illLow', 'illBlur', 'SP', 'chap', 'chartimg', 'table']
const MAX_FILE = 32 * 1024 * 1024
const check = (value, message) => { if (!value) throw new ResourceError(message) }
export const isIllustrationFile = name => ILLUSTRATION_DIRS.includes(name.split('/')[0]) && /\.(png|jpe?g|webp)$/i.test(name)
export const illustrationObjectPath = (hash, name) => `objects/${hash.slice(0, 2)}/${hash}${path.extname(name).toLowerCase()}`

/** Shared artwork has no game/plugin version; immutable objects are addressed by hash. */
export function validateIllustrationIndex(index) {
  check(index?.schemaVersion === 1 && index.files && typeof index.files === 'object' && !Array.isArray(index.files), '曲绘索引格式无效。')
  const entries = Object.entries(index.files), seen = new Set(), objects = new Map()
  check(entries.length > 0 && entries.length <= 20000, '曲绘文件数量超出限制。')
  let total = 0
  for (const [name, file] of entries) {
    validateResourcePath(name)
    check(isIllustrationFile(name) && !seen.has(name.toLowerCase()), '曲绘文件名无效或重复。')
    seen.add(name.toLowerCase())
    check(/^[a-f0-9]{64}$/.test(file?.sha256) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_FILE, '曲绘文件校验信息无效。')
    check(file.path === illustrationObjectPath(file.sha256, name), '曲绘对象路径与 SHA-256 不一致。')
    check(!objects.has(file.path) || objects.get(file.path) === file.bytes, '相同曲绘对象的大小不一致。')
    objects.set(file.path, file.bytes)
    total += file.bytes
  }
  check(total <= 8 * 1024 ** 3, '曲绘总大小超出限制。')
  check(Array.isArray(index.archives) && index.archives.length > 0 && index.archives.length <= 256, '曲绘分包数量无效。')
  const archives = new Set()
  for (const archive of index.archives) {
    check(/^[a-f0-9]{64}$/.test(archive?.sha256) && archive.path === `packages/${archive.sha256}.zip` && !archives.has(archive.path), '曲绘分包路径或哈希无效。')
    archives.add(archive.path)
    for (const [key, max] of [['bytes', 128 * 1024 ** 2], ['unpackedBytes', 512 * 1024 ** 2], ['fileCount', 10000]]) {
      check(Number.isSafeInteger(archive[key]) && archive[key] > 0 && archive[key] <= max, `曲绘分包 ${key} 无效。`)
    }
  }
  return index
}

export function parseIllustrationChecksums(bytes) {
  const hashes = new Map()
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  (index\.json|packages\/[a-f0-9]{64}\.zip)$/.exec(line)
    check(match && !hashes.has(match[2]), '曲绘 SHA256SUMS 无效。')
    hashes.set(match[2], match[1])
  }
  check(hashes.has('index.json'), '曲绘 SHA256SUMS 缺少 index.json。')
  return hashes
}

/** Download, verify and cache shared images before handing bytes to a channel or renderer. */
export class IllustrationRepository {
  constructor({ baseUrl, cacheRoot, logger = console, fallback = fileURLToPath(new URL('../resources/html/otherimg/phigros.png', import.meta.url)) }) {
    this.baseUrl = new URL('illustrations/', baseUrl).href
    this.root = path.join(cacheRoot, 'illustrations')
    this.logger = logger
    this.fallback = fallback
    this.controller = new AbortController()
    this.pending = new Map()
    this.queue = []
    this.active = 0
    this.warned = new Set()
    this.index = undefined
    this.loading = undefined
    this.bulk = undefined
    this.refreshedMissing = false
  }

  async loadIndex({ refresh = false } = {}) {
    if (this.controller.signal.aborted) throw new ResourceError('曲绘服务已关闭。')
    if (this.loading) return this.loading
    if (this.index && !refresh) return this.index
    this.loading = (async () => {
      const cache = await this.objectFile('index.json')
      if (!refresh) try {
        const stored = JSON.parse(await fs.readFile(cache, 'utf8'))
        if (sha256(JSON.stringify(stored.index)) === stored.sha256) return this.index = validateIllustrationIndex(stored.index)
      } catch { /* A damaged cache is retried from the configured repository. */ }
      const sums = parseIllustrationChecksums(await downloadResource(this.baseUrl, 'SHA256SUMS', 1024 * 1024, this.controller.signal))
      const bytes = await downloadResource(this.baseUrl, 'index.json', 8 * 1024 * 1024, this.controller.signal)
      check(sha256(bytes) === sums.get('index.json'), '曲绘索引 SHA-256 校验失败。')
      let index
      try { index = validateIllustrationIndex(JSON.parse(bytes.toString('utf8'))) }
      catch { throw new ResourceError('曲绘索引内容无效。') }
      check(sums.size === index.archives.length + 1 && index.archives.every(archive => sums.get(archive.path) === archive.sha256), '曲绘索引与 SHA256SUMS 不一致。')
      atomicFileWriter.write(cache, JSON.stringify({ index, sha256: sha256(JSON.stringify(index)) }))
      return this.index = index
    })()
    try { return await this.loading }
    finally { this.loading = undefined }
  }

  async objectFile(relative) {
    validateResourcePath(relative)
    let current = this.root
    for (const part of ['', ...relative.split('/')]) {
      if (part) current = path.join(current, part)
      try { check(!(await fs.lstat(current)).isSymbolicLink(), '曲绘缓存不能包含符号链接。') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return current
  }

  async cached(file) {
    const destination = await this.objectFile(file.path)
    try {
      const stat = await fs.stat(destination)
      if (stat.isFile() && stat.size === file.bytes && sha256(await fs.readFile(destination)) === file.sha256) return destination
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    return null
  }

  /** Maximum six transfers, including callers from separate render requests. */
  async limited(operation) {
    if (this.active >= 6) await new Promise(resolve => this.queue.push(resolve))
    else this.active++
    try {
      if (this.controller.signal.aborted) throw new ResourceError('曲绘服务已关闭。')
      return await operation()
    } finally {
      const next = this.queue.shift()
      if (next) next(); else this.active--
    }
  }

  async resolve(reference) {
    if (typeof reference !== 'string' || !reference.startsWith(ILLUSTRATION_PREFIX)) return reference
    const name = validateResourcePath(decodeURIComponent(reference.slice(ILLUSTRATION_PREFIX.length)))
    let index = await this.loadIndex()
    if (!Object.hasOwn(index.files, name)) {
      // A new game release may introduce names absent from the shared cached
      // catalog. Refresh once without discarding any verified image objects.
      const refresh = !this.refreshedMissing
      this.refreshedMissing = true
      index = await this.loadIndex({ refresh })
    }
    const file = Object.hasOwn(index.files, name) && index.files[name]
    check(file, `资源仓库缺少曲绘：${name}`)
    if (!this.pending.has(file.path)) {
      const operation = this.limited(async () => {
        const cached = await this.cached(file)
        if (cached) return cached
        const bytes = await downloadResource(this.baseUrl, file.path, file.bytes, this.controller.signal)
        check(bytes.length === file.bytes && sha256(bytes) === file.sha256, '曲绘文件大小或 SHA-256 校验失败。')
        const destination = await this.objectFile(file.path)
        atomicFileWriter.write(destination, bytes)
        return destination
      })
      this.pending.set(file.path, operation)
      operation.finally(() => this.pending.delete(file.path)).catch(() => {})
    }
    return this.pending.get(file.path)
  }

  async prepare(value) {
    const seen = new WeakMap()
    let nodes = 0
    const visit = async (item, depth = 0) => {
      check(depth <= 100 && ++nodes <= 100000, '曲绘参数层数或数量过多。')
      if (typeof item === 'string' && item.startsWith(ILLUSTRATION_PREFIX)) {
        try { return await this.resolve(item) }
        catch (error) {
          if (this.controller.signal.aborted) throw error
          if (!this.warned.has(item)) { this.warned.add(item); this.logger.warn('曲绘暂不可用，使用默认图片；请检查资源仓库与校验结果。') }
          return this.fallback
        }
      }
      if (!item || typeof item !== 'object' || item instanceof Date || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return item
      if (seen.has(item)) return seen.get(item)
      const copy = Array.isArray(item) ? [] : Object.create(Object.getPrototypeOf(item))
      seen.set(item, copy)
      await Promise.all(Object.keys(item).map(async key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if ('value' in descriptor) descriptor.value = await visit(descriptor.value, depth + 1)
        Object.defineProperty(copy, key, descriptor)
      }))
      return copy
    }
    return visit(value)
  }

  async installAll({ refresh = true } = {}) {
    if (this.bulk) return this.bulk
    this.bulk = (async () => {
      const index = await this.loadIndex({ refresh })
      const missing = new Set()
      for (const [name, file] of Object.entries(index.files)) if (!await this.cached(file)) missing.add(name)
      if (!missing.size) return { files: Object.keys(index.files).length, downloaded: 0 }
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
      const stage = await fs.mkdtemp(path.join(this.root, '.download-'))
      const seen = new Set()
      let installed = 0
      try {
        for (const archive of index.archives) {
          const bytes = await downloadResource(this.baseUrl, archive.path, archive.bytes, this.controller.signal)
          await extractArchive(bytes, archive, stage, 'illustrations', seen)
        }
        check(seen.size === Object.keys(index.files).length, '曲绘 ZIP 与文件索引数量不一致。')
        for (const [name, file] of Object.entries(index.files)) {
          const bytes = await fs.readFile(path.join(stage, name))
          check(bytes.length === file.bytes && sha256(bytes) === file.sha256, '曲绘 ZIP 内容与文件索引不一致。')
        }
        // Validate the entire package before publishing any missing object.
        for (const name of missing) {
          const file = index.files[name]
          atomicFileWriter.write(await this.objectFile(file.path), await fs.readFile(path.join(stage, name)))
          installed++
        }
        return { files: Object.keys(index.files).length, downloaded: installed }
      } finally { await fs.rm(stage, { recursive: true, force: true }) }
    })()
    try { return await this.bulk } finally { this.bulk = undefined }
  }

  async close() {
    this.controller.abort()
    await Promise.allSettled([this.loading, this.bulk, ...this.pending.values()])
  }
}
