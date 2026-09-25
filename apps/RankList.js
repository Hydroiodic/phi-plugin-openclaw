import Save from '../model/save/Save.js'
import fCompute from '../model/game/fCompute.js'
import getInfo from '../model/game/getInfo.js'
import getRksRank from '../model/game/getRksRank.js'
import getSave from '../model/save/getSave.js'
import send from '../model/render/send.js'
import picmodle from '../model/render/picmodle.js'
import Config from '../components/Config.js'
import getBanGroup from '../model/user/getBanGroup.js';
import makeRequest from '../model/api/makeRequest.js'
import saveHistory from '../model/save/saveHistory.js'
import phiPluginBase from '../components/baseClass.js'
import { canUseApi } from '../model/user/apiPermission.js';
import platform from '../components/platform/index.js'
import { UserCredentials } from '../model/user/userCredentials.js'
import { sendQuickCommands, rankQuickCommands } from '../model/game/markdown.js'

/**@import {botEvent} from '../components/baseClass.js' */

export class phiRankList extends phiPluginBase {

    constructor() {
        super({
            name: 'phi-rankList',
            event: 'message',
            priority: 1000,
            dsc: 'phigros rks 排行榜',
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(排行榜|ranklist).*$`,
                    fnc: 'rankList'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(查询排名|rankfind).*$`,
                    fnc: 'rankfind'
                }
            ]

        })
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async rankList(e) {

        if (await getBanGroup.get(e, 'rankList')) return false



        if (await canUseApi(e)) {
            const credentials = UserCredentials.fromEvent(e)
            const data = {
                Title: "RankingScore排行榜",
                totDataNum: 0,
                BotNick: platform.getBotNickname(e),
                /** @type {rankingListObject[]} */
                users: [],
                me: {},
            }
            /**请求的排名 */
            const msg = e.msg.match(/\d+/)
            const api_ranklist = msg
                ? await makeRequest.getRanklistRank({ request_rank: Number(msg[0]) }, { event: e })
                : await credentials.getRanklistUser()
            if (api_ranklist) {
                data.totDataNum = api_ranklist.totDataNum;
                for (const item of api_ranklist.users) {
                    data.users.push({ ...await makeSmallLine(item), index: item.index, me: item.me })
                }
                data.me = await makeLargeLine(new Save(api_ranklist.me.save), new saveHistory(api_ranklist.me.history), e)
                send.send_with_At(e, [await picmodle.common(e, 'rankingList', data), `总数据量：${data.totDataNum}\n`])
                await sendQuickCommands(e, rankQuickCommands(Config.getUserCfg('config', 'cmdhead')), '排行榜快捷操作')
                return true
            }
        }
        const data = {
            Title: "RankingScore排行榜",
            totDataNum: 0,
            BotNick: platform.getBotNickname(e),
            /** @type {rankingListObject[]} */
            users: [],
            me: {},
        }
        /**请求的排名 */
        const msg = e.msg.match(/\d+/)
        data.totDataNum = await getRksRank.getAllRank()

        let rankNum
        if (msg) {
            rankNum = Math.max(Math.min(Number(msg[0]), data.totDataNum), 1) - 1
        } else {
            const save = await send.getsave_result(e)
            if (!save) {
                return true
            }
            rankNum = await getRksRank.getUserRank(save.getSessionToken())
        }

        /**展示区间的起始排名（从 0 开始） */
        const start = Math.max((rankNum ?? 0) - 2, 0)
        /**展示的用户数据 */
        const list = await getRksRank.getRankUser(start, start + 5)
        // 未上榜时 zRank 返回 null，此时不高亮任何人
        const myTk = rankNum == null ? undefined : list[rankNum - start]

        for (let index = 0; index < Math.max(list.length, 5); index++) {
            const rank = start + index + 1
            if (index >= list.length) {
                data.users.push({ playerId: '无效用户', index: rank })
                continue
            }
            const sessionToken = list[index]
            const save = await getSave.getSaveBySessionToken(sessionToken)
            if (!save) {
                data.users.push({ playerId: '无效用户', index: rank })
                getRksRank.delUserRks(sessionToken)
            } else {
                data.users.push({ ...await makeSmallLine(save), index: rank, me: myTk === save.getSessionToken() })
                if (myTk === sessionToken) {
                    const history = await getSave.getHistoryBySessionToken(save.getSessionToken())
                    data.me = await makeLargeLine(save, history, e)
                }
            }
        }

        send.send_with_At(e, [`总数据量：${data.totDataNum}\n`, await picmodle.common(e, 'rankingList', data)])
        await sendQuickCommands(e, rankQuickCommands(Config.getUserCfg('config', 'cmdhead')), '排行榜快捷操作')
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async rankfind(e) {
        if (await getBanGroup.get(e, 'rankList')) return false

        const rks = Number(e.msg.replace(/^[#/]?.*?rankfind/, '').match(/\d+(.\d+)?/)?.[0])
        if (!rks) {
            send.send_with_At(e, `请输入要查询的 rks！\n格式： /${Config.getUserCfg('config', 'cmdhead')} rankfind <rks>`)
            return false
        }

        if (await canUseApi(e, 'scoreStatistics')) {
            const res = await makeRequest.getRanklistRks({ request_rks: rks }, { event: e })
            if (res) {
                send.send_with_At(e, `当前服务器记录中一共有 ${res.rksRank}/${res.totNum} 位玩家的 rks 大于 ${rks}！`)
                await sendQuickCommands(e, rankQuickCommands(Config.getUserCfg('config', 'cmdhead')), '排行榜快捷操作')
                return true
            }
        }

        const totDataNum = await getRksRank.getAllRank()

        const rank = await getRksRank.getRankByRks(rks)

        send.send_with_At(e, `当前服务器记录中一共有 ${totDataNum - rank + 1}/${totDataNum} 位玩家的 rks 大于等于 ${rks}！`)
        await sendQuickCommands(e, rankQuickCommands(Config.getUserCfg('config', 'cmdhead')), '排行榜快捷操作')

        return true
    }


}

/**
 * 创建一个详细对象
 * @param {Save} save 
 * @param {saveHistory} history
 * @param {botEvent} e
 */
async function makeLargeLine(save, history, e) {
    if (!save) {
        return {
            playerId: "无效用户"
        }
    }


    const lineData = history.getRksAndDataLine()
    lineData.rks_date.forEach((item, index) => {
        // @ts-ignore
        item = fCompute.formatDateToNow(item)
        lineData.rks_date[index] = item
    });
    /**
     * @type {{ ChallengeMode: number; ChallengeModeRank: number; date: string; }[]}
     */
    const clgHistory = []
    history.challengeModeRank.forEach((item, index, array) => {
        if (!index || item.value != array[index - 1].value) {
            clgHistory.push({
                ChallengeMode: Math.floor(item.value / 100),
                ChallengeModeRank: item.value % 100,
                date: fCompute.formatDateToNow(item.date)
            })
        }
    })
    const b30Data = await save.getB19(e, 33)
    const b30list = {
        P3: {
            title: 'Perfect 3',
            list: b30Data.phi
        },
        B3: {
            title: 'Best 3',
            list: b30Data.b19_list.slice(0, 3)
        },
        F3: {
            title: 'Floor 3',
            list: b30Data.b19_list.slice(24, 27)
        },
        L3: {
            title: 'Overflow 3',
            list: b30Data.b19_list.slice(27, 30)
        }
    }
    return {
        backgroundurl: getInfo.getBackground(save?.gameuser?.background),
        avatar: getInfo.idgetavatar(save.saveInfo.summary.avatar) || 'Introduction',
        playerId: fCompute.convertRichText(save.saveInfo.PlayerId),
        rks: save.saveInfo.summary.rankingScore || 0,
        ChallengeMode: Math.floor(save.saveInfo.summary.challengeModeRank / 100),
        ChallengeModeRank: save.saveInfo.summary.challengeModeRank % 100,
        updated: fCompute.formatDate(save.saveInfo.modifiedAt.iso),
        selfIntro: fCompute.convertRichText(save?.gameuser?.selfIntro),
        rks_history: lineData.rks_history,
        rks_range: lineData.rks_range,
        rks_date: lineData.rks_date,
        b30list: b30list,
        clg_list: clgHistory,
    }
}

/**
 * @typedef {Object} rankingListObject
 * @property {string} playerId
 * @property {string} [backgroundurl]
 * @property {string} [avatar]
 * @property {number} [rks]
 * @property {number} [ChallengeMode]
 * @property {number} [ChallengeModeRank]
 * @property {boolean} [me]
 * @property {number} index
 */

/**
 * 创建一个简略对象
 * @param {Save | import('../model/api/makeRequest.js').UserItem} save 
 */
async function makeSmallLine(save) {
    if (!save) {
        return {
            playerId: "无效用户",
        }
    }
    return {
        backgroundurl: getInfo.getBackground(save?.gameuser?.background),
        avatar: getInfo.idgetavatar(save.saveInfo.summary.avatar || ''),
        playerId: fCompute.convertRichText(save.saveInfo.PlayerId),
        rks: save.saveInfo.summary.rankingScore,
        ChallengeMode: Math.floor(save.saveInfo.summary.challengeModeRank / 100),
        ChallengeModeRank: save.saveInfo.summary.challengeModeRank % 100,
    }
}
