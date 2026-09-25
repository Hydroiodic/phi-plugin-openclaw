export const HELP = `phi-plugin-openclaw · Phigros 查分

| 分类 | 命令示例 | 说明 |
| --- | --- | --- |
| 绑定 | /bind qrcode | 扫码绑定，使用默认服务器 |
| 绑定 | /bind <sessionToken> | 使用存档凭据绑定 |
| 绑定 | /cnbind qrcode | 明确绑定国服 |
| 绑定 | /gbbind qrcode | 明确绑定国际服 |
| 存档 | /phi update | 更新游戏存档 |
| 存档 | /unbind | 解除本地绑定 |
| 成绩 | /b30 | Best30 成绩图 |
| 成绩 | /p30、/fc30、/x30 | 其他成绩列表 |
| 成绩 | /score <曲名> | 查询单曲成绩 |
| 成绩 | /suggest | 推分建议 |
| 统计 | /phi info、/phi list | 个人信息与成绩筛选 |
| 曲目 | /song <曲名> | 曲目信息 |
| 曲目 | /phi search | 检索曲目 |
| 曲目 | /phi table <定数> | 查看定数表 |
| 娱乐 | /phi sign、/phi task | 签到与任务 |
| 娱乐 | /phi jrrp | 今日人品 |
| 游戏 | /phi tipgame | 提示猜曲 |
| 游戏 | /phi guess、/phi ltr | 猜曲绘、开字母 |
| 设置 | /phi myset、/phi market | 个人设置与主题市场 |
| 交互 | /phi reply <内容> | 多轮选择或游戏回答 |
| 帮助 | /phi help | 完整图片菜单 |
| 管理 | /phi identity | 查看管理员配置所需的身份 |`

export const LICENSE_TEXT = '项目说明见 README：\nhttps://github.com/Hydroiodic/phi-plugin-openclaw#readme'

const HOST_COMMANDS = new Set(['help', 'status', 'new', 'reset', 'stop', 'compact', 'model', 'models', 'think',
  'config', 'restart', 'plugins', 'allowlist', 'approve', 'commands', 'usage', 'tts', 'exec', 'queue', 'send',
  'whoami', 'session', 'skill', 'btw', 'verbose', 'reasoning', 'elevated', 'activation', 'debug', 'agents', 'subagents', 'acp', 'context'])

const stripMention = text => String(text || '').trim().replace(/^(?:(?:<@!?\d+>|<at\b[^>]*\/?>(?:<\/at>)?|\[CQ:at,[^\]]+\])\s*)+/i, '')
const PREFIX = /^[#/杠刚钢纲](?:phi|pgr|屁股肉)\s*/i
const UNPREFIXED = /^phi\s*(?:sign(?: in)?|签到|打卡|task|我的任务|retask|刷新任务|theme\s*\d+)$/i
const REVEAL = /^[#/](?:出|开|翻|揭|看|翻开|打开|揭开|open)\s*\S$/
const ATTACHED_BINDING = /^[#/](?:(?:cn|gb)?绑定|(?:cn|gb)?bind(?:[A-Za-z0-9]{25}|qrcode)$)/i
// These short forms share the full /phi command handlers. Host command names
// such as /help and /send retain their OpenClaw meaning; use /phi help/send.
const SHORT_HEADS = new Set(('bind cnbind gbbind unbind 绑定 cn绑定 gb绑定 解绑 更新存档 update clean sessionToken '
  + 'b B p P x X fc FC rks pgr lmtacc best score score1 score2 单曲成绩 单曲成绩1 单曲成绩2 suggest 推分 推分建议 chap achievement ahv '
  + 'song 曲 search 查找 检索 setnic setnick 设置别名 ill 曲绘 randclg rand random 随机 alias com 计算 tips newlog live table 定数表 difhis difhistory 历史定数 '
  + 'comment cmt 评论 评价 recmt mycmt addtag subtag retag newnotice chart tag settag '
  + 'sign 签到 打卡 task 我的任务 retask 刷新任务 theme jrrp 今日人品 送 转 '
  + 'tipgame 提示猜曲 ltr letter 开字母 guess 猜曲绘 tip 提示 ans 答案 结束 '
  + 'ranklist 排行榜 rankfind 查询排名 market nx pr 上一页 下一页 mysetting myset 用户设置 个人设置 set 设置 '
  + 'data info info1 info2 lvscore lvsco scolv list 年度总结 2025history hisb30 '
  + 'setApiToken tkls lstk auth clearApiData updateHistory updateUserToken updateComment apiset '
  + 'resetApiBot 重置API botClaimLink 获取Bot认领链接 repu backup restore get del allow ban unban '
  + 'gx 更新 强制更新 qz更新 强制gx qzgx downill upill 下载曲绘 更新曲绘 gxill down up 下载 '
  + 'phihelp openclawhelp api tk token tok 帮助 命令 菜单 说明 功能 指令 使用说明').toLowerCase().split(' '))
export function isPhigrosCommand(text) {
  const value = stripMention(text)
  if (PREFIX.test(value) || UNPREFIXED.test(value) || REVEAL.test(value) || ATTACHED_BINDING.test(value)) return true
  const head = value.match(/^[#/]([^\s]+)/)?.[1].toLowerCase()
  return Boolean(head && !HOST_COMMANDS.has(head) && (SHORT_HEADS.has(head) || /^(?:[bpx]|fc|best)\d+$/.test(head)))
}

export function normalizeCommand(text) {
  const value = stripMention(text)
  // The channel normally strips mentions. Only consume structured leading mentions,
  // never display-name text or an embedded slash in an ordinary conversation.
  if (HOST_COMMANDS.has(value.match(/^\/([^\s]+)/)?.[1].toLowerCase())) return value
  if (REVEAL.test(value)) return value.replace(/^#/, '/')
  if (PREFIX.test(value)) return value.replace(PREFIX, '/phi ')
  if (UNPREFIXED.test(value)) return value.replace(/^phi\s*/i, '/phi ')
  if (/^[#/]/.test(value)) return `/phi ${value.slice(1).trim()}`
  return value
}

const PRIVATE_COMMAND = /^\/phi\s+(?:(?:cn|gb)?(?:bind|绑定)|unbind|解绑|sessiontoken|auth|setApiToken|tkls|lstk|clearApiData|clean)/i
const ADMIN_MODULES = new Set(['manage', 'botClient', 'update'])

/** Resource-independent replies and privacy checks shared by both host entry paths. */
export function immediateReply({ commandBody, isGroup, channelId, channel, accountId, senderId }) {
  const command = normalizeCommand(commandBody)
  if (/^\/phi\s*$/.test(command) || /^\/phi (?:openclawhelp|phihelp)$/.test(command)) return HELP
  if (command === '/phi license') return LICENSE_TEXT
  if (command === '/phi identity') return senderId
    ? `管理员配置 ID：${channelId || channel}:${accountId || 'default'}:${senderId}` : '无法识别发送者身份，请通过已配置的聊天 channel 使用此命令。'
  if (isGroup && PRIVATE_COMMAND.test(command)) return '绑定、解绑和凭据管理请私聊机器人操作。不要在群聊发送 sessionToken。'
  return null
}

export function isForeignCommand(text) {
  return normalizeCommand(text).startsWith('/') && !isPhigrosCommand(text)
}

export class CommandRouter {
  constructor(apps, adapter) {
    this.adapter = adapter
    this.routes = Object.entries(apps).filter(([, App]) => typeof App === 'function').map(([key, App]) => {
      const instance = new App()
      const rules = (instance.rule || []).map(rule => {
        if (typeof instance[rule.fnc] !== 'function') throw new TypeError(`Invalid command handler: ${key}.${rule.fnc}`)
        return { ...rule, regexp: new RegExp(rule.reg) }
      })
      return { key, App, instance, rules }
    }).sort((a, b) => (a.instance.priority ?? 5000) - (b.instance.priority ?? 5000))
  }

  async dispatch(e) {
    const adapter = this.adapter
    if (e._signal?.aborted || isForeignCommand(e.msg)) return false
    const raw = e.msg
    e.msg = e.text = normalizeCommand(raw)
    // Apply privacy checks before a pending interactive handler can see input.
    const immediate = immediateReply({ commandBody: e.msg, isGroup: e.isGroup,
      channel: e.platform, accountId: e.self_id, senderId: e.rawSenderId })
    if (immediate !== null) {
      await adapter.reply(e, immediate); return true
    }
    const context = adapter.getContext(e)
    if (context) {
      e.msg = e.text = /^\/phi reply\s+/i.test(e.msg) ? e.msg.replace(/^\/phi reply\s+/i, '').trim() : stripMention(raw)
      if (/^(取消|cancel)$/i.test(e.msg)) {
        context.instance.e = e; context.instance.finish(context.name, context.isGroup)
        await adapter.reply(e, '已取消。'); return true
      }
      context.instance.e = e
      await context.instance[context.name](e)
      await adapter.flush(e)
      return true
    }
    if (/^\/phi reply\s+/i.test(e.msg)) e.msg = e.text = e.msg.replace(/^\/phi reply\s+/i, '')
    let matched = false
    // Explicit command routes run before the catch-all game listener.
    for (const listener of [false, true]) for (const route of this.routes) for (const rule of route.rules) {
      const isListener = rule.regexp.source === '^.*$'
      rule.regexp.lastIndex = 0
      if (isListener !== listener || !rule.regexp.test(e.msg)) continue
      if (!listener) matched = true
      if ((ADMIN_MODULES.has(route.key) || rule.permission === 'master' || route.key === 'setting' && rule.fnc === 'set') && !e.isMaster) {
        await adapter.reply(e, '此命令仅限插件管理员。使用 /phi identity 查看身份，由部署者配置 admins。'); return true
      }
      const instance = new route.App()
      instance.e = e
      const previousReplies = e._replyCount || 0
      const result = await instance[rule.fnc](e)
      await adapter.flush(e)
      if (result !== false && result !== undefined || (e._replyCount || 0) > previousReplies || adapter.hasContext(e)) return true
    }
    if (!matched && PREFIX.test(stripMention(raw))) {
      await adapter.reply(e, '未识别此 Phigros 命令。发送 /phi 查看常用命令，或 /phi help 查看完整帮助。')
      return true
    }
    return matched
  }
}

export const createRouter = (apps, adapter) => new CommandRouter(apps, adapter)
