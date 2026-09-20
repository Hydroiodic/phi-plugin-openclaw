/** Safe errors deliberately carry no request headers, URLs or response bodies. */
export class CloudTransportError extends Error {
    /** @param {string} code @param {string} message @param {number} [status] */
    constructor(code, message, status) { super(message); this.name = 'CloudTransportError'; this.code = code; this.status = status }
}

export class CloudTransport {
    /** @param {{fetcher?: typeof fetch, timeoutMs?: number, maxBytes?: number}} [options] */
    constructor({ fetcher = (url, options) => globalThis.fetch(url, options), timeoutMs = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
        this.fetcher = fetcher
        this.timeoutMs = timeoutMs
        this.maxBytes = maxBytes
    }

    /** @param {string | URL} url @param {RequestInit} [options]
     * @param {{allowHttpErrors?: boolean, timeoutMs?: number, maxBytes?: number}} [policy] */
    async request(url, options = {}, policy = {}) {
        const maxBytes = policy.maxBytes ?? this.maxBytes, timeoutMs = policy.timeoutMs ?? this.timeoutMs
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) {
            throw new TypeError('云端请求限制参数无效。')
        }
        try {
            const parsed = new URL(url)
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
        } catch { throw new CloudTransportError('CLOUD_URL', '云端地址无效。') }
        const timeout = new AbortController()
        const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal
        const timer = setTimeout(() => timeout.abort(), timeoutMs)
        timer.unref?.()
        /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
        let reader
        const abortedError = () => new CloudTransportError(timeout.signal.aborted ? 'CLOUD_TIMEOUT' : 'CLOUD_ABORTED',
            timeout.signal.aborted ? '云端请求超时，请稍后重试。' : '云端请求已取消。')
        /** @type {() => void} */
        let onAbort = () => {}
        const aborted = new Promise((_, reject) => {
            onAbort = () => reject(abortedError())
            signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
            if (signal.aborted) throw abortedError()
            const work = (async () => {
                const response = await this.fetcher(url, { ...options, signal })
                if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw abortedError() }
                if (!policy.allowHttpErrors && !response.ok) {
                    void response.body?.cancel().catch(() => {})
                    throw new CloudTransportError('CLOUD_HTTP', `云端请求失败（HTTP ${response.status}），请稍后重试。`, response.status)
                }
                const length = response.headers.get('content-length')
                if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
                    void response.body?.cancel().catch(() => {})
                    throw new CloudTransportError('CLOUD_SIZE', '云端响应超出安全大小限制。')
                }
                const chunks = []; let size = 0
                reader = response.body?.getReader()
                if (reader) while (true) {
                    const { value, done } = await reader.read()
                    if (signal.aborted) throw abortedError()
                    if (done) break
                    size += value.byteLength
                    if (size > maxBytes) throw new CloudTransportError('CLOUD_SIZE', '云端响应超出安全大小限制。')
                    chunks.push(Buffer.from(value))
                }
                return { bytes: Buffer.concat(chunks, size), status: response.status, headers: response.headers }
            })()
            return /** @type {Awaited<typeof work>} */ (await Promise.race([work, aborted]))
        } catch (error) {
            if (error instanceof CloudTransportError) throw error
            throw new CloudTransportError('CLOUD_NETWORK', '云端连接失败，请检查网络后重试。')
        } finally {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            if (reader) void reader.cancel().catch(() => {})
        }
    }

    /** @param {string | URL} url @param {RequestInit} [options]
     * @param {{allowHttpErrors?: boolean, timeoutMs?: number, maxBytes?: number}} [policy] */
    async json(url, options, policy) {
        const { bytes } = await this.request(url, options, policy)
        try { return JSON.parse(bytes.toString('utf8')) }
        catch { throw new CloudTransportError('CLOUD_JSON', '云端返回的数据格式无效，请稍后重试。') }
    }
}

export default new CloudTransport()
