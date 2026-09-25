
import SaveManager from './SaveManager.js';
import { decryptSaveBytes } from './saveCipher.js';
import GameRecord from './GameRecord.js';
import GameProgress from './GameProgress.js';
import GameUser from './GameUser.js';
import GameSettings from './GameSettings.js';
import logger from '../components/Logger.js';
import { assertSessionToken } from './sessionToken.js';
import cloudTransport from './cloudTransport.js';
import cloudSaveArchive, { CLOUD_SAVE_LIMITS } from './cloudSaveArchive.js';


class PhigrosUser {
    /**
     *
     * @param {phigrosToken} session
     * @param {boolean} [global] 是否是国际服
     */
    constructor(session, global = false) {
        /** @type {phigrosToken} */
        this.session = session;
        /** @type {saveInfo} */
        this.saveInfo;
        /** @type {gameRecord} */
        this.gameRecord = {}
        /** @type {number} */
        this.Recordver;
        /** @type {GameProgress} */
        this.gameProgress;
        /** @type {GameUser} */
        this.gameuser;
        /** @type {GameSettings} */
        this.gamesettings;
        /** @type {playerInfo} */
        this.playerInfo;
        assertSessionToken(session)
        this.session = session;
        this.global = global;
    }

    /**
     * 获取 SaveInfo
     */
    async getSaveInfo() {
        if (!this.session) {
            throw new Error("SessionToken未设置");
        }
        const saveManager = new SaveManager(this.global);
        const { saveInfo, playerInfo } = await saveManager.saveCheck(this.session);

        if (!saveInfo) {
            logger.error(`[Phi-Plugin]错误的存档`)
            logger.error(saveInfo)
            throw new Error("未找到存档QAQ！")
        }

        this.saveInfo = saveInfo;
        this.playerInfo = playerInfo;

        return saveInfo;
    }

    /**
     *
     * @returns 返回未绑定的信息数组，没有则为false
     */
    async buildRecord() {
        await this.getSaveInfo()
        if (!this.saveInfo?.gameFile?.url) {
            throw new Error("未获取到存档信息！")
        }
        if (this.saveInfo.summary.saveVersion == 1) {
            throw new Error("存档版本过低，请更新Phigros！")
        }
        const { bytes } = await cloudTransport.request(this.saveInfo.gameFile.url, { method: 'GET' }, { maxBytes: CLOUD_SAVE_LIMITS.maxArchiveBytes })
        const files = await cloudSaveArchive.read(bytes)
        if (files.gameRecord[0] !== GameRecord.version) throw new Error('存档格式版本已更新，请更新插件。')
        try {
            const gameProgress = new GameProgress(await this.decryptEntry(files.gameProgress))
            const gameuser = new GameUser(await this.decryptEntry(files.user))
            const gamesettings = new GameSettings(await this.decryptEntry(files.settings))
            const record = new GameRecord(await this.decryptEntry(files.gameRecord))
            await record.init()
            // Publish a complete snapshot only after every file has parsed.
            Object.assign(this, { Recordver: 1.0, gameProgress, gameuser, gamesettings, gameRecord: record.Record })
        } catch { throw new Error('云存档内容损坏或格式不受支持，请重新同步游戏存档后重试。') }
        return false
    }

    /**
     * 去掉条目版本号并解密，返回十六进制明文。
     * @param {Buffer} bytes
     */
    async decryptEntry(bytes) {
        if (bytes.length < 17 || (bytes.length - 1) % 16 !== 0) throw new Error('云存档加密数据长度无效。')
        return decryptSaveBytes(bytes.subarray(1)).toString('hex')
    }

}
export default PhigrosUser

