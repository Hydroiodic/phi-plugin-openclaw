// OpenClaw port, 2026-09-20: updates belong to the host package manager.
import phiPluginBase from '../components/baseClass.js'
import { getPlatformAdapter } from '../components/platform/state.js'

let downloading = false
export class PhiUpdate extends phiPluginBase {
    constructor() {
        super({
            name: 'phi-update',
            priority: 1009,
            rule: [
                { reg: '^[/#]phi\\s*(强制|qz)?(更新|gx)$', fnc: 'update' },
                { reg: '^[/#]phi\\s*(下载|更新|gx|down|up)\\s*(曲绘|ill)$', fnc: 'illustrations' },
            ],
        })
    }
    async update() {
        return this.reply(
            '请在终端使用 openclaw plugins update phi-plugin-openclaw 更新插件，再重启 Gateway。本地链接安装请更新源码并安装依赖。更新游戏存档请使用 /phi update。',
        )
    }
    async illustrations() {
        if (!this.e.isMaster) return this.reply('此命令仅限插件管理员。')
        if (downloading) return this.reply('曲绘正在下载，请稍候。')
        downloading = true
        try {
            await this.reply('开始从资源服务器下载完整曲绘；已有校验通过的图片会复用。默认查分会按需下载并缓存曲绘。')
            const download = getPlatformAdapter()?.downloadIllustrations
            if (!download) throw new Error('资源下载器未初始化。')
            await download()
            await this.reply('曲绘更新完成。')
        } catch {
            await this.reply('曲绘下载失败，请检查资源服务器的 illustrations 目录、网络和磁盘空间；已有文件已保留。')
        } finally {
            downloading = false
        }
    }
}
