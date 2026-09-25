import Config from '../components/Config.js'
import phiPluginBase from '../components/baseClass.js'
import logger from '../components/Logger.js'
import send from '../model/render/send.js'
import saveEditService from '../model/save/saveEditService.js'

/**@import {botEvent} from '../components/baseClass.js' */

/** 用户亲自确认或取消 AI 助手准备好的存档上传；助手无法代发这些命令。 */
export class phiSaveEdit extends phiPluginBase {
    constructor() {
        super({
            name: 'phi-save-edit',
            dsc: '确认或取消存档上传',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(确认上传|saveupload)(\\s*)([A-Za-z0-9]*)$`,
                    fnc: 'confirm',
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(取消上传|savecancel)$`,
                    fnc: 'cancel',
                },
            ],
        })
    }

    /** @param {botEvent} e */
    async confirm(e) {
        if (!e.isPrivate) {
            send.send_with_At(e, '请在私聊中确认存档上传。')
            return true
        }
        const code = e.msg.match(/(?:确认上传|saveupload)\s*([A-Za-z0-9]*)$/i)?.[1]
        if (!code) {
            send.send_with_At(e, `请带上确认码，例如 /${Config.getUserCfg('config', 'cmdhead')} 确认上传 ABC234`)
            return true
        }
        send.send_with_At(e, '正在上传存档，请稍等…')
        try {
            const { changes } = await saveEditService.confirm(e.user_id, code)
            send.send_with_At(
                e,
                `上传完成，已写入 ${changes.length} 项修改，原存档已备份。\n请在游戏内选择从云端同步存档；查分数据可发送 /${Config.getUserCfg('config', 'cmdhead')} update 更新。`,
            )
        } catch (/** @type {any} */ error) {
            if (error?.name === 'SaveEditError' || error?.name === 'SaveUploadError' || error?.name === 'CloudTransportError') {
                send.send_with_At(e, `上传失败：${error.message}`)
            } else {
                logger.error(`[phi-plugin] 存档上传失败 (${error?.name || 'Error'})`)
                send.send_with_At(e, '上传失败，请稍后重试。云端存档没有被修改时无需担心；如有疑问请联系机器人管理员。')
            }
        }
        return true
    }

    /** @param {botEvent} e */
    async cancel(e) {
        const cancelled = await saveEditService.cancel(e.user_id)
        send.send_with_At(e, cancelled ? '已取消本次存档上传，修改仍保留，可以继续编辑。' : '当前没有待确认的存档上传。')
        return true
    }
}
