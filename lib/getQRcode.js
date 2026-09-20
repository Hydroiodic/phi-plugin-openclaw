import LCHelper from "./TapTap/LCHelper.js";
import TapTapHelper from "./TapTap/TapTapHelper.js";
import QRCode from 'qrcode'
import { setTimeout as wait } from 'node:timers/promises'
import { assertSessionToken } from './sessionToken.js'

export default new class getQRcode {
    /**
     * @param {boolean} [useGlobal]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     */
    async getRequest(useGlobal = false, options = {}) {
        return await TapTapHelper.requestLoginQrCode(undefined, useGlobal, options)
    }

    /** @param {import('./TapTap/CompleteQRCodeData.js').PartialQRCodeData} request @param {number} [maxSeconds] */
    validateRequest(request, maxSeconds = 600) {
        const data = request?.data
        if (typeof request?.deviceId !== 'string' || !request.deviceId.trim() || request.deviceId.length > 128
            || typeof data?.device_code !== 'string' || !data.device_code.trim() || data.device_code.length > 4096
            || /** @type {any} */ (request).success === false || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0
            || typeof data.qrcode_url !== 'string' || data.qrcode_url.length > 4096) throw new Error('扫码登录响应格式无效。')
        let url
        try { url = new URL(data.qrcode_url) } catch { throw new Error('扫码登录链接无效。') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('扫码登录链接无效。')
        return { seconds: Math.min(data.expires_in, maxSeconds),
            intervalMs: Number.isFinite(data.interval) && data.interval > 0 ? Math.min(30, Math.max(1, data.interval)) * 1000 : 2000 }
    }

    /** @param {number} ms @param {AbortSignal | undefined} signal */
    async wait(ms, signal) {
        try { await wait(ms, undefined, { signal }) }
        catch (error) { if (!signal?.aborted) throw error }
    }

    /**
     * @param {string} url
     * @param {boolean} [useGlobal]
     */
    async getQRcode(url, useGlobal = false) {
        return await QRCode.toBuffer(url, { scale: 10 })
    }

    /**
     * @param {import('./TapTap/CompleteQRCodeData.js').PartialQRCodeData} request
     * @param {boolean} [useGlobal]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     * @returns authorization_pending authorization_waiting
     */
    async checkQRCodeResult(request, useGlobal = false, options = {}) {
        return await TapTapHelper.checkQRCodeResult(request, useGlobal, options)
    }

    /**
     * @param {{data: import('./TapTap/TapTapHelper.js').TapTapTokenData}} result
     * @param {boolean} [useGlobal]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     */
    async getSessionToken(result, useGlobal = false, options = {}) {
        if (!result?.data || ['kid', 'mac_key', 'scope', 'access_token'].some(key =>
            typeof /** @type {any} */ (result.data)[key] !== 'string' || !/** @type {any} */ (result.data)[key])) throw new Error('扫码授权结果格式无效。')
        let profile = await TapTapHelper.getProfile(result.data, useGlobal, 0, options)
        if (!profile?.data || typeof profile.data !== 'object') throw new Error('扫码账号信息格式无效。')
        const token = (await LCHelper.loginAndGetToken({ ...profile.data, ...result.data }, useGlobal, options))?.sessionToken
        assertSessionToken(token)
        return token
    }
}()
