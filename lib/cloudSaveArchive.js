import JSZip from 'jszip'
import { Readable } from 'node:stream'

export const CLOUD_SAVE_LIMITS = Object.freeze({ maxArchiveBytes: 4 * 1024 * 1024, maxEntryBytes: 4 * 1024 * 1024,
    maxTotalBytes: 8 * 1024 * 1024, maxEntries: 32 })
const REQUIRED_FILES = ['gameProgress', 'user', 'settings', 'gameRecord']
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
    return value >>> 0
})

/** @param {Buffer} bytes */
function crc32(bytes) {
    let crc = 0xffffffff
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8
    return (crc ^ 0xffffffff) >>> 0
}

/** @typedef {{name: string, data: Buffer, compression: 'STORE' | 'DEFLATE'}} ArchiveEntry */

/** Validates cloud saves before bounded, streaming decompression. */
export class CloudSaveArchive {
    /** @param {Partial<typeof CLOUD_SAVE_LIMITS>} [limits] */
    constructor(limits = {}) {
        this.limits = { ...CLOUD_SAVE_LIMITS, ...limits }
        for (const limit of Object.values(this.limits)) if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('云存档限制参数无效。')
    }

    /** Reject metadata bombs and ambiguous entries before JSZip allocates entries.
     * @param {Buffer} bytes */
    inspect(bytes) {
        if (bytes.length > this.limits.maxArchiveBytes) throw new Error('云存档压缩包超出安全大小限制。')
        let end = -1
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
            if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
        }
        if (end < 0) throw new Error('云存档 ZIP 格式无效。')
        const count = bytes.readUInt16LE(end + 10)
        let cursor = bytes.readUInt32LE(end + 16)
        const size = bytes.readUInt32LE(end + 12)
        if (bytes.readUInt32LE(end + 4) !== 0 || count !== bytes.readUInt16LE(end + 8) || count > this.limits.maxEntries
            || cursor + size !== end) throw new Error('云存档 ZIP 文件数量或结构无效。')
        const entries = new Map(); let total = 0
        for (let i = 0; i < count; i++) {
            if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('云存档 ZIP 目录无效。')
            const length = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32)
            const next = cursor + 46 + length + extra + comment
            if (next > end || !length || length > 128) throw new Error('云存档 ZIP 文件名无效。')
            const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString('utf8')
            if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..' || entries.has(name)) throw new Error('云存档 ZIP 包含重复或不安全的文件名。')
            const unpacked = bytes.readUInt32LE(cursor + 24)
            entries.set(name, { size: unpacked, crc: bytes.readUInt32LE(cursor + 16), method: bytes.readUInt16LE(cursor + 10) })
            total += unpacked
            if (unpacked > this.limits.maxEntryBytes || total > this.limits.maxTotalBytes) throw new Error('云存档解压数据超出安全大小限制。')
            if (bytes.readUInt16LE(cursor + 8) & 1 || ![0, 8].includes(bytes.readUInt16LE(cursor + 10))) throw new Error('云存档 ZIP 压缩方式无效。')
            cursor = next
        }
        if (cursor !== end || REQUIRED_FILES.some(name => !entries.has(name))) throw new Error('云存档缺少必要文件或 ZIP 目录无效。')
        return entries
    }

    /** @param {Buffer} bytes @returns {Promise<Record<string, Buffer>>} */
    async read(bytes) {
        const entries = await this.readEntries(bytes)
        return Object.fromEntries(entries.filter(entry => REQUIRED_FILES.includes(entry.name)).map(entry => [entry.name, entry.data]))
    }

    /**
     * 按压缩包目录顺序解压全部条目，保留压缩方式以便原样重建。
     * @param {Buffer} bytes
     * @returns {Promise<ArchiveEntry[]>}
     */
    async readEntries(bytes) {
        const metadata = this.inspect(bytes)
        /** @type {ArchiveEntry[]} */
        const files = []
        let total = 0
        try {
            // CRC checking at load time would inflate everything before limits.
            const zip = await JSZip.loadAsync(bytes, { createFolders: false })
            for (const [name, info] of metadata) {
                const entry = zip.file(name)
                if (!entry || entry.dir || (/** @type {any} */ (entry).unsafeOriginalName ?? name) !== name) throw new Error()
                const source = /** @type {Readable} */ (entry.nodeStream())
                const stream = new Readable({ read() {} }).wrap(source)
                const chunks = []; let size = 0
                try {
                    for await (const chunk of stream) {
                        size += chunk.length; total += chunk.length
                        if (size > this.limits.maxEntryBytes || total > this.limits.maxTotalBytes) throw new Error()
                        chunks.push(chunk)
                    }
                } finally { stream.destroy(); source.destroy() }
                if (size < 1 && REQUIRED_FILES.includes(name)) throw new Error()
                const data = Buffer.concat(chunks, size)
                if (size !== info.size || crc32(data) !== info.crc) throw new Error()
                files.push({ name, data, compression: info.method === 0 ? 'STORE' : 'DEFLATE' })
            }
            return files
        } catch { throw new Error('云存档解压失败、数据损坏或超出安全限制。') }
    }

    /**
     * 按给定顺序和压缩方式打包，生成的包同样必须通过 inspect 的检查。
     * @param {ArchiveEntry[]} entries
     */
    async write(entries) {
        const zip = new JSZip()
        for (const { name, data, compression } of entries) zip.file(name, data, { compression, createFolders: false })
        const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'DOS' })
        this.inspect(bytes)
        return bytes
    }
}

export default new CloudSaveArchive()
