import { createHash } from 'node:crypto'
import defaultTransport, { CloudTransportError } from './cloudTransport.js'
import { tapRegion } from './TapTap/endpoints.js'

/** 云端返回的数据不符合预期，或插件不支持该上传方式时抛出。 */
export class SaveUploadError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.name = 'SaveUploadError'
    }
}

/** @param {Buffer} bytes */
export const md5 = bytes => createHash('md5').update(bytes).digest('hex')

/** @param {unknown} value */
function httpsUrl(value) {
    try {
        const url = new URL(String(value))
        if (url.protocol === 'https:' && !url.username && !url.password) return url
    } catch {}
    throw new SaveUploadError('云端返回的上传地址无效。')
}

/**
 * 把新存档写回 TapTap（LeanCloud）云存档。流程与游戏客户端一致：
 * 申请文件令牌 → 上传到对象存储 → 回调确认 → 让 gamesave 记录指向新文件。
 * 旧文件不会被删除，校验失败时可以把记录指回旧文件。
 */
export class CloudSaveUploader {
    /** @param {{isGlobal?: boolean, transport?: import('./cloudTransport.js').CloudTransport}} [options] */
    constructor({ isGlobal = false, transport = defaultTransport } = {}) {
        const region = tapRegion(isGlobal)
        this.baseUrl = region.leanCloud
        this.transport = transport
        this.headers = {
            'X-LC-Id': region.clientId,
            'X-LC-Key': region.appKey,
            'User-Agent': 'LeanCloud-CSharp-SDK/1.0.3',
            Accept: 'application/json',
        }
    }

    /**
     * @param {string} path
     * @param {string} session
     * @param {{method?: string, body?: unknown}} [request]
     */
    async leanCloud(path, session, { method = 'GET', body } = {}) {
        const headers = { ...this.headers, 'X-LC-Session': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }
        return this.transport.json(`${this.baseUrl}${path}`, {
            method,
            headers,
            redirect: 'error',
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
    }

    /**
     * @param {object} params
     * @param {string} params.session
     * @param {string} params.userId 云端用户 objectId
     * @param {string} params.saveId gamesave 记录的 objectId
     * @param {Buffer} params.zip 新存档压缩包
     * @param {string} params.summary 新 summary（base64）
     * @returns {Promise<{fileId: string, url: string, modifiedAt: string}>}
     */
    async upload({ session, userId, saveId, zip, summary }) {
        const acl = { [userId]: { read: true, write: true } }
        const token = await this.leanCloud('/fileTokens', session, {
            method: 'POST',
            body: {
                name: '.save',
                __type: 'File',
                ACL: acl,
                prefix: 'gamesaves',
                metaData: { size: zip.length, _checksum: md5(zip), prefix: 'gamesaves' },
            },
        })
        if (typeof token?.objectId !== 'string' || typeof token.token !== 'string' || typeof token.url !== 'string') {
            throw new SaveUploadError('云端文件令牌格式无效。')
        }
        try {
            await this.putObject(token, zip)
        } catch (error) {
            await this.leanCloud('/fileCallback', session, { method: 'POST', body: { result: false, token: token.token } }).catch(() => {})
            throw error
        }
        await this.leanCloud('/fileCallback', session, { method: 'POST', body: { result: true, token: token.token } })
        const modifiedAt = new Date().toISOString()
        await this.pointSaveAt(session, { userId, saveId, fileId: token.objectId, summary, modifiedAt })
        return { fileId: token.objectId, url: token.url, modifiedAt }
    }

    /**
     * 让 gamesave 记录指向某个文件；上传后校验失败时也用它回滚到旧文件。
     * @param {string} session
     * @param {{userId: string, saveId: string, fileId: string, summary: string, modifiedAt: string}} target
     */
    async pointSaveAt(session, { userId, saveId, fileId, summary, modifiedAt }) {
        await this.leanCloud(`/classes/_GameSave/${encodeURIComponent(saveId)}`, session, {
            method: 'PUT',
            body: {
                summary,
                modifiedAt: { __type: 'Date', iso: modifiedAt },
                gameFile: { __type: 'Pointer', className: '_File', objectId: fileId },
                ACL: { [userId]: { read: true, write: true } },
                user: { __type: 'Pointer', className: '_User', objectId: userId },
            },
        })
    }

    /**
     * @param {{provider?: string, upload_url?: string, bucket?: string, key?: string, token: string, mime_type?: string}} token
     * @param {Buffer} zip
     */
    async putObject(token, zip) {
        const body = new Uint8Array(zip)
        if (token.provider === 'qiniu') {
            if (typeof token.bucket !== 'string' || typeof token.key !== 'string') throw new SaveUploadError('云端文件令牌缺少存储位置。')
            const base = httpsUrl(token.upload_url || 'https://upload.qiniup.com').origin
            const object = `${base}/buckets/${encodeURIComponent(token.bucket)}/objects/${Buffer.from(token.key).toString('base64url')}/uploads`
            const auth = { Authorization: `UpToken ${token.token}` }
            const started = await this.transport.json(object, { method: 'POST', headers: auth, redirect: 'error' })
            if (typeof started?.uploadId !== 'string') throw new SaveUploadError('对象存储未返回上传编号。')
            const upload = `${object}/${encodeURIComponent(started.uploadId)}`
            const part = await this.transport.json(`${upload}/1`, {
                method: 'PUT',
                headers: { ...auth, 'Content-Type': 'application/octet-stream' },
                body,
                redirect: 'error',
            })
            if (typeof part?.etag !== 'string') throw new SaveUploadError('对象存储未确认分片。')
            await this.transport.request(upload, {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ parts: [{ partNumber: 1, etag: part.etag }] }),
                redirect: 'error',
            })
            return
        }
        if (token.provider === 's3') {
            await this.transport.request(httpsUrl(token.upload_url), {
                method: 'PUT',
                headers: { 'Content-Type': token.mime_type || 'application/octet-stream' },
                body,
                redirect: 'error',
            })
            return
        }
        throw new SaveUploadError('云端使用了插件尚不支持的文件存储方式，已停止上传。')
    }
}

export { CloudTransportError }
