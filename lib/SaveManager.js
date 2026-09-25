
import Summary from './Summary.js';
import axios from 'axios';
import { tapRegion } from './TapTap/endpoints.js'


export default class SaveManager {

    /**
     * @param {boolean} isGlobal
     */
    constructor(isGlobal) {
        const region = tapRegion(isGlobal)
        this.baseUrl = region.leanCloud
        this.headers = {
            'X-LC-Id': region.clientId,
            'X-LC-Key': region.appKey,
            'User-Agent': 'LeanCloud-CSharp-SDK/1.0.3',
            Accept: 'application/json',
        }
        // The trailing slash redirects; use the canonical URL without forwarding credentials.
        this.save = this.baseUrl + '/gamesaves'
        this.userInfo = this.baseUrl + '/users/me'
    }

    /**
     * 
     * @param {string} session 
     * @returns {Promise<playerInfo>} 玩家信息
     * 
     */
    async getPlayerInfo(session) {
        const data = await this.requestJson(this.userInfo, session)
        if (typeof data?.objectId !== 'string' || !data.objectId) throw new Error('云端用户信息格式无效')
        return data
    }

    /** @param {string} url @param {string} session @param {Record<string, string | number>} [params] */
    async requestJson(url, session, params = {}) {
        try {
            const response = await axios.get(url, {
                headers: { ...this.headers, 'X-LC-Session': session },
                params,
                timeout: 15_000,
                maxContentLength: 2 * 1024 * 1024,
                maxRedirects: 0,
            })
            return response.data
        } catch (error) {
            // Axios errors retain request headers; do not propagate session credentials into logs.
            const status = axios.isAxiosError(error) ? error.response?.status : undefined
            if (status === 401 || status === 403) throw new Error('云存档凭证无效或已过期，请重新绑定')
            throw new Error(status ? `读取云存档失败（HTTP ${status}），请稍后重试` : '读取云存档失败或超时，请稍后重试')
        }
    }

    /**
     * 
     * @param {String} session 
     * @param {string} objectId 
     * @returns {Promise<saveInfo[]>} 存档数组
     */
    async saveArray(session, objectId) {
        const data = await this.requestJson(this.save, session, {
            skip: 0, limit: 100, include: 'cover,gameFile',
            where: JSON.stringify({ user: { __type: 'Pointer', className: '_User', objectId } }),
        })
        if (!Array.isArray(data?.results)) throw new Error('云端存档列表格式无效')
        return data.results
    }

    /**
     * 读取最近修改的云端存档记录，summary 等字段保持云端原样。
     * @param {string} session
     * @returns {Promise<{save: any, playerInfo: playerInfo}>}
     */
    async latestSave(session) {
        const playerInfo = await this.getPlayerInfo(session)
        const saves = (await this.saveArray(session, playerInfo.objectId))
            .filter(item => item?.gameFile && typeof item.gameFile.url === 'string'
                && Number.isFinite(new Date(item.modifiedAt?.iso).getTime()))
        if (!saves.length) throw new Error('TK 对应存档列表为空，请检查是否同步存档QAQ！')
        const time = (/** @type {any} */ item) => new Date(item.modifiedAt.iso).getTime()
        return { save: saves.reduce((latest, item) => time(item) > time(latest) ? item : latest), playerInfo }
    }

    /**
     * @param {String} session
     * @returns {Promise<{saveInfo: saveInfo, playerInfo: playerInfo}>} 最新存档与玩家信息
     */
    async saveCheck(session) {
        const { save, playerInfo } = await this.latestSave(session)
        save.summary = new Summary(save.summary)
        save.modifiedAt.iso = new Date(save.modifiedAt.iso)
        save.createdAt = new Date(save.createdAt)
        save.updatedAt = new Date(save.updatedAt)
        save.PlayerId = playerInfo.nickname
        return { saveInfo: save, playerInfo }
    }
}
