import path from 'path'
import Config from '../components/Config.js'
import send from '../model/render/send.js'
import getNotes from '../model/user/getNotes.js'
import getBanGroup from '../model/user/getBanGroup.js';
import getInfo from '../model/game/getInfo.js'
import readFile from '../model/filesystem/getFile.js'
import { infoPath } from '../model/filesystem/path.js'
import phiPluginBase from '../components/baseClass.js'
import fCompute from '../model/game/fCompute.js'
import picmodle from '../model/render/picmodle.js'
/** @import Save from '../model/save/Save.js' */
import { Level, LevelNum, redisPath } from '../model/game/constNum.js'
/** @import PluginData from '../model/user/pluginData.js' */
import themeManager from '../model/theme/manager.js'
import makeRequest from '../model/api/makeRequest.js'
import logger from '../components/Logger.js'
import { canUseApi } from '../model/user/apiPermission.js'
import platform, { redis } from '../components/platform/index.js'
import themeUseService, { marketThemeErrorMessage } from '../model/theme/useService.js'
import { getThemeInstallRequesterId } from '../model/theme/installGuard.js'

/**@import {botEvent} from '../components/baseClass.js' */

/** 主题列表（内置 + 自定义，实时获取以支持热更新） */
const getThemeList = () => themeManager.getThemeList()

const commonSP = {
    note_num: [750],
    tips: ["高考加油喵，祝26届考生金榜题名w！"],
    jrrp: {
        /**@type {[number, number]} */
        lucky: [100, 100],
        good: undefined,
        bad: undefined,
        common: undefined,
        sentence: [{
            hitokoto: "愿你合上笔盖的那一刻，有侠客收剑入鞘的从容，无论江湖多远，此刻已是英雄。",
            from: "phi-plugin全体维护成员"
        }]
    }
}

const spData = [{
    month: '06',
    date: '06',
    ...commonSP,
}, {
    month: '06',
    date: '07',
    ...commonSP,
}, {
    month: '06',
    date: '08',
    ...commonSP,
}, {
    month: '06',
    date: '09',
    ...commonSP,
}, {
    month: '06',
    date: '10',
    ...commonSP,
}]


/**
 * 一言
 * @type {Record<"hitokoto" | "from", string>[]}
 */
const sentence = await readFile.FileReader(path.join(infoPath, 'sentences.json'))

export class phimoney extends phiPluginBase {
    constructor() {
        super({
            name: 'phi-money',
            dsc: 'phi-plugin货币系统',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: `^[#/]?(${Config.getUserCfg('config', 'cmdhead')})(\\s*)(sign|sign in|签到|打卡)$`,
                    fnc: 'sign'
                },
                {
                    reg: `^[#/]?(${Config.getUserCfg('config', 'cmdhead')})(\\s*)(task|我的任务)$`,
                    fnc: 'tasks'
                },
                {
                    reg: `^[#/]?(${Config.getUserCfg('config', 'cmdhead')})(\\s*)(retask|刷新任务)$`,
                    fnc: 'retask'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(send|送|转)(.*)$`,
                    fnc: 'send'
                },
                {
                    reg: `^[#/]?(${Config.getUserCfg('config', 'cmdhead')})(\\s*)(theme)(\\s*)[0-9]+$`,
                    fnc: 'theme'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(jrrp|今日人品)$`,
                    fnc: 'jrrp'
                },
            ]
        })

    }

    /**
     * 签到
     * @param {botEvent} e
     */
    async sign(e) {

        if (await getBanGroup.get(e, 'sign')) return false

        const save = await send.getsave_result(e, undefined, false)
        return getNotes.withUsers([e.user_id], () => this.signWithSave(e, save))
    }

    /** @param {botEvent} e @param {Save | false} save */
    async signWithSave(e, save) {
        const data = await getNotes.getNotesData(e.user_id)
        const last_sign = new Date(data.sign_in)
        const now_time = new Date()
        const request_time = getDayZeroTimestamp(now_time) //每天0点
        const todayKey = formatDateKey(now_time)

        // 特殊日期处理
        const spDateIndex = checkSpDateIndex(now_time);

        let signedJustNow = false
        let getnum = 0

        if (request_time > last_sign) {
            signedJustNow = true
            getnum = randint(20, 5)
            if (spDateIndex !== -1) {
                getnum = spData[spDateIndex].note_num[randint(spData[spDateIndex].note_num.length - 1)]
            }

            data.money += getnum
            data.sign_in = now_time.toISOString();

            if (!Array.isArray(data.sign_history)) data.sign_history = []
            if (!data.sign_history.includes(todayKey)) data.sign_history.push(todayKey)

            if (!getNotes.putNotesData(e.user_id, data)) throw new Error('签到保存失败')
        } else {
            // 兼容旧数据：已签但历史缺失时补一条，保证日历正确
            if (!Array.isArray(data.sign_history)) data.sign_history = []
            if (!data.sign_history.includes(todayKey)) {
                data.sign_history.push(todayKey)
                if (!getNotes.putNotesData(e.user_id, data)) throw new Error('签到保存失败')
            }
        }

        /** 今日任务：有存档且今日未刷新时，静默刷新一次并写回 */
        if (save) {
            const last_task = new Date(data.task_time)
            if (last_task < request_time) {
                data.task_time = now_time.toISOString()
                data.task = await randtask(e, save, [])
                if (!getNotes.putNotesData(e.user_id, data)) throw new Error('任务保存失败')
            }
        }


        const img = await picmodle.common(e, 'sign', await picData(save, data, e));
        if (signedJustNow) {
            const tips = spDateIndex !== -1
                ? spData[spDateIndex].tips[randint(spData[spDateIndex].tips.length - 1)]
                : `签到成功！${helloMsg(now_time, 0)}`
            send.send_with_At(e, [img, `${tips}\n恭喜您获得了${getnum}个Note！当前 Note：${data.money}`])
        } else {
            send.send_with_At(e, [img, `你在今天${fCompute.formatDate(last_sign, 'hh:mm:ss')}的时候已经签过到了哦！\n你现在的Note数量: ${data.money}`])
        }
        return true
    }

    /**
     * 刷新任务并发送图片
     * @param {botEvent} e
     */
    async retask(e) {

        if (await getBanGroup.get(e, 'retask')) return false

        const save = await send.getsave_result(e)

        if (!save) {
            return false
        }

        return getNotes.withUsers([e.user_id], () => this.retaskWithSave(e, save))
    }

    /** @param {botEvent} e @param {Save} save */
    async retaskWithSave(e, save) {
        const data = await getNotes.getNotesData(e.user_id)
        const last_task = new Date(data.task_time)
        const now_time = new Date()
        const request_time = getDayZeroTimestamp(now_time) //每天0点
        /**@type {import('../model/user/pluginData.js').taskObj[]} */
        let oldtask = []

        if (request_time > last_task) {
            /**每天一次免费刷新任务 */
        } else {
            /**花费20Notes刷新 */
            if (data.money >= 20) {
                data.money -= 20
                oldtask = data.task
            } else {
                send.send_with_At(e, `刷新任务需要 20 Notes，咱没有那么多Note哇QAQ！\n你当前的 Note 数目为：${data.money}`)
                return false
            }
        }

        data.task_time = now_time.toISOString();
        data.task = await randtask(e, save, oldtask)

        if (!data.task.some(Boolean)) {
            send.send_with_At(e, `哇塞，您已经把所有曲目全部满分了呢！没有办法为您布置任务了呢！敬请期待其他玩法哦！`)
            return true
        }

        if (!getNotes.putNotesData(e.user_id, data)) throw new Error('任务保存失败')

        const img = await picmodle.common(e, 'sign', await picData(save, data, e));
        send.send_with_At(e, img);

        return true


    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async tasks(e) {

        if (await getBanGroup.get(e, 'tasks')) return false

        const save = await send.getsave_result(e)

        if (!save) {
            return false
        }
        const data = await getNotes.getNotesData(e.user_id)

        const img = await picmodle.common(e, 'sign', await picData(save, data, e));

        send.send_with_At(e, img)

        return true
    }

    /**
     * 转账
     * @param {botEvent} e
     */
    async send(e) {

        if (await getBanGroup.get(e, 'send')) return false
        const tmp = `\n格式：/${Config.getUserCfg('config', 'cmdhead')} send <用户ID或@> <数量>\n用户ID可由对方发送 /phi identity 获取；QQ Bot 的用户ID不一定是QQ号。`;
        const msg = e.msg.replace(/[#/](.*?)(send|送|转)(\s*)/g, "")
        const parts = msg.trim().match(/^(<@!?[^>]+>|\[CQ:at,qq=[^\]]+\]|\S+)\s+(\S+)$/)
        if (!parts) {
            send.send_with_At(e, `格式错误！请指定目标${tmp}`, true)
            return true
        }
        let target = parts[1]
        const num = Number(parts[2])
        if (!Number.isSafeInteger(num) || num <= 0) {
            send.send_with_At(e, `非法数字：${msg}${tmp}`, true)
            return true
        }

        let target_card
        try {
            target_card = await platform.pickMember(e, target);
            if (!target_card) throw new Error("not found");
            target = String(target_card.user_id)
        } catch (err) {
            send.send_with_At(e, `未找到此用户，请让对方先在当前机器人发送一次 /b30（无需绑定），再用 /phi identity 获取用户ID。`);
            return true
        }


        if (target === String(e.user_id)) {
            const { result: deducted } = await getNotes.update(e.user_id, data => {
                if (data.money < 20) return false
                data.money -= 20
                return true
            })
            await send.send_with_At(e, deducted ? '不能给自己转账，扣除 20 Notes。' : '不能给自己转账，当前余额不足 20 Notes，未扣款。')
            return true
        }

        try {
            const result = await getNotes.transfer(e.user_id, target, num)
            if (result.status !== 'success') {
                await send.send_with_At(e, `你当前的 Note 数量不够哦！\n当前 Note: ${result.source.money}`)
                return true
            }
            const targetName = target_card?.nickname || target_card?.card || target
            await send.send_with_At(e, `转账成功！\n你当前的Note: ${result.sourceBefore} - ${num} = ${result.source.money}\n${targetName}的Note: ${result.targetBefore} + ${result.received} = ${result.destination.money}`)
        } catch (error) {
            logger.warn('[phi-plugin] Notes 转账失败', error)
            await send.send_with_At(e, '转账失败，请检查用户数据和磁盘状态；如提示回滚失败，请联系管理员核对余额。')
        }
        return true
    }

    /**
     * 主题相关
     * @param {botEvent} e
     */
    async theme(e) {

        if (await getBanGroup.get(e, 'theme')) return false

        const themeList = getThemeList()
        const msg = e.msg.replace(/.*?theme\s*/g, '')
        const aim = Number(msg)
        if (!Number.isInteger(aim) || aim < 0 || aim > themeList.length - 1) {
            send.send_with_At(e, `请输入主题数字嗷！\n格式/${Config.getUserCfg('config', 'cmdhead')} theme 0-${themeList.length - 1}`)
            return false
        }

        const selectedTheme = themeList[aim]
        if (themeManager.getTheme(selectedTheme.id)?.marketInstalled) {
            send.send_with_At(e, `正在校验并准备主题 ${selectedTheme.id}，请稍候。`)
            try {
                await themeUseService.use(selectedTheme.id, { requesterId: getThemeInstallRequesterId(e) })
            } catch (error) {
                send.send_with_At(e, marketThemeErrorMessage(error))
                return true
            }
        }

        try {
            await getNotes.update(e.user_id, data => {
                if (typeof data.setThemePreference === 'function') data.setThemePreference(selectedTheme.id)
                else data.theme = selectedTheme.id
            })
        } catch {
            send.send_with_At(e, '主题已准备完成，但你的主题设置保存失败，请稍后重试。')
            return true
        }

        send.send_with_At(e, `设置成功！\n你当前的主题是：${selectedTheme.src}`)
        return true
    }


    /** 
     * 今日人品
     * @param {botEvent} e 
     * @returns 
     */
    async jrrp(e) {

        if (await getBanGroup.get(e, 'jrrp')) return false

        const jrrp = (await createJrrp(e)).oriData;
        const data = {
            bkg: getInfo.getill(/**@type {any} */("ShineAfter.ADeanJocularACE.0")),
            lucky: jrrp[0],
            luckRank: jrrp[0] == 100 ? 5 : (jrrp[0] >= 80 ? 4 : (jrrp[0] >= 60 ? 3 : (jrrp[0] >= 40 ? 2 : (jrrp[0] >= 20 ? 1 : 0)))),
            year: new Date().getFullYear(),
            month: fCompute.ped(new Date().getMonth() + 1, 2),
            day: fCompute.ped(new Date().getDate(), 2),
            sentence: Number(jrrp[1]) ? sentence[jrrp[1]] : jrrp[1],
            good: jrrp.slice(2, 6),
            bad: jrrp.slice(6, 10),
        }
        send.send_with_At(e, await picmodle.common(e, 'jrrp', data))
    }
}


/**
 * 
 * @param {botEvent} e
 * @param {Save} save 
 * @param {import('../model/user/pluginData.js').taskObj[]} task 
 * @returns 
 */
async function randtask(e, save, task = []) {
    const rks = save.saveInfo.summary.rankingScore
    const gameRecord = save.gameRecord
    const info = getInfo.ori_info

    const { com_rks } = await save.getB19(e, 1000, { avgType: "none" });

    /**
     * @typedef {{ id: idString; level: levelKind; type: string; value: number; diff: number; oldAcc: number; }} taskObj
     * @type {taskObj[]}
     */
    let allTaskList = [];

    if (await canUseApi(e, 'scoreStatistics')) {

        const res = await makeRequest.getAllSongAccAvgB30({
                songIds: getInfo.idList,
                minRks: Math.floor((com_rks - 0.05) / 0.05) * 0.05,
                maxRks: Math.floor((com_rks + 0.05) / 0.05) * 0.05
            }, { event: e })
        if (res) {
            const ids = fCompute.objectKeys(res)
            ids.forEach(id => {
                if (!getInfo.ori_info[id]) {
                    return;
                }
                Level.forEach(lv => {
                    if (!getInfo.ori_info[id]?.chart?.[lv]) {
                        return;
                    }
                    const avg = res[id][lv].accAvg || 0;
                    if (avg > (save.gameRecord?.[id]?.[LevelNum[lv]]?.acc || 0)) {
                        allTaskList.push({
                            id,
                            level: lv,
                            type: 'acc',
                            value: avg,
                            diff: getInfo.ori_info[id].chart[lv].difficulty,
                            oldAcc: save.gameRecord?.[id]?.[LevelNum[lv]]?.acc || 0
                        });
                    }
                })
            })
        }
    }

    allTaskList.sort((a, b) => b.value - a.value)
    /** @type {taskObj[]} */
    let cmdTask = [];
    /** @type {taskObj[]} */
    let phiTask = [];
    for (let i = 0, j = 0; i < allTaskList.length; i++) {
        if (allTaskList[i].value >= 100) {
            j = i;
        }
        if (allTaskList[i].value < 95) {
            phiTask = allTaskList.slice(0, j + 1);
            cmdTask = allTaskList.slice(j + 1, i);
            allTaskList = allTaskList.slice(i);
            break;
        }
        if (i == allTaskList.length - 1) {
            phiTask = allTaskList.slice(0, j + 1);
            cmdTask = allTaskList.slice(j + 1, i);
            allTaskList = allTaskList.slice(i);
            break;
        }
    }


    /**@type {{song: idString, level: levelKind}[][]} */
    const ranked_songs = [[], [], [], [], []] //任务难度分级后的曲目列表

    if (allTaskList.length < 5) {
        const rank_line = [];
        if (rks < 15) {
            rank_line.push(rks - 1)
            rank_line.push(rks - 0.5)
            rank_line.push(rks + 0)
            rank_line.push(rks + 1)
        } else if (rks < 16) {
            rank_line.push(rks - 1.5)
            rank_line.push(rks - 0.3)
            rank_line.push(rks + 0)
            rank_line.push(rks + 0.5)
        } else {
            rank_line.push(rks - 2)
            rank_line.push(rks - 1)
            rank_line.push(rks - 0.5)
            rank_line.push(rks + 0)
        }

        rank_line.push(18)

        /**将曲目分级并处理 */
        for (const id of fCompute.objectKeys(info)) {
            if (!info[id]?.chart) continue
            for (const level of Level) {
                if (info[id].chart[level]) {
                    if (!gameRecord[id] || !gameRecord[id][LevelNum[level]] || gameRecord[id][LevelNum[level]]?.acc != 100) {
                        const dif = info[id].chart[level].difficulty
                        for (const i in rank_line) {
                            if (dif < rank_line[i]) {
                                ranked_songs[i].push({ song: id, level })
                                break
                            }
                        }
                    }
                }
            }
        }

    }

    for (const i in ranked_songs) {
        if (task[i] && task[i].finished == true) {
            continue
        }
        if (cmdTask.length || phiTask.length) {
            /**@type {taskObj[]} */
            const crtTaskList = cmdTask.length && (!phiTask.length || randint(100) < 80) ? cmdTask : phiTask;
            const randIndex = randint(crtTaskList.length - 1);
            const aim = crtTaskList.splice(randIndex, 1)[0];
            task[i] = {
                song: aim.id,
                reward: comReward(com_rks, aim.diff, aim.value, aim.oldAcc),
                finished: false,
                request: {
                    rank: aim.level,
                    type: aim.type,
                    value: Number(aim.value.toFixed(2)),
                }
            }
        } else if (ranked_songs[i].length) {
            const randIndex = randint(ranked_songs[i].length - 1);
            const aim = ranked_songs[i][randIndex];
            if (!aim) {
                continue
            }
            const id = aim.song
            const levelN = LevelNum[aim.level]
            const diff = info?.[id]?.chart?.[aim.level]?.difficulty || 0
            const old_acc = gameRecord[id]?.[levelN]?.acc || 0
            const value = Math.min(Number(easeInSine(Math.random(), Math.min(old_acc + 0.01, 100), 100 - Math.min(old_acc + 0.01, 100), 1).toFixed(2)), 100)

            task[i] = {
                song: aim.song,
                reward: comReward(com_rks, diff, value, old_acc),
                finished: false,
                request: {
                    rank: aim.level,
                    type: 'acc',
                    value,
                }
            }

        }

    }


    return task
}

/**
 * 
 * @param {Save | false} save 
 * @param {PluginData} plugin_data 
 * @param {botEvent} e 
 */
async function picData(save, plugin_data, e) {
    const now_time = new Date()
    const todayKey = formatDateKey(now_time)

    /** 今日人品（复用 jrrp 的 redis 数据，保证一致） */
    const fortune = await createJrrp(e)

    /** 进度条（解锁/FC/PHI 三层叠加） */
    const edgeRate = {
        EZ: { unlock: '0%', fc: '0%', phi: '0%' },
        HD: { unlock: '0%', fc: '0%', phi: '0%' },
        IN: { unlock: '0%', fc: '0%', phi: '0%' },
        AT: { unlock: '0%', fc: '0%', phi: '0%' },
    }
    if (save) {
        try {
            const stats = await save.getStats()
            edgeRate.EZ.unlock = percent(stats?.[0]?.unlock, stats?.[0]?.tot)
            edgeRate.EZ.fc = percent(stats?.[0]?.fc, stats?.[0]?.tot)
            edgeRate.EZ.phi = percent(stats?.[0]?.phi, stats?.[0]?.tot)

            edgeRate.HD.unlock = percent(stats?.[1]?.unlock, stats?.[1]?.tot)
            edgeRate.HD.fc = percent(stats?.[1]?.fc, stats?.[1]?.tot)
            edgeRate.HD.phi = percent(stats?.[1]?.phi, stats?.[1]?.tot)

            edgeRate.IN.unlock = percent(stats?.[2]?.unlock, stats?.[2]?.tot)
            edgeRate.IN.fc = percent(stats?.[2]?.fc, stats?.[2]?.tot)
            edgeRate.IN.phi = percent(stats?.[2]?.phi, stats?.[2]?.tot)

            edgeRate.AT.unlock = percent(stats?.[3]?.unlock, stats?.[3]?.tot)
            edgeRate.AT.fc = percent(stats?.[3]?.fc, stats?.[3]?.tot)
            edgeRate.AT.phi = percent(stats?.[3]?.phi, stats?.[3]?.tot)
        } catch { }
    }

    /** 日历（当月） */
    const calendar = buildCalendar(now_time.getFullYear(), now_time.getMonth() + 1, new Set(plugin_data.sign_history || []), todayKey)

    /** 公告 */
    let notice = null;

    if (plugin_data.noticeCode < getInfo.noticeJson.code) {
        notice = getInfo.noticeJson
        plugin_data.noticeCode = getInfo.noticeJson.code
        await getNotes.update(e.user_id, data => { data.noticeCode = Math.max(data.noticeCode, plugin_data.noticeCode) })
    }

    /** 任务列表（展示前 5 条） */
    /**@type {{index: string, song: string, illustration: string, meta: string, finished: boolean}[]} */
    const dailyTasks = []
    if (save && Array.isArray(plugin_data.task)) {
        for (let i = 0; i < Math.min(5, plugin_data.task.length); i++) {
            const t = plugin_data.task[i]
            if (!t) continue
            const songInfo = getInfo.ori_info?.[t.song];
            const ill = getInfo.getill(t.song)
            const songName = songInfo?.song || t.song
            const meta = `${t.request?.rank || ''} ${songInfo?.chart?.[t.request.rank]?.difficulty || ''} · ${(t.request?.type || '').toUpperCase()} ${t.request?.value ?? ''} · +${t.reward || 0} Notes`
            dailyTasks.push({
                index: fCompute.ped(i + 1, 2),
                song: songName,
                illustration: ill,
                meta,
                finished: Boolean(t.finished),
            })
        }
    }

    return {
        PlayerId: save ? save.saveInfo.PlayerId : '游客玩家',
        Rks: save ? Number(save.saveInfo.summary.rankingScore).toFixed(4) : '0.0000',
        Date: fCompute.formatDate(now_time),
        ChallengeMode: save ? Math.floor(save.saveInfo.summary.challengeModeRank / 100) : 0,
        ChallengeModeRank: save ? (save.saveInfo.summary.challengeModeRank % 100) : 0,
        avatar: save ? getInfo.idgetavatar(save.gameuser.avatar) : 'Introduction',
        background: getInfo.randomBackground(),
        Notes: plugin_data.money,
        signDays: Array.isArray(plugin_data.sign_history) ? plugin_data.sign_history.length : 0,
        lucky: fortune.lucky,
        good: fortune.good,
        bad: fortune.bad,
        quote: fortune.quote,
        edgeRate,
        dailyTasks,
        calendar,
        notice,
        theme: plugin_data?.theme || 'default',
    }
}

/**
 * 计算任务奖励
 * @param {number} rks 
 * @param {number} diff 
 * @param {number} value 
 * @param {number} oldAcc 
 * @returns 
 */
function comReward(rks, diff, value, oldAcc) {
    const p1 = pCeil(pmin(pmax(diff - rks, 0) * 20, 50))
    const p2 = pCeil(pmin(pmax(value - oldAcc, 0) * 5, 20))
    const p3 = pCeil((pmax(value - 95, 0) / 5) ** 3 * 30)
    return p1 + p2 + p3;
}

/**
 * 定义生成指定区间整数随机数的函数
 * @param {Number} max 
 * @param {Number} min 默认为0
 * @returns 
 */
function randint(max, min = 0) {
    return fCompute.randInt(min, max)
}

/**
 * 
 * @param {Number} t 时间
 * @param {Number} b 最小值
 * @param {Number} c 跨度
 * @param {Number} d 总时间长度
 * @returns Number
 */
function easeInSine(t, b, c, d) {
    return -c * Math.cos(t / d * (Math.PI / 2)) + c + b;
}

/**
 * 
 * @param {Date|string|number} t 
 * @returns {Date} 当天零点时间
 */
function getDayZeroTimestamp(t) {
    const date = new Date(t);
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const zeroDate = new Date(year, month, day, 0, 0, 0);
    return zeroDate;
}

/**
 * @overload
 * @param {Date} now_time 
 * @param {0} type 是否分开
 * @returns {string}
 */
/**
 * @overload
 * @param {Date} now_time 
 * @param {1} type 是否分开
 * @returns {string[]}
 */
/**
 * @param {Date} now_time 
 * @param {number} [type=0] 是否分开
 * @returns {string|string[]}
 */
function helloMsg(now_time, type = 0) {
    const h_m_s = fCompute.formatDate(now_time, 'hh:mm:ss')
    const minutes = now_time.getHours() * 60 + now_time.getMinutes()
    /** @type {[number, string, string][]} 各时间段的结束时刻（分钟）与问候语 */
    const greetings = [
        [6 * 60, '夜深了，注意休息哦！', '(∪.∪ )...zzz'],
        [11 * 60 + 30, '早安呐！', 'ヾ(≧▽≦*)o'],
        [13 * 60, '午好嗷！', '(╹ڡ╹ )'],
        [18 * 60 + 30, '下午好哇！', '(≧∀≦)ゞ'],
        [23 * 60, '晚上好！', '( •̀ ω •́ )✧'],
    ]
    const [, text, face] = greetings.find(([end]) => minutes < end) ?? greetings[0]
    const ans = [`现在是${h_m_s}，${text}`, face]
    return type ? ans : ans.join('');
}


/**
 * 特殊日期处理
 * @param {Date} now_time 
 */
function checkSpDateIndex(now_time) {
    // 特殊日期处理
    let spDateIndex = -1;
    for (let i = 0; i < spData.length; i++) {
        const spDate = new Date(`${now_time.getFullYear()}/${spData[i].month}/${spData[i].date}`);
        if (now_time.getMonth() === spDate.getMonth() && now_time.getDate() === spDate.getDate()) {
            spDateIndex = i;
            break;
        }
    }
    return spDateIndex;
}

/**
 * 生成 YYYY-MM-DD（按本地日期）
 * @param {Date} date
 */
function formatDateKey(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/**
 * @param {number} a
 * @param {number} b
 */
function percent(a, b) {
    const aa = Number(a) || 0
    const bb = Number(b) || 0
    if (!bb) return '0%'
    return `${Math.max(0, Math.min(100, Math.round((aa / bb) * 100)))}%`
}

/**
 * 构建当月日历（周一为起始）
 * @param {number} year
 * @param {number} month 1-12
 * @param {Set<string>} signHistory YYYY-MM-DD
 * @param {string} todayKey YYYY-MM-DD
 */
function buildCalendar(year, month, signHistory, todayKey) {
    const weekdays = ['一', '二', '三', '四', '五', '六', '日']
    const daysInMonth = new Date(year, month, 0).getDate()
    const first = new Date(year, month - 1, 1)
    const firstIndex = (first.getDay() + 6) % 7 // Monday=0 ... Sunday=6

    /**@type {Array<Array<{empty: boolean, day?: number, signed?: boolean, today?: boolean}>>} */
    const weeks = []
    let day = 1

    for (let w = 0; w < 6; w++) {
        /**@type {Array<{empty: boolean, day?: number, signed?: boolean, today?: boolean}>} */
        const week = []
        for (let i = 0; i < 7; i++) {
            if ((w === 0 && i < firstIndex) || day > daysInMonth) {
                week.push({ empty: true })
                continue
            }
            const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            week.push({
                empty: false,
                day,
                signed: signHistory.has(key),
                today: key === todayKey,
            })
            day++
        }
        weeks.push(week)
    }

    return {
        title: `${year} 年 ${month} 月`,
        weekdays,
        weeks,
    }
}

/**
 * 复用 jrrp 的 redis 数据，保证同一用户同一天 fortune 一致
 * @param {botEvent} e 
 */
async function createJrrp(e) {
    try {
        // @ts-ignore
        const cacheText = await redis.get(`${redisPath}:jrrp:${e.user_id}`)
        if (cacheText) {
            try {
                const arr = JSON.parse(cacheText)
                const quote = await pickSentenceText(arr?.[1])
                return {
                    lucky: Number(arr?.[0]) || 0,
                    good: Array.isArray(arr) ? arr.slice(2, 6) : [],
                    bad: Array.isArray(arr) ? arr.slice(6, 10) : [],
                    quote,
                    oriData: arr,
                }
            } catch { }
        }

        if (!getInfo.word) {
            send.send_with_At(e, '发生未知错误QAQ，请联系管理员处理！');
            logger.error('jrrp获取词库失败，getInfo.word未定义！');
            throw new Error('jrrp word undefined');
        }
        /**@type {[number, number]} */
        let luckyRange = [0, 100];
        let good = [...getInfo.word.good]
        let bad = [...getInfo.word.bad]
        let common = [...getInfo.word.common]
        let local_sentence = sentence;

        const now_time = new Date()
        // 特殊日期处理
        const spDateIndex = checkSpDateIndex(now_time);
        if (spDateIndex !== -1 && spData[spDateIndex].jrrp) {
            luckyRange = spData[spDateIndex].jrrp.lucky ?? luckyRange
            good = spData[spDateIndex].jrrp.good ?? good
            bad = spData[spDateIndex].jrrp.bad ?? bad
            common = spData[spDateIndex].jrrp.common ?? common
            local_sentence = spData[spDateIndex].jrrp.sentence ?? local_sentence
        }
        const luckyNum = Math.round(fCompute.getValueFromRange(easeOutCubic(Math.random()) * 100, luckyRange));
        /**@type {any} */
        let sentenceIndex = Math.floor(Math.random() * local_sentence.length);
        if (local_sentence.length !== sentence?.length) {
            sentenceIndex = local_sentence[sentenceIndex];
        }
        /** @type {any[]} */
        const data = [luckyNum, sentenceIndex];
        if (luckyNum == 100) {
            data.push(..."诸事皆宜诸事皆宜".split(""));
        } else if (luckyNum == 0) {
            data.push(..."诸事不宜诸事不宜".split(""));
        } else {
            for (let i = 0; i < 4; i++) {
                const id = Math.floor(Math.random() * (good.length + common.length))
                if (id < good.length) {
                    data.push(good[id])
                    good.splice(id, 1)
                } else {
                    data.push(common[id - good.length])
                    common.splice(id - good.length, 1)
                }
            }
            for (let i = 0; i < 4; i++) {
                const id = Math.floor(Math.random() * (bad.length + common.length))
                if (id < bad.length) {
                    data.push(bad[id])
                    bad.splice(id, 1)
                } else {
                    data.push(common[id - bad.length])
                    common.splice(id - bad.length, 1)
                }
            }
        }

        // @ts-ignore 有效期到第二天 8 点
        redis.set(`${redisPath}:jrrp:${e.user_id}`, JSON.stringify(data), {
            PX: 86400000 - ((new Date().valueOf() + 28800000) % 86400000)
        })

        const quote = await pickSentenceText(sentenceIndex)
        return {
            lucky: data[0],
            good: data.slice(2, 6),
            bad: data.slice(6, 10),
            quote,
            oriData: data,
        }
    } catch (e) {
        return { lucky: 0, good: [], bad: [], quote: '', oriData: [] }
    }
}

/**
 * @param {number} x
 */
function easeOutCubic(x) {
    return 1 - Math.pow(1 - x, 3)
}

/**
 * @param {number | Record<"hitokoto", string>} idx
 */
async function pickSentenceText(idx) {
    if (typeof idx === 'object') {
        return idx.hitokoto || ''
    }
    const list = sentence ?? []
    const item = list?.[idx]
    if (!item) return ''
    if (typeof item === 'string') return item
    return item.hitokoto || ''
}

/**
 * max
 * @param {number} a 
 * @param {number} b 
 * @returns {number}
 */
function pmax(a, b) {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.max(a, b)
}

/** min
 * @param {number} a 
 * @param {number} b
 * @returns {number}
 */
function pmin(a, b) {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.min(a, b)
}

/**
 * ceil
 * @param {number} num
 * @return {number}
 */
function pCeil(num) {
    if (num === undefined) return 0
    return Math.ceil(num)
}
