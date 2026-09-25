import Config from '../components/Config.js';
import send from '../model/render/send.js';
import picmodle from '../model/render/picmodle.js';
import getBackup from '../model/save/getBackup.js';
import fs from 'node:fs';
import { backupPath } from '../model/filesystem/path.js';
import path from 'node:path';
import fCompute from '../model/game/fCompute.js';
import getRksRank from '../model/game/getRksRank.js';
import getSave from '../model/save/getSave.js';
import userCredentialStore from '../model/user/userCredentialStore.js';
import { redisPath } from '../model/game/constNum.js';
import phiPluginBase from '../components/baseClass.js';
import logger from '../components/Logger.js';
import { redis } from '../components/platform/index.js';

/**@import {botEvent} from '../components/baseClass.js' */

const banSetting = ["help", "bind", "b19", "wb19", "song", "ranklist", "fnc", "tipgame", "guessgame", "ltrgame", "sign", "setting", "dan", "apiSetting"]

/** @param {botEvent} e */
const restoreKey = e => JSON.stringify([e.user_id, e.chatId || e.group_id || 'private'])

export class phiset extends phiPluginBase {
    constructor() {
        super({
            name: 'phi-manage',
            dsc: 'phigros屁股肉管理',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})\\s*repu$`,
                    fnc: 'restartpu'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})\\s*backup(\\s*back)?$`,
                    fnc: 'backup'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})\\s*restore$`,
                    fnc: 'restore'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})\\s*get .*$`,
                    fnc: 'get'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})\\s*del .*$`,
                    fnc: 'del'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})\\s*allow .*$`,
                    fnc: 'allow'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})\\s*ban .*$`,
                    fnc: 'ban'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})\\s*unban .*$`,
                    fnc: 'unban'
                }
            ]
        })
        /** @type {Map<string, {files:string[],expiresAt:number}>} */
        this.restoreChoices = new Map()
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async restartpu(e) {
        if (!e.isMaster) {
            return false
        }
        try {
            await picmodle.restart()
            send.send_with_At(e, `成功`)
        } catch (err) {
            logger.error('[phi-plugin] 重启渲染器失败', err)
            send.send_with_At(e, '重启渲染器失败，请查看日志。')
        }
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async backup(e) {
        if (!e.isMaster) {
            return false
        }
        send.send_with_At(e, '开始备份，请稍等...')
        // Keep the reply dispatcher alive until backup output has been queued.
        try {
            await getBackup.backup(e)
        } catch (err) {
            logger.error(err)
            send.send_with_At(e, '备份失败，请检查插件数据目录和磁盘空间。')
        }
        return true
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    restore(e) {
        if (!e.isMaster) {
            return false
        }
        try {
            for (const [key, choice] of this.restoreChoices) {
                if (choice.expiresAt <= Date.now()) this.restoreChoices.delete(key)
            }
            const files = fs.existsSync(backupPath) ? fs.readdirSync(backupPath, { withFileTypes: true })
                .filter(entry => entry.isFile() && /\.zip$/i.test(entry.name)).map(entry => entry.name).sort() : []
            if (!files.length) {
                send.send_with_At(e, '暂无可恢复的 ZIP 备份，请先执行 backup。')
                return true
            }
            this.restoreChoices.set(restoreKey(e), { files, expiresAt: Date.now() + 30_000 })
            send.send_with_At(e, '请选择需要恢复的备份文件：\n' + files.map((file, index) => `[${index}]${file}`).join('\n'))
            this.setContext('doRestore', false, 30, '超时已取消，请注意 @Bot 进行回复哦！')
        } catch (err) {
            logger.error(err)
            send.send_with_At(e, '无法读取备份目录，请检查目录权限。')
        }

    }

    async doRestore() {
        const e = this.e
        if (!e.isMaster) {
            return false
        }

        try {
            const choice = this.restoreChoices.get(restoreKey(e))
            const input = e.msg.trim()
            const index = Number(input)
            if (!choice || choice.expiresAt <= Date.now()) {
                send.send_with_At(e, '备份选择已过期，请重新执行 restore。')
                return
            }
            if (!/^\d+$/.test(input) || !Number.isSafeInteger(index) || !choice.files[index]) {
                send.send_with_At(e, '备份序号无效，请重新执行 restore 并选择列表中的序号。')
                return
            }
            const fileName = choice.files[index]
            const filePath = path.join(backupPath, fileName)
            await getBackup.restore(filePath)
            send.send_with_At(e, `[${index}] ${fileName} 恢复成功`)
        } catch (err) {
            logger.error(err)
            send.send_with_At(e, '恢复失败，请检查备份完整性、目录权限和磁盘空间。')
        } finally {
            this.restoreChoices.delete(restoreKey(e))
            this.finish('doRestore', false)
        }
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async get(e) {
        if (!e.isMaster) {
            return false
        }
        const msg = Number(e.msg.match(/[0-9]*$/)?.[0])
        if (!msg || msg < 1) {
            send.send_with_At(e, '请输入正确的序号哦！')
            return false
        }
        const token = await getRksRank.getRankUser(msg - 1, msg)
        send.send_with_At(e, token)
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async del(e) {
        if (!e.isMaster) {
            return false
        }
        const msg = e.msg.match(/[0-9a-zA-Z]{25}$/)?.[0]
        if (!msg) {
            send.send_with_At(e, '请输入正确的sessionToken哦！')
            return false
        }
        /**@type {phigrosToken} */
        const sessionToken = /** @type {any} */ (msg);
        await getSave.deleteSaveBySessionToken(sessionToken)
        await userCredentialStore.banSessionToken(sessionToken)
        send.send_with_At(e, '成功')
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async allow(e) {
        if (!e.isMaster) {
            return false
        }
        const msg = e.msg.match(/[0-9a-zA-Z]{25}$/)?.[0]
        if (!msg) {
            send.send_with_At(e, '请输入正确的sessionToken哦！')
            return false
        }
        /**@type {phigrosToken} */
        const sessionToken = /** @type {any} */ (msg);
        await userCredentialStore.allowSessionToken(sessionToken)
        send.send_with_At(e, '成功')
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async ban(e) {
        if (!fCompute.is_admin(e) && !e.isMaster) {
            return false
        }
        if (!e.group_id) {
            send.send_with_At(e, '请在群聊中使用呐！')
            return false
        }

        const msg = e.msg.replace(/^.*ban\s*/, '');
        switch (msg) {
            case 'all': {
                for (const i in banSetting) {
                    // @ts-ignore
                    await redis.set(`${redisPath}:banGroup:${e.group_id}:${banSetting[i]}`, 1);
                }
                break
            }
            default: {
                for (const i in banSetting) {
                    if (banSetting[i] == msg) {
                        // @ts-ignore
                        await redis.set(`${redisPath}:banGroup:${e.group_id}:${banSetting[i]}`, 1);
                        break
                    }
                }
                break
            }
        }
        send.send_with_At(e, `当前: ${e.group_id}\n已禁用:\n${(
            // @ts-ignore
            await redis.keys(`${redisPath}:banGroup:${e.group_id}:*`)
        ).join('\n').replace(new RegExp(`${redisPath}:banGroup:${e.group_id}:`, 'g'), '')}`)
    }

    /**
     * 
     * @param {botEvent} e 
     * @returns 
     */
    async unban(e) {
        if (!e.isAdmin && !e.isMaster) {
            return false
        }
        if (!e.group_id) {
            send.send_with_At(e, '请在群聊中使用呐！')
            return false
        }
        const msg = e.msg.replace(/^.*unban\s*/, '');
        switch (msg) {
            case 'all': {
                for (const i in banSetting) {
                    // @ts-ignore
                    await redis.del(`${redisPath}:banGroup:${e.group_id}:${banSetting[i]}`);
                }
                break
            }
            default: {
                for (const i in banSetting) {
                    if (banSetting[i] == msg) {
                        // @ts-ignore
                        await redis.del(`${redisPath}:banGroup:${e.group_id}:${banSetting[i]}`);
                        break
                    }
                }
                break
            }
        }
        send.send_with_At(e, `当前: ${e.group_id}\n已禁用:\n${(
            // @ts-ignore
            await redis.keys(`${redisPath}:banGroup:${e.group_id}:*`)
        ).join('\n').replace(new RegExp(`${redisPath}:banGroup:${e.group_id}:`, 'g'), '')}`)
    }
}
