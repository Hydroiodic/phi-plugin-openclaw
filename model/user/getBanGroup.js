import { redisPath } from '../game/constNum.js'
import { UserCredentials } from './userCredentials.js'
import send from '../render/send.js'
import { canUseApi } from './apiPermission.js'
import { redis } from '../../components/platform/index.js'

/**@import {botEvent} from "../../components/baseClass.js" */

export const GROUP_BANNED_MESSAGE = '这里被管理员禁止使用这个功能了呐QAQ！'

/**
 * 功能到群聊禁用分组的映射；分组名与 banGroup.yaml 中的说明一致。
 * @type {Partial<Record<allFnc | string, string>>}
 */
const FEATURE_GROUPS = {
    help: 'help',
    tkhelp: 'help',
    bind: 'bind',
    unbind: 'bind',
    b19: 'b19',
    p30: 'b19',
    lmtAcc: 'b19',
    arcgrosB19: 'b19',
    update: 'b19',
    info: 'b19',
    list: 'b19',
    singlescore: 'b19',
    lvscore: 'b19',
    chap: 'b19',
    achievement: 'b19',
    suggest: 'b19',
    analyze2025SaveHistory: 'b19',
    hisb30: 'b19',
    bestn: 'wb19',
    data: 'wb19',
    song: 'song',
    ill: 'song',
    chart: 'song',
    tag: 'song',
    addtag: 'song',
    retag: 'song',
    search: 'song',
    alias: 'song',
    randmic: 'song',
    randClg: 'song',
    table: 'song',
    comment: 'song',
    recallComment: 'song',
    myComment: 'song',
    rankList: 'ranklist',
    godList: 'ranklist',
    comrks: 'fnc',
    tips: 'fnc',
    newSong: 'fnc',
    tipgame: 'tipgame',
    guessgame: 'guessgame',
    ltrgame: 'ltrgame',
    sign: 'sign',
    send: 'sign',
    tasks: 'sign',
    retask: 'sign',
    jrrp: 'sign',
    theme: 'setting',
    dan: 'dan',
    danupdate: 'dan',
    auth: 'apiSetting',
    clearApiData: 'apiSetting',
    updateHistory: 'apiSetting',
    setApiToken: 'apiSetting',
    tokenList: 'apiSetting',
}

export default class getBanGroup {
    /**
     * 群聊是否禁用了某个功能分组。
     * @param {string} group 群聊 ID
     * @param {string} feature 功能分组
     */
    static async redis(group, feature) {
        return Boolean(await redis.get(`${redisPath}:banGroup:${group}:${feature}`))
    }

    /**
     * 检查当前用户或群聊是否禁止使用该功能；禁止时已向用户发送原因。
     * @param {botEvent} e
     * @param {allFnc | string} fnc 功能名
     * @param {string} [message] 群聊禁用时的提示
     * @returns {Promise<boolean>} 是否被禁止
     */
    static async get(e, fnc, message = GROUP_BANNED_MESSAGE) {
        const credentials = UserCredentials.fromEvent(e)
        if ((await canUseApi(e)) && (await credentials.getUserAPIBanStatus({ ignoreUnboundError: true }))) {
            send.send_with_At(e, '当前账户被加入黑名单，详情请联系管理员(1)。')
            return true
        }
        if (await credentials.getUserLocalBanStatus()) {
            send.send_with_At(e, '当前账户被加入黑名单，详情请联系管理员(2)。')
            return true
        }
        const feature = FEATURE_GROUPS[fnc]
        if (!e.group_id || !feature || !(await this.redis(e.group_id, feature))) return false
        send.send_with_At(e, message)
        return true
    }
}
