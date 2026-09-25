import fs from 'node:fs'
/** @import PhigrosUser from '../../lib/PhigrosUser.js' */
import Save from './Save.js'
import saveHistory from './saveHistory.js'
import readFile from '../filesystem/getFile.js'
import getRksRank from '../game/getRksRank.js'
import { savePath } from '../filesystem/path.js'
import userCredentialStore from '../user/userCredentialStore.js'
import { LocalDataDirectory } from './localDataDirectory.js'
import { assertSessionToken } from '../../lib/sessionToken.js'

const directories = new LocalDataDirectory(savePath)

/**
 * SSTK 本地存档仓库。
 * 只处理以 sessionToken 为键的文件，不负责平台用户与凭证的映射。
 */
export default class LocalSaveRepository {
    /**
     * 检查 sessionToken 是否允许访问本地存档。
     * @param {phigrosToken} sessionToken Phigros sessionToken
     */
    static async assertSessionTokenAllowed(sessionToken) {
        assertSessionToken(sessionToken)
        if (await userCredentialStore.isSessionTokenBanned(sessionToken)) {
            throw new Error('该存档凭证已被禁用')
        }
    }

    /**
     * 读取 sessionToken 对应的本地存档。
     * @param {phigrosToken | null | undefined} sessionToken Phigros sessionToken
     * @returns {Promise<Save | undefined>} 已初始化的存档
     */
    static async getSaveBySessionToken(sessionToken) {
        if (!sessionToken) return undefined
        await this.assertSessionTokenAllowed(sessionToken)
        const data = await readFile.FileReader(directories.file(sessionToken, 'save.json'))
        if (!data?.saveInfo) return undefined
        const save = new Save(data)
        await save.init()
        return save
    }

    /**
     * 保存 sessionToken 对应的本地存档并更新 RKS 索引。
     * @param {Save | PhigrosUser} data 包含 sessionToken 的存档
     */
    static async putSaveBySessionToken(data) {
        const sessionToken = data.session
        if (!sessionToken) throw new Error('sessionToken is undefined')
        await this.assertSessionTokenAllowed(sessionToken)
        if (!readFile.SetFile(directories.file(sessionToken, 'save.json'), data)) throw new Error('存档写入失败，请检查磁盘空间和目录权限')
        await getRksRank.addUserRks(sessionToken, data.saveInfo.summary.rankingScore)
        return true
    }

    /**
     * 读取 sessionToken 对应的本地历史。
     * @param {phigrosToken | null | undefined} sessionToken Phigros sessionToken
     * @returns {Promise<saveHistory>} 历史记录对象
     */
    static async getHistoryBySessionToken(sessionToken) {
        if (!sessionToken) return new saveHistory(/** @type {any} */ (null))
        await this.assertSessionTokenAllowed(sessionToken)
        const data = await readFile.FileReader(directories.file(sessionToken, 'history.json'))
        return new saveHistory(data)
    }

    /**
     * 保存 sessionToken 对应的本地历史。
     * @param {phigrosToken} sessionToken Phigros sessionToken
     * @param {saveHistory | saveHistoryObject | object} data 历史记录
     */
    static async putHistoryBySessionToken(sessionToken, data) {
        if (!sessionToken) throw new Error('sessionToken is undefined')
        await this.assertSessionTokenAllowed(sessionToken)
        if (!readFile.SetFile(directories.file(sessionToken, 'history.json'), data))
            throw new Error('历史记录写入失败，请检查磁盘空间和目录权限')
        return true
    }

    /**
     * 删除 sessionToken 对应的本地存档、历史和 RKS 索引。
     * @param {phigrosToken | null | undefined} sessionToken Phigros sessionToken
     * @returns {Promise<boolean>} 是否执行了删除
     */
    static async deleteSaveBySessionToken(sessionToken) {
        if (!sessionToken) return false
        assertSessionToken(sessionToken)
        const directory = directories.directory(sessionToken)
        await fs.promises.rm(directory, { recursive: true, force: true })
        await getRksRank.delUserRks(sessionToken)
        return true
    }
}
