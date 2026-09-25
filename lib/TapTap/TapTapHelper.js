import crypto from 'crypto'
import CompleteQRCodeData from './CompleteQRCodeData.js'
import { tapRegion } from './endpoints.js'
import cloudTransport from '../cloudTransport.js'

/**
 * @typedef {object} TapTapTokenData
 * @property {string} kid
 * @property {string} access_token
 * @property {string} token_type
 * @property {string} mac_key
 * @property {string} mac_algorithm
 * @property {string} scope
 */

export default new (class TapTapHelper {
    TapSDKVersion = '2.1'

    /**
     * @param {string[]} [permissions]
     * @param {boolean} [useGlobalEndpoint]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     * @returns {Promise<import('./CompleteQRCodeData.js').PartialQRCodeData>}
     */
    async requestLoginQrCode(permissions = ['public_profile'], useGlobalEndpoint = false, options = {}) {
        const region = tapRegion(useGlobalEndpoint)
        const clientId = crypto.randomUUID().replace(/-/g, '')

        const params = new FormData()
        params.append('client_id', region.clientId)
        params.append('response_type', 'device_code')
        params.append('scope', permissions.join(','))
        params.append('version', this.TapSDKVersion)
        params.append('platform', 'unity')
        params.append('info', JSON.stringify({ device_id: clientId }))

        const endpoint = `${region.accounts}/oauth2/v1/device/code`
        const data = /** @type {Record<string, unknown>} */ (
            await cloudTransport.json(
                endpoint,
                {
                    method: 'POST',
                    body: params,
                    signal: options.signal,
                },
                { timeoutMs: options.timeoutMs },
            )
        )
        return /** @type {import('./CompleteQRCodeData.js').PartialQRCodeData} */ ({ ...data, deviceId: clientId })
    }

    /**
     * @param {import('./CompleteQRCodeData.js').PartialQRCodeData} data
     * @param {boolean} [useGlobalEndpoint]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     */
    async checkQRCodeResult(data, useGlobalEndpoint = false, options = {}) {
        const region = tapRegion(useGlobalEndpoint)
        const qrCodeData = new CompleteQRCodeData(data)
        const params = new FormData()
        params.append('grant_type', 'device_token')
        params.append('client_id', region.clientId)
        params.append('secret_type', 'hmac-sha-1')
        params.append('code', qrCodeData.deviceCode)
        params.append('version', '1.0')
        params.append('platform', 'unity')
        params.append('info', JSON.stringify({ device_id: qrCodeData.deviceID }))

        const endpoint = `${region.accounts}/oauth2/v1/token`
        try {
            return await cloudTransport.json(
                endpoint,
                {
                    method: 'POST',
                    body: params,
                    signal: options.signal,
                },
                { allowHttpErrors: true, timeoutMs: options.timeoutMs },
            )
        } catch (error) {
            // Polling network failures are retryable. Do not log request MACs
            // or credentials from transport errors.
            return null
        }
    }

    /**
     * @param {TapTapTokenData} token
     * @param {boolean} [useGlobalEndpoint]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     * @returns {Promise<any>}
     */
    async getProfile(token, useGlobalEndpoint = false, options = {}) {
        if (!token.scope.includes('public_profile')) {
            throw new Error('Public profile permission is required.')
        }

        const region = tapRegion(useGlobalEndpoint)
        const url = `${region.openApi}/account/profile/v1?client_id=${region.clientId}`
        const authorizationHeader = getAuthorization(url, 'GET', token.kid, token.mac_key)

        return cloudTransport.json(
            url,
            {
                method: 'GET',
                headers: { Authorization: authorizationHeader },
                signal: options.signal,
            },
            { timeoutMs: options.timeoutMs },
        )
    }
})()

/**
 * @param {string} requestUrl
 * @param {string} method
 * @param {string} keyId
 * @param {string} macKey
 */
function getAuthorization(requestUrl, method, keyId, macKey) {
    const url = new URL(requestUrl)
    const time = Math.floor(Date.now() / 1000)
        .toString()
        .padStart(10, '0')
    const randomStr = getRandomString(16)
    const host = url.hostname
    const uri = url.pathname + url.search
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    const other = ''
    const sign = signData(mergeData(time, randomStr, method, uri, host, port, other), macKey)

    return `MAC id="${keyId}", ts="${time}", nonce="${randomStr}", mac="${sign}"`
}

/**
 * @param {number} length
 */
function getRandomString(length) {
    return crypto.randomBytes(length).toString('base64')
}

/**
 * @param {string} time
 * @param {string} randomCode
 * @param {string} httpType
 * @param {string} uri
 * @param {string} domain
 * @param {string} port
 * @param {string} other
 */
function mergeData(time, randomCode, httpType, uri, domain, port, other) {
    let prefix = `${time}\n${randomCode}\n${httpType}\n${uri}\n${domain}\n${port}\n`

    if (!other) {
        prefix += '\n'
    } else {
        prefix += `${other}\n`
    }

    return prefix
}

/**
 * @param {string} signatureBaseString
 * @param {string} key
 */
function signData(signatureBaseString, key) {
    const hmac = crypto.createHmac('sha1', key)
    hmac.update(signatureBaseString)
    return hmac.digest('base64')
}
