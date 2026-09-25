import { createHash } from 'node:crypto'
import cloudTransport from '../cloudTransport.js'
import { tapRegion } from './endpoints.js'

export default new (class LCHelper {
    /**
     * 使用 TapTap 授权数据登录 LeanCloud，返回包含 sessionToken 的用户对象。
     * @param {Record<string, unknown>} data
     * @param {boolean} [withGlobal]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     * @returns {Promise<any>}
     */
    async loginAndGetToken(data, withGlobal = false, options = {}) {
        const region = tapRegion(withGlobal)
        const timestamp = Math.floor(Date.now() / 1000)
        const sign = createHash('md5').update(`${timestamp}${region.appKey}`).digest('hex')
        const response = await cloudTransport.request(
            `${region.leanCloud}/users`,
            {
                method: 'post',
                headers: { 'X-LC-Id': region.clientId, 'Content-Type': 'application/json', 'X-LC-Sign': `${sign},${timestamp}` },
                body: JSON.stringify({ authData: { taptap: data } }),
                signal: options.signal,
            },
            { timeoutMs: options.timeoutMs },
        )
        try {
            return JSON.parse(response.bytes.toString('utf8'))
        } catch {
            throw new Error('云端登录数据格式无效，请稍后重试。')
        }
    }
})()
