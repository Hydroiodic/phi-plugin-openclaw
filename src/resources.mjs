// Static resource repository v1. No shell commands or server-side database.
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import JSZip from 'jszip'

export const DEFAULT_RESOURCE_URL = 'https://hydroiodic.site/phi-plugin-openclaw/resources/v1/'
// Base release follows the game version; -rN is an optional immutable data revision.
export const RESOURCE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-r([1-9]\d*))?$/
export const REQUIRED_INFO = [
  'info.csv',
  'infolist.json',
  'notesInfo.json',
  'oldNotesInfo.json',
  'spinfo.json',
  'nicklist.yaml',
  'chaplist.yaml',
  'avatar.txt',
  'tips.txt',
  'notice.json',
  'jrrp.json',
  'sentences.json',
  'help.json',
  'help/api.json',
]
export const sha256 = data => createHash('sha256').update(data).digest('hex')
const MAX_ARCHIVE = 128 * 1024 * 1024,
  MAX_UNPACKED = 512 * 1024 * 1024,
  MAX_FILE = 32 * 1024 * 1024
const pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .version.split('.')
  .map(Number)
export const allowedResourceFile = (name, kind) =>
  (kind === 'song-data' ? /\.(json|csv|ya?ml|txt|md)$/i : /\.(png|jpe?g|webp|txt|md)$/i).test(name) ||
  /(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE|AUTHORS)$/i.test(name)

export class ResourceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ResourceError'
  }
}
function check(condition, message) {
  if (!condition) throw new ResourceError(message)
}
export function resourceOptions(config = {}, env = process.env) {
  let base
  try {
    base = new URL(env.PHI_RESOURCE_BASE_URL || config.resourceBaseUrl || DEFAULT_RESOURCE_URL)
  } catch {
    throw new ResourceError('资源地址不是有效 URL。')
  }
  check(
    base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)),
    '资源地址须为 HTTPS（本机调试允许 HTTP）。',
  )
  check(!base.username && !base.password && !base.search && !base.hash, '资源地址不能包含凭据、查询参数或片段。')
  base.pathname = base.pathname.replace(/\/*$/, '/')
  const version = env.PHI_RESOURCE_VERSION || config.resourceVersion || 'latest'
  check(version === 'latest' || RESOURCE_VERSION.test(version), '资源版本应为游戏版本（如 3.20.0）、资源修订版（如 3.20.0-r1）或 latest。')
  return { baseUrl: base.href, version, illustrations: config.downloadIllustrations === true }
}

export function validateResourcePath(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\\:%\x00-\x1f\x7f]/.test(value), '资源包含不安全路径。')
  check(
    value
      .split('/')
      .every(part => part && !part.startsWith('.') && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part)),
    '资源包含不安全路径。',
  )
  return value
}
async function download(baseUrl, relative, maxBytes, signal) {
  const url = new URL(validateResourcePath(relative).split('/').map(encodeURIComponent).join('/'), baseUrl),
    controller = new AbortController()
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]),
    })
    check(response.ok, `资源服务器返回 HTTP ${response.status}；请确认已上传版本索引和 ZIP。`)
    const declaredSize = Number(response.headers.get('content-length') || 0)
    check(Number.isSafeInteger(declaredSize) && declaredSize >= 0 && declaredSize <= maxBytes, '资源下载超过大小限制或长度无效。')
    check(response.body, '资源服务器返回空响应。')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      check(size <= maxBytes, '资源下载超过大小限制。')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof ResourceError) throw error
    throw new ResourceError('资源请求失败或传输中断，请检查资源镜像地址、HTTPS 和网络；已有缓存未删除。')
  } finally {
    controller.abort()
  }
}
function json(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new ResourceError('资源索引不是有效 JSON。')
  }
}
export function validateResourcePointer(pointer) {
  check(pointer?.schemaVersion === 1 && RESOURCE_VERSION.test(pointer.version), '不支持的资源索引格式或版本。')
  check(pointer.manifest === `v/${pointer.version}/metadata.json` && /^[a-f0-9]{64}$/.test(pointer.sha256), '资源清单路径或 SHA-256 无效。')
  return pointer
}
export function validateResourceIndex(index) {
  check(index?.schemaVersion === 1 && Array.isArray(index.releases) && index.releases.length <= 10000, '资源版本列表无效。')
  const versions = new Set()
  for (const pointer of index.releases) {
    validateResourcePointer(pointer)
    check(!versions.has(pointer.version), '资源版本列表包含重复版本。')
    versions.add(pointer.version)
    if (pointer.game !== undefined)
      check(
        pointer.game?.version === pointer.version.split('-r')[0] && Number.isSafeInteger(pointer.game.code) && pointer.game.code > 0,
        '资源版本列表中的游戏版本无效。',
      )
    if (pointer.packages !== undefined)
      check(
        Array.isArray(pointer.packages) && pointer.packages.length === 1 && pointer.packages[0] === 'song-data',
        '资源版本列表中的资源包种类无效。',
      )
  }
  return index
}
export function validateManifest(manifest) {
  check(
    manifest?.schemaVersion === 1 && manifest.dataFormat === 'phi-info-v1' && RESOURCE_VERSION.test(manifest.version),
    '不支持的资源数据格式。',
  )
  check(
    /^\d+\.\d+\.\d+$/.test(manifest.game?.version) && Number.isSafeInteger(manifest.game.code) && manifest.game.code > 0,
    '资源缺少游戏版本。',
  )
  check(manifest.version.split('-r')[0] === manifest.game.version, '资源版本必须与清单的游戏版本一致。')
  check(/^\d+\.\d+\.\d+$/.test(manifest.minPluginVersion), '资源缺少最低插件版本。')
  const minimum = manifest.minPluginVersion.split('.').map(Number)
  const firstDifference = minimum.findIndex((part, index) => part !== pluginVersion[index])
  check(firstDifference < 0 || minimum[firstDifference] < pluginVersion[firstDifference], '此资源需要更新的插件版本，请先更新插件。')
  check(
    manifest.packages && typeof manifest.packages === 'object' && !Array.isArray(manifest.packages) && manifest.packages['song-data'],
    '资源清单缺少 song-data。',
  )
  for (const [kind, pack] of Object.entries(manifest.packages)) {
    check(
      kind === 'song-data' && Array.isArray(pack?.archives) && pack.archives.length > 0 && pack.archives.length <= 256,
      '资源包种类或分包数量无效。',
    )
    const paths = new Set()
    for (const archive of pack.archives) {
      validateResourcePath(archive?.path)
      check(
        archive.path.startsWith(`v/${manifest.version}/${kind}-`) && archive.path.endsWith('.zip') && !paths.has(archive.path),
        '资源 ZIP 路径无效或重复。',
      )
      paths.add(archive.path)
      check(/^[a-f0-9]{64}$/.test(archive.sha256), '资源包 SHA-256 无效。')
      for (const [key, max] of [
        ['bytes', MAX_ARCHIVE],
        ['unpackedBytes', MAX_UNPACKED],
        ['fileCount', 10000],
      ]) {
        check(Number.isSafeInteger(archive[key]) && archive[key] > 0 && archive[key] <= max, `资源包 ${key} 超出限制。`)
      }
    }
  }
  return manifest
}
export async function extractArchive(buffer, archive, destination, kind, seen = new Set()) {
  check(['song-data', 'illustrations'].includes(kind), '资源包种类无效。')
  check(buffer.length === archive.bytes && sha256(buffer) === archive.sha256, '资源 ZIP 大小或 SHA-256 校验失败。')
  let zip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new ResourceError('资源 ZIP 无效。')
  }
  let total = 0,
    count = 0
  for (const entry of Object.values(zip.files)) {
    // JSZip sanitizes names; validate the ORIGINAL name as well to reject zip-slip.
    const name = validateResourcePath((entry.unsafeOriginalName || entry.name).replace(/\/$/, ''))
    check(name === entry.name.replace(/\/$/, ''), '资源 ZIP 包含路径穿越。')
    const mode = Number(entry.unixPermissions || 0) & 0o170000
    check(!mode || mode === (entry.dir ? 0o040000 : 0o100000), '资源 ZIP 不允许链接或特殊文件。')
    if (entry.dir) {
      await fs.mkdir(path.join(destination, name), { recursive: true })
      continue
    }
    check(!seen.has(name.toLowerCase()), '资源分包文件重复。')
    seen.add(name.toLowerCase())
    check(allowedResourceFile(name, kind), '资源包含不允许的文件类型。')
    check(++count <= archive.fileCount, '资源 ZIP 文件数量不符。')
    const chunks = []
    let size = 0
    // Bound actual inflated bytes, not just attacker-controlled central-directory sizes.
    for await (const chunk of new Readable().wrap(entry.nodeStream())) {
      size += chunk.length
      total += chunk.length
      check(size <= MAX_FILE && total <= archive.unpackedBytes && total <= MAX_UNPACKED, '资源解压超过大小限制。')
      chunks.push(chunk)
    }
    const target = path.join(destination, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 })
  }
  check(count === archive.fileCount && total === archive.unpackedBytes, '资源 ZIP 实际内容与清单不符。')
}
export async function validateInfoDirectory(dir) {
  for (const name of REQUIRED_INFO) check((await fs.stat(path.join(dir, name)).catch(() => null))?.isFile(), `曲目元数据缺少 ${name}。`)
  for (const name of ['DLC', 'oldInfo'])
    check((await fs.stat(path.join(dir, name)).catch(() => null))?.isDirectory(), `曲目元数据缺少 ${name} 目录。`)
  for (const name of REQUIRED_INFO.filter(name => name.endsWith('.json'))) json(await fs.readFile(path.join(dir, name)))
}
async function atomicJson(target, value) {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}
async function readCachedJson(file) {
  try {
    return json(await fs.readFile(file))
  } catch (error) {
    // Corrupt optional pointers/markers are cache misses, not valid releases.
    if (error instanceof ResourceError || error.code === 'ENOENT') return null
    throw error
  }
}

/** Owns one mirror's immutable resource cache and serializes its publication. */
export class ResourceRepository {
  static #inflight = new Map()
  static #queues = new Map()

  constructor({ dataRoot, config = {}, env = process.env } = {}) {
    this.options = resourceOptions(config, env)
    if (dataRoot !== undefined) {
      check(typeof dataRoot === 'string' && dataRoot.trim().length > 0, '资源缓存目录无效。')
      this.root = path.join(path.resolve(dataRoot), 'resource-cache', sha256(this.options.baseUrl).slice(0, 16))
    }
  }

  async listVersions() {
    const index = json(await download(this.options.baseUrl, 'index.json', 2 * 1024 * 1024))
    return validateResourceIndex(index).releases
  }

  async #resolveManifest() {
    const pointer =
      this.options.version === 'latest'
        ? validateResourcePointer(json(await download(this.options.baseUrl, 'latest.json', 16384)))
        : (await this.listVersions()).find(entry => entry.version === this.options.version)
    check(pointer, `资源仓库未发布版本 ${this.options.version}。`)
    const bytes = await download(this.options.baseUrl, pointer.manifest, 2 * 1024 * 1024)
    check(sha256(bytes) === pointer.sha256, '资源清单 SHA-256 校验失败。')
    const manifest = validateManifest(json(bytes))
    check(manifest.version === pointer.version, '资源清单版本不一致。')
    return manifest
  }

  async #cachedManifest(version) {
    try {
      const release = path.join(this.root, 'v', version)
      const manifest = validateManifest(await readCachedJson(path.join(release, 'metadata.json')))
      check(manifest.version === version, '缓存版本不一致。')
      for (const kind of ['song-data']) {
        const marker = await readCachedJson(path.join(release, kind, '.complete.json'))
        check(manifest.packages[kind] && marker?.fingerprint === sha256(JSON.stringify(manifest.packages[kind])), '缓存未完成。')
      }
      await validateInfoDirectory(path.join(release, 'song-data'))
      return manifest
    } catch (error) {
      if (error instanceof ResourceError || error.code === 'ENOENT') return null
      throw error
    }
  }

  async #installPackage(manifest, kind) {
    const pack = manifest.packages[kind]
    check(pack, '此资源版本没有发布曲绘包，请关闭 downloadIllustrations 或更换版本。')
    const destination = path.join(this.root, 'v', manifest.version, kind)
    const fingerprint = sha256(JSON.stringify(pack))
    const marker = await readCachedJson(path.join(destination, '.complete.json'))
    if (marker?.fingerprint === fingerprint) {
      if (kind === 'song-data') await validateInfoDirectory(destination)
      return
    }
    // Never overwrite an existing immutable version, including a differing mirror release.
    check(
      !(await fs.lstat(destination).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })),
      '已有资源版本与清单不一致；请发布新版本号或先手动移走损坏缓存。',
    )
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    const stage = await fs.mkdtemp(path.join(path.dirname(destination), `.${kind}-`))
    try {
      const seen = new Set()
      for (const archive of pack.archives)
        await extractArchive(await download(this.options.baseUrl, archive.path, archive.bytes), archive, stage, kind, seen)
      if (kind === 'song-data') await validateInfoDirectory(stage)
      await atomicJson(path.join(stage, '.complete.json'), { fingerprint })
      try {
        await fs.rename(stage, destination)
      } catch (error) {
        // A second process can finish the same immutable package concurrently.
        const other = await readCachedJson(path.join(destination, '.complete.json'))
        if (other?.fingerprint !== fingerprint) throw error
        if (kind === 'song-data') await validateInfoDirectory(destination)
      }
    } finally {
      await fs.rm(stage, { recursive: true, force: true })
    }
  }

  async #ensure(refresh) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    let version = this.options.version
    if (version === 'latest' && !refresh) {
      const current = await readCachedJson(path.join(this.root, 'current.json'))
      if (RESOURCE_VERSION.test(current?.version)) version = current.version
    }
    let manifest = RESOURCE_VERSION.test(version) && !refresh ? await this.#cachedManifest(version) : null
    if (!manifest) {
      manifest = await this.#resolveManifest()
      await this.#installPackage(manifest, 'song-data')
      await atomicJson(path.join(this.root, 'v', manifest.version, 'metadata.json'), manifest)
      await atomicJson(path.join(this.root, 'current.json'), { version: manifest.version })
    }
    const release = path.join(this.root, 'v', manifest.version)
    if (this.options.illustrations) {
      const { IllustrationRepository } = await import('./illustrations.mjs')
      const illustrations = new IllustrationRepository({ baseUrl: this.options.baseUrl, cacheRoot: this.root })
      try {
        await illustrations.installAll({ refresh })
      } finally {
        await illustrations.close()
      }
    }
    return {
      manifest,
      infoPath: path.join(release, 'song-data'),
      illustrationPath: path.join(this.root, 'illustrations'),
      cacheRoot: this.root,
      baseUrl: this.options.baseUrl,
    }
  }

  async ensure({ refresh = false } = {}) {
    check(this.root, '资源缓存目录未配置。')
    const key = JSON.stringify([this.root, this.options.version, this.options.illustrations, refresh])
    if (ResourceRepository.#inflight.has(key)) return ResourceRepository.#inflight.get(key)
    // Different options still share package paths and current.json. Serialize those
    // operations too, while deduplicating identical requests and allowing retries.
    const previous = ResourceRepository.#queues.get(this.root) || Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.#ensure(refresh))
    ResourceRepository.#inflight.set(key, task)
    ResourceRepository.#queues.set(this.root, task)
    try {
      return await task
    } finally {
      ResourceRepository.#inflight.delete(key)
      if (ResourceRepository.#queues.get(this.root) === task) ResourceRepository.#queues.delete(this.root)
    }
  }
}

export async function listResourceVersions(config = {}, env = process.env) {
  return new ResourceRepository({ config, env }).listVersions()
}
export async function ensureResources({ refresh = false, ...options }) {
  return new ResourceRepository(options).ensure({ refresh })
}

export { download as downloadResource }
