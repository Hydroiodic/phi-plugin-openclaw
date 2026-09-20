import CryptoJS from 'crypto-js';
import cloudTransport from '../cloudTransport.js';

const AppKey = 'Qr9AEqtuoSVS3zeD6iVbM4ZC0AtkJcQ89tywVyi0';
const ClientId = 'rAK3FfdieFob2Nn8Am';
const AppKeyGB = 'tG9CTm0LDD736k9HMM9lBZrbeBGRmUkjSfNLDNib';
const ClientIdGB = 'kviehleldgxsagpozb';

const UrlLcBase = 'https://rak3ffdi.cloud.tds1.tapapis.cn/1.1';
const UrlLcBaseGB = 'https://kviehlel.cloud.ap-sg.tapapis.com/1.1';

export default new class LCHelper {
    /**
     * @param {string} input
     */
    md5HashHexStringDefaultGetter(input) {
        return CryptoJS.MD5(input).toString(CryptoJS.enc.Hex);
    }

    /**
     * @param {Record<string, unknown>} data
     * @param {boolean} [withGlobal]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     * @returns {Promise<any>}
     */
    async loginWithAuthData(data, withGlobal = false, options = {}) {
        let authData = { taptap: data }
        let response = await this.request('post', { authData }, withGlobal, options);
        try { return await response.json(); }
        catch { throw new Error('云端登录数据格式无效，请稍后重试。'); }
    }

    /**
     * @param {Record<string, unknown>} data
     * @param {boolean} [withGlobal]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     * @returns {Promise<any>}
     */
    async loginAndGetToken(data, withGlobal = false, options = {}) {
        let response = await this.loginWithAuthData(data, withGlobal, options);
        return response;
    }

    /**
     * @param {string} method
     * @param {Record<string, unknown> | null} [data]
     * @param {boolean} [withGlobal]
     * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     */
    async request(method, data = null, withGlobal = false, options = {}) {
        let url = (withGlobal ? UrlLcBaseGB : UrlLcBase) + '/users';
        let headers = {
            'X-LC-Id': withGlobal ? ClientIdGB : ClientId,
            'Content-Type': 'application/json'
        };

        this.fillHeaders(headers, null, withGlobal)

        const response = await cloudTransport.request(url, {
            method,
            headers,
            body: JSON.stringify(data), signal: options.signal,
        }, { timeoutMs: options.timeoutMs });

        return new Response(new Uint8Array(response.bytes), { status: response.status, headers: response.headers })
    }

    /**
     * @param {Record<string, string>} headers
     * @param {Record<string, unknown> | null} [reqHeaders]
     * @param {boolean} [withGlobal]
     */
    fillHeaders(headers, reqHeaders = null, withGlobal = false) {
        if (reqHeaders !== null) {
            Object.entries(reqHeaders).forEach(([key, value]) => {
                headers[key] = String(value);
            });
        }

        let timestamp = Math.floor(Date.now() / 1000);
        let data = `${timestamp}${withGlobal ? AppKeyGB : AppKey}`;
        let hash = CryptoJS.MD5(data).toString(CryptoJS.enc.Hex);
        let sign = `${hash},${timestamp}`;
        headers['X-LC-Sign'] = sign;
    }
}()
