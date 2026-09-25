import { userIdentity } from './identity.mjs'

export const SAVE_TOOL_NAMES = ['phigros_save_fetch', 'phigros_save_read', 'phigros_save_edit', 'phigros_save_upload']

/** 可直接展示给用户的错误；其余错误可能带有内部细节，只给出通用提示 */
const USER_FACING_ERRORS = new Set(['SaveEditError', 'SaveUploadError', 'CloudTransportError'])

// OpenClaw 私聊会话键：agent:<id>:<channel>[:<account>]:direct:<peer>[:thread:<id>]
const DIRECT_SESSION = /^agent:[^:]+:([^:]+):(?:([^:]+):)?direct:(.+?)(?::thread:[^:]+)?$/

const NOT_PRIVATE = '存档工具只能在与用户一对一、并且按用户隔离的私聊会话中使用。请让用户私聊机器人；'
    + '如果已经是私聊，请机器人管理员把 OpenClaw 的 session.dmScope 设为 "per-channel-peer"（多账号时用 "per-account-channel-peer"）。'

/**
 * 从 OpenClaw 提供的可信上下文确定是谁在操作。身份只来自宿主，模型无法通过参数指定。
 * 只接受会话本身就属于该发送者的私聊，群聊和多人共用的会话一律拒绝，
 * 这样读到的存档内容也不会进入别人能看到的上下文。
 * @param {{requesterSenderId?: string, messageChannel?: string, agentAccountId?: string, sessionKey?: string}} ctx
 * @returns {{userId: string, error?: undefined} | {error: string, userId?: undefined}}
 */
export function resolveRequester(ctx) {
    const sender = String(ctx.requesterSenderId ?? '').trim()
    const channel = String(ctx.messageChannel ?? '').trim()
    const account = String(ctx.agentAccountId ?? '').trim() || 'default'
    if (!sender || !channel) return { error: '无法确认是谁在对话。存档工具只能在用户直接发来的私聊消息中使用。' }
    const [, keyChannel, keyAccount, peer] = DIRECT_SESSION.exec(String(ctx.sessionKey ?? '')) || []
    if (!peer || keyChannel !== channel.toLowerCase() || peer !== sender.toLowerCase()
        || keyAccount !== undefined && keyAccount !== account.toLowerCase()) return { error: NOT_PRIVATE }
    return { userId: userIdentity(channel, account, sender) }
}

const LEVEL = { type: 'string', enum: ['EZ', 'HD', 'IN', 'AT', 'LEGACY'] }

const TOOLS = {
    phigros_save_fetch: {
        label: 'Phigros 读取存档',
        description: '下载并解密当前用户自己绑定的 Phigros 云存档，返回概览。会丢弃尚未上传的修改。只能操作对话者本人的存档。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    phigros_save_read: {
        label: 'Phigros 查看存档',
        description: '查看已读取的存档：overview 概览、profile 个人资料、settings 设置、progress 进度与 Data、records 成绩（可按曲名和难度筛选）、changes 未上传的修改。',
        parameters: {
            type: 'object',
            properties: {
                section: { type: 'string', enum: ['overview', 'profile', 'settings', 'progress', 'records', 'changes'], default: 'overview' },
                song: { type: 'string', description: 'records：曲名、别名或曲目 ID' },
                level: { ...LEVEL, description: 'records：只看某个难度' },
                offset: { type: 'integer', minimum: 0, description: 'records：分页起点' },
                limit: { type: 'integer', minimum: 1, maximum: 50, description: 'records：每页条数，默认 20' },
            },
            additionalProperties: false,
        },
    },
    phigros_save_edit: {
        label: 'Phigros 修改存档',
        description: '在本地修改已读取的存档，不会上传。所有字段都可省略，只写要改的部分；分数和 acc 必须能在游戏中同时出现。',
        parameters: {
            type: 'object',
            properties: {
                profile: {
                    type: 'object',
                    properties: {
                        selfIntro: { type: 'string', description: '个人简介' },
                        avatar: { type: 'string', description: '头像名称，必须是游戏内已有头像' },
                        background: { type: 'string', description: '背景曲目名称' },
                        showPlayerId: { type: 'boolean' },
                    },
                    additionalProperties: false,
                },
                settings: {
                    type: 'object',
                    properties: {
                        chordSupport: { type: 'boolean' }, fcAPIndicator: { type: 'boolean' },
                        enableHitSound: { type: 'boolean' }, lowResolutionMode: { type: 'boolean' },
                        deviceName: { type: 'string' },
                        bright: { type: 'number', minimum: 0, maximum: 1 }, musicVolume: { type: 'number', minimum: 0, maximum: 1 },
                        effectVolume: { type: 'number', minimum: 0, maximum: 1 }, hitSoundVolume: { type: 'number', minimum: 0, maximum: 1 },
                        soundOffset: { type: 'number', minimum: -1, maximum: 1, description: '谱面延迟，单位秒' },
                        noteScale: { type: 'number', minimum: 0.5, maximum: 2 },
                    },
                    additionalProperties: false,
                },
                progress: {
                    type: 'object',
                    properties: {
                        money: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 5, maxItems: 5, description: 'Data：[KB, MB, GB, TB, PB]' },
                        challengeModeRank: { type: 'integer', minimum: 0, description: '课题模式：颜色×100+等级，颜色 1~5 依次为绿蓝红金彩' },
                    },
                    additionalProperties: false,
                },
                records: {
                    type: 'array',
                    maxItems: 100,
                    items: {
                        type: 'object',
                        properties: {
                            song: { type: 'string', description: '曲名、别名或曲目 ID' },
                            level: LEVEL,
                            score: { type: 'integer', minimum: 0, maximum: 1000000 },
                            acc: { type: 'number', minimum: 0, maximum: 100 },
                            fc: { type: 'boolean' },
                            remove: { type: 'boolean', description: '为 true 时删除这条成绩' },
                        },
                        required: ['song', 'level'],
                        additionalProperties: false,
                    },
                },
            },
            additionalProperties: false,
        },
    },
    phigros_save_upload: {
        label: 'Phigros 准备上传存档',
        description: '把修改后的存档准备好上传，并把修改清单和确认码发给用户。上传只会在用户本人发送确认命令后进行，你无法代替用户确认。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
}

/**
 * @param {any} service SaveEditService
 * @param {string} name
 * @param {string} userId
 * @param {any} params
 * @param {{delivery?: {send(payload: {text: string}): Promise<unknown>}}} [extras]
 * @returns {Promise<string>}
 */
export async function runSaveTool(service, name, userId, params, { delivery } = {}) {
    switch (name) {
        case 'phigros_save_fetch': return service.fetch(userId)
        case 'phigros_save_read': return service.read(userId, params)
        case 'phigros_save_edit': return service.edit(userId, params)
        case 'phigros_save_upload': {
            const { code, changes } = await service.stage(userId)
            const message = [
                `即将把以下 ${changes.length} 项修改上传到你的 Phigros 云存档：`, ...changes, '',
                `确认无误请发送：/phi 确认上传 ${code}`, '放弃请发送：/phi 取消上传',
                '确认码 10 分钟内有效；上传前会先备份原存档。上传后请在游戏内同步存档。',
            ].join('\n')
            // 直接发给用户，模型看不到确认码，也就无法转述出与实际不符的内容
            if (typeof delivery?.send === 'function') {
                try {
                    await delivery.send({ text: message })
                    return '修改清单和确认码已经直接发给用户。请提醒用户核对后自己发送确认命令，你无法替用户确认。'
                } catch {}
            }
            return `${message}\n\n请把以上内容原样转告用户，确认命令必须由用户自己发送。`
        }
        default: throw new Error(`Unknown save tool ${name}`)
    }
}

/**
 * @param {any} ctx OpenClaw 工具上下文
 * @param {(name: string, userId: string, params: any, extras: {delivery?: any}) => Promise<string>} run
 * @param {{error(message: string): void}} [logger]
 */
export function createSaveTools(ctx, run, logger) {
    const requester = resolveRequester(ctx)
    return SAVE_TOOL_NAMES.map(name => ({
        name,
        ...TOOLS[/** @type {keyof typeof TOOLS} */ (name)],
        /** @param {string} _toolCallId @param {any} params */
        async execute(_toolCallId, params) {
            let text, ok = false
            if (requester.error) text = requester.error
            else {
                try {
                    text = await run(name, requester.userId, params ?? {}, { delivery: ctx.delivery })
                    ok = true
                } catch (error) {
                    const type = /** @type {any} */ (error)?.name
                    if (USER_FACING_ERRORS.has(type)) text = /** @type {Error} */ (error).message
                    else if (type === 'ResourceError') text = 'Phigros 资源还没有准备好，请稍后再试。'
                    else {
                        logger?.error(`Phigros save tool ${name} failed (${type || 'Error'}).`)
                        text = '存档操作失败，请稍后重试。'
                    }
                }
            }
            return { content: [{ type: 'text', text }], details: { ok } }
        },
    }))
}
