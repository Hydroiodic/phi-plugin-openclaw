import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** Converts business message segments into OpenClaw text/media payloads. */
export class MessagePayloadEncoder {
  /** @param {string} mediaRoot */
  constructor(mediaRoot) {
    this.mediaRoot = mediaRoot
  }

  /** @param {any} message */
  async encode(message) {
    /** @type {string[]} */
    const texts = []
    /** @type {string[]} */
    const mediaUrls = []
    /** @type {string[]} */
    const files = []
    const ancestors = new Set()
    /** @param {any} item @param {number} [depth] @returns {Promise<void>} */
    const visit = async (item, depth = 0) => {
      if (depth > 100) throw new RangeError('消息嵌套层数过多。')
      if (Array.isArray(item)) {
        if (ancestors.has(item)) throw new TypeError('消息包含循环引用。')
        ancestors.add(item)
        try {
          for (const part of item) await visit(part, depth + 1)
        } finally {
          ancestors.delete(item)
        }
        return
      }
      if (item == null || item === false) return
      if (!item.__phiSegment) {
        texts.push(typeof item === 'object' && 'message' in item ? String(item.message) : String(item))
        return
      }
      if (item.type === 'at') return
      if (item.type !== 'image') {
        texts.push(String(item.text ?? ''))
        return
      }
      if (typeof item.data === 'string' && /^https?:\/\//i.test(item.data)) {
        const url = new URL(item.data)
        if (url.username || url.password) throw new TypeError('图片地址不能包含凭据。')
        mediaUrls.push(url.href)
        return
      }
      const bytes = await this.imageBytes(item.data)
      const ext = bytes[0] === 0xff ? '.jpg' : bytes.subarray(0, 4).toString() === 'RIFF' ? '.webp' : '.png'
      await fs.mkdir(this.mediaRoot, { recursive: true, mode: 0o700 })
      const file = path.join(this.mediaRoot, `phi-${randomUUID()}${ext}`)
      const handle = await fs.open(file, 'wx', 0o600)
      files.push(file)
      try {
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
      mediaUrls.push(file)
    }
    try {
      await visit(message)
    } catch (error) {
      // A partially converted reply will never be sent; leave no orphan files.
      await Promise.all(files.map(file => fs.rm(file, { force: true }).catch(() => {})))
      throw error
    }
    return { ...(texts.length ? { text: texts.join('') } : {}), ...(mediaUrls.length ? { mediaUrls } : {}) }
  }

  /** @param {unknown} data */
  async imageBytes(data) {
    if (typeof data === 'string') {
      if (data.startsWith('base64://')) data = this.decodeBase64(data.slice(9))
      else if (data.startsWith('data:')) {
        const match = /^data:image\/[\w.+-]+;base64,([\s\S]*)$/i.exec(data)
        if (!match) throw new TypeError('图片 data URL 必须使用 base64 编码。')
        data = this.decodeBase64(match[1])
      } else data = await fs.readFile(data.startsWith('file:') ? fileURLToPath(data) : data)
    }
    if (!Buffer.isBuffer(data) && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) throw new TypeError('不支持的图片数据。')
    const bytes = Buffer.isBuffer(data)
      ? data
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data)
    if (!bytes.length) throw new TypeError('图片数据为空。')
    return bytes
  }

  /** @param {string} value */
  decodeBase64(value) {
    const normalized = value.replace(/\s+/g, '')
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1)
      throw new TypeError('图片 base64 编码无效。')
    return Buffer.from(normalized, 'base64')
  }
}
