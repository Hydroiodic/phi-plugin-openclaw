import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import saveHistory from './saveHistory.js'
import { isSessionToken } from '../../lib/sessionToken.js'
import atomicFileWriter from '../filesystem/atomicFile.js'

/** Bounded ZIP reads shared by account-data and theme restoration. */
export class BackupArchive {
    /** @param {import('jszip')} zip @param {{maxFileBytes?:number,maxTotalBytes?:number,maxEntries?:number}} [limits] */
    constructor(zip, limits = {}) {
        this.zip = zip
        this.maxFileBytes = limits.maxFileBytes ?? 128 * 1024 * 1024
        this.maxTotalBytes = limits.maxTotalBytes ?? 1024 * 1024 * 1024
        this.totalBytes = 0
        this.entries = Object.values(zip.files)
        if (this.entries.length > (limits.maxEntries ?? 50_000)) throw new Error('备份文件数量超出安全限制')
        for (const entry of this.entries) {
            const original = /** @type {any} */ (entry).unsafeOriginalName ?? entry.name
            const name = entry.dir ? original.replace(/\/$/, '') : original
            if (
                original !== entry.name ||
                !name ||
                name.includes('\0') ||
                name.includes('\\') ||
                name.split('/').some((/** @type {string} */ part) => !part || part === '.' || part === '..') ||
                /^[a-z]:/i.test(name)
            )
                throw new Error('备份包含不安全的路径')
            const mode = Number(entry.unixPermissions) & 0o170000
            if (mode === 0o120000) throw new Error('备份不能包含符号链接')
        }
    }

    /** @param {import('jszip').JSZipObject} entry @param {number} [limit] */
    async read(entry, limit = this.maxFileBytes) {
        const source = /** @type {Readable} */ (entry.nodeStream())
        const stream = new Readable({ read() {} }).wrap(source)
        const chunks = []
        let size = 0
        try {
            for await (const chunk of stream) {
                size += chunk.length
                this.totalBytes += chunk.length
                if (size > Math.min(limit, this.maxFileBytes) || this.totalBytes > this.maxTotalBytes) {
                    throw new Error('备份解压数据超出安全限制')
                }
                chunks.push(chunk)
            }
        } finally {
            stream.destroy()
            source.destroy()
        }
        return Buffer.concat(chunks, size)
    }

    /** @param {import('jszip').JSZipObject} entry */
    async readJson(entry) {
        let value
        try {
            value = JSON.parse((await this.read(entry, 16 * 1024 * 1024)).toString('utf8'))
        } catch (error) {
            // JSON parser messages can contain source data, including credentials.
            throw new Error('备份包含无效或过大的 JSON 数据')
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份 JSON 必须是对象')
        return value
    }
}

/** Restores a prevalidated plan and does not resolve until every write is complete. */
export class BackupRestoreService {
    /** @param {{saveRoot:string,pluginDataRoot:string,credentialStore:{setSessionToken:(userId:string,token:phigrosToken)=>Promise<unknown>}}} options */
    constructor(options) {
        this.saveRoot = path.resolve(options.saveRoot)
        this.pluginDataRoot = path.resolve(options.pluginDataRoot)
        this.credentialStore = options.credentialStore
    }

    /** @param {string} root @param {string[]} segments */
    async assertSafeDestination(root, segments) {
        let current = root
        for (const segment of ['', ...segments]) {
            if (segment) current = path.join(current, segment)
            try {
                if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('恢复目标不能是符号链接')
            } catch (error) {
                if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
            }
        }
        return current
    }

    /** @param {string} file */
    async readLocal(file) {
        try {
            return JSON.parse(await fs.readFile(file, 'utf8'))
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
            throw new Error('本地数据无法读取，请检查文件后重试恢复')
        }
    }

    /** @param {string} file @param {unknown} value */
    async writeJson(file, value) {
        atomicFileWriter.write(file, JSON.stringify(value))
    }

    /** Validate all paths and JSON before modifying any user data. @param {BackupArchive} archive */
    async prepare(archive) {
        /** @type {{file:string,value:any}[]} */
        const writes = []
        /** @type {[string,phigrosToken][]} */
        const credentials = []
        for (const entry of archive.entries) {
            if (entry.dir || entry.name.startsWith('themes/')) continue
            const parts = entry.name.split('/')
            if (entry.name === 'user_token.json') {
                const data = await archive.readJson(entry)
                for (const [userId, token] of Object.entries(data)) {
                    if (!userId || userId.length > 512 || /[\u0000-\u001f\u007f]/.test(userId) || !isSessionToken(token))
                        throw new Error('备份中的用户凭证格式无效')
                    credentials.push([userId, /** @type {phigrosToken} */ (token)])
                }
                continue
            }
            let root
            if (
                parts[0] === 'saveData' &&
                parts.length === 3 &&
                isSessionToken(parts[1]) &&
                ['save.json', 'history.json'].includes(parts[2])
            ) {
                root = this.saveRoot
            } else if (
                parts[0] === 'pluginData' &&
                parts.length === 2 &&
                parts[1].endsWith('.json') &&
                !/[\u0000-\u001f\u007f:]/.test(parts[1])
            ) {
                root = this.pluginDataRoot
            } else {
                throw new Error('备份包含无法识别的数据路径')
            }
            const file = await this.assertSafeDestination(root, parts.slice(1))
            let value = await archive.readJson(entry)
            if (root === this.saveRoot) {
                const old = await this.readLocal(file)
                if (parts[2] === 'history.json') {
                    try {
                        value = new saveHistory(value)
                        value.add(new saveHistory(old))
                    } catch {
                        throw new Error('备份或本地历史记录格式无效')
                    }
                } else {
                    const modifiedAt = Date.parse(value?.saveInfo?.modifiedAt?.iso)
                    if (!Number.isFinite(modifiedAt) || (value.session && value.session !== parts[1])) {
                        throw new Error('备份中的存档信息无效')
                    }
                    if (Date.parse(old?.saveInfo?.modifiedAt?.iso) > modifiedAt) value = old
                }
            }
            writes.push({ file, value })
        }
        return { writes, credentials }
    }

    /** @param {Awaited<ReturnType<BackupRestoreService['prepare']>>} plan */
    async apply(plan) {
        for (const { file, value } of plan.writes) await this.writeJson(file, value)
        for (const [userId, token] of plan.credentials) await this.credentialStore.setSessionToken(userId, token)
        return { files: plan.writes.length, credentials: plan.credentials.length }
    }
}
