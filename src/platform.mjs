import fs from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'
import { SqliteStore } from './sqlite.mjs'
import { TemplateRenderer } from './renderer.mjs'
import { ReplyQueue } from './reply-queue.mjs'
import { ConversationContexts } from './conversation-contexts.mjs'
import { MessagePayloadEncoder } from './message-payload.mjs'
import { identity, userIdentity } from './identity.mjs'

const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export { userIdentity }

/** @param {string} value */
export const redactLog = value =>
  value
    .replace(/\b[A-Za-z0-9]{25}\b/g, '[sessionToken redacted]')
    .replace(/(\b(?:authorization|access_token|refresh_token|apiKey)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, '$1[redacted]')

// Without a host logger (tests and standalone use) diagnostics go to stderr, so they never
// interleave with stdout, which the Node test runner uses for its serialized protocol.
const STDERR_LOGGER = { info: console.error, warn: console.error, error: console.error, debug: console.error }

/** OpenClaw-facing facade; queue, payload and conversation lifecycles have owners. */
export class OpenClawPlatform {
  /** @param {{dataRoot?: string, logger?: any, config?: any, mediaRoot?: string}} [options] */
  constructor({ dataRoot, logger = STDERR_LOGGER, config = {}, mediaRoot } = {}) {
    this.name = 'openclaw'
    this.dataRoot = dataRoot
    this.rootPath = dataRoot || process.cwd()
    this.config = config
    this.closed = false
    /** @type {{ prepare<T>(value: T): Promise<T>, installAll(): Promise<unknown>, close(): Promise<void> } | null} */
    this.illustrations = null
    this.contexts = new ConversationContexts()
    this.payloadEncoder = new MessagePayloadEncoder(mediaRoot || path.join(this.rootPath, 'temp', 'media'))
    this.redis = new SqliteStore(dataRoot ? path.join(dataRoot, 'phi.sqlite') : ':memory:')
    this.logger = Object.fromEntries(
      ['info', 'warn', 'error', 'debug', 'mark'].map(name => [
        name,
        (/** @type {unknown[]} */ ...args) => {
          const method = name === 'mark' ? 'info' : name
          const sink =
            typeof logger[method] === 'function' ? logger[method] : typeof logger.info === 'function' ? logger.info : console.error
          sink.call(logger, redactLog(args.map(value => (typeof value === 'string' ? value : inspect(value))).join(' ')))
        },
      ]),
    )
    this.logger.green = this.logger.red = value => value
    this.RendererBase = TemplateRenderer
    this.segment = {
      image: (/** @type {unknown} */ data) => ({ __phiSegment: true, type: 'image', data }),
      at: (/** @type {string} */ userId) => ({ __phiSegment: true, type: 'at', userId }),
      text: (/** @type {string} */ text) => text,
      markdown: (/** @type {string} */ text) => ({ __phiSegment: true, type: 'markdown', text }),
      record: (/** @type {unknown} */ data) => ({ __phiSegment: true, type: 'image', data }),
    }
    const contexts = this.contexts
    this.PluginBase = class {
      /** @type {any} */
      e
      constructor(options = {}) {
        Object.assign(this, options)
      }
      /** @param {string} name @param {boolean} [isGroup] @param {number} [timeout] */
      setContext(name, isGroup = false, timeout = 120) {
        return contexts.set(this, name, isGroup, timeout)
      }
      /** @param {string} name @param {boolean} [isGroup] */
      finish(name, isGroup = false) {
        return contexts.finish(this, name, isGroup)
      }
    }
  }

  getBotConfig() {
    return { chromium_path: this.config.chromiumPath }
  }
  getPackageVersion() {
    return packageVersion
  }
  getBotNickname() {
    return 'OpenClaw'
  }
  /** @param {any} e */
  getAdapterName(e) {
    return e?.platform === 'qqbot' ? 'QQBot' : 'openclaw'
  }
  isBotReady() {
    return !this.closed && Boolean(this.dataRoot)
  }
  /** @param {any} message */
  toPlatformMessage(message) {
    return message
  }

  assertOpen() {
    if (this.closed) throw Object.assign(new Error('Phigros 平台已关闭。'), { code: 'PHI_PLATFORM_CLOSED' })
  }

  /** @param {any} e */
  wrapEvent(e) {
    if (e == null) return e
    if (!e._replies) {
      e._replies = new ReplyQueue(() => !this.closed && !e._signal?.aborted)
      for (const task of e._tasks || []) e._replies.track(task)
      e._tasks = e._replies.pending
      e._replies.count = e._replyCount || 0
      Object.defineProperty(e, '_replyCount', {
        configurable: true,
        enumerable: true,
        get: () => e._replies.count,
        set: value => {
          e._replies.count = value
        },
      })
    }
    e.msg ??= e.text || ''
    e.userId ??= String(e.user_id ?? '')
    e.user_id = e.userId
    e.reply ??= (/** @type {any} */ msg) => this.reply(e, msg)
    return e
  }

  /** @param {any} e @param {any} [overrides] */
  cloneEvent(e, overrides = {}) {
    this.wrapEvent(e)
    const clone = { ...e, ...overrides, _tasks: e._tasks, _replies: e._replies }
    clone.text = clone.msg
    Object.defineProperty(clone, '_replyCount', {
      enumerable: true,
      get: () => e._replies.count,
      set: value => {
        e._replies.count = value
      },
    })
    clone.reply = (/** @type {any} */ msg) => this.reply(clone, msg)
    return clone
  }

  /** @param {any} ctx @param {(payload: any) => any} deliver */
  fromContext(ctx, deliver) {
    this.assertOpen()
    const channel = String(ctx.channelId || ctx.channel || 'unknown')
    const account = String(ctx.accountId || 'default')
    if (ctx.senderId == null || !String(ctx.senderId).trim()) throw new Error('OpenClaw 未提供发送者身份，无法安全查分。')
    const isGroup = ctx.isGroup === true
    const userId = userIdentity(channel, account, String(ctx.senderId))
    const conversation = String(ctx.conversationId || ctx.to || ctx.from || ctx.senderId)
    const chatId = identity(channel, account, conversation, ctx.messageThreadId || '')
    const e = this.wrapEvent({
      msg: ctx.commandBody || '',
      user_id: userId,
      userId,
      platform: channel,
      chatId,
      group_id: isGroup ? chatId : undefined,
      groupId: isGroup ? chatId : undefined,
      isGroup,
      isPrivate: !isGroup,
      chatType: isGroup ? 'group' : 'private',
      sender: { nickname: ctx.senderName || 'Phigros 玩家', user_id: userId, card: ctx.senderName || '' },
      self_id: account,
      rawSenderId: String(ctx.senderId),
      message_id: ctx.messageId,
      isMaster: (Array.isArray(this.config.admins) ? this.config.admins : []).includes(`${channel}:${account}:${ctx.senderId}`),
      is_admin: false,
      is_owner: false,
      _deliver: deliver,
      _signal: ctx.signal,
    })
    // QQ exposes no group roster here. Transfers resolve only known users,
    // isolated by channel and bot account.
    e._replies.track(
      this.redis.set(
        `phiPlugin:knownUser:${userId}`,
        JSON.stringify({
          channel,
          account,
          user_id: userId,
          nickname: ctx.senderName || 'Phigros 玩家',
        }),
      ),
    )
    return e
  }

  /** @param {any} e @param {string} target */
  async pickMember(e, target) {
    let raw = String(target ?? '')
      .trim()
      .replace(/^<@!?([^>]+)>$/, '$1')
      .replace(/^\[CQ:at,qq=([^,\]]+)(?:,[^\]]*)?\]$/, '$1')
      .replace(/^@/, '')
    if (!raw) return null
    const prefix = `${e.platform}:${e.self_id}:`
    if (raw.startsWith(prefix)) raw = raw.slice(prefix.length)
    const candidates = [userIdentity(e.platform, e.self_id, raw)]
    if (/^[a-f0-9]{64}$/.test(raw)) candidates.push(raw)
    for (const id of candidates) {
      const stored = await this.redis.get(`phiPlugin:knownUser:${id}`)
      if (!stored) continue
      try {
        const member = JSON.parse(stored)
        if (member?.channel === e.platform && member.account === e.self_id && member.user_id === id) return member
      } catch {
        this.logger.warn('忽略无法解析的用户缓存。')
      }
    }
    return null
  }

  /** @param {any} e @param {any} message */
  reply(e, message) {
    if (this.closed || e._signal?.aborted) return Promise.resolve(false)
    this.wrapEvent(e)
    return e._replies.enqueue(async () => {
      if (e._signal?.aborted) return false
      const payload = await this.payload(message)
      if (this.closed || e._signal?.aborted || (!payload.text && !payload.mediaUrls?.length)) return false
      return e._deliver ? e._deliver(payload) : false
    })
  }

  /** @param {any} e @param {() => Promise<unknown>} callback */
  afterReplies(e, callback) {
    if (!this.closed && !e._signal?.aborted) this.wrapEvent(e)._replies.defer(callback)
  }
  /** @param {any} e @param {any} message */
  sendWithAt(e, message) {
    return this.reply(e, message)
  }
  /** @param {any} e */
  flush(e) {
    return this.wrapEvent(e)._replies.flush()
  }
  /** @param {any} message */
  async payload(message) {
    return this.payloadEncoder.encode(await this.prepareIllustrations(message))
  }
  /** @template T @param {T} value @returns {Promise<T>} */
  async prepareIllustrations(value) {
    return this.illustrations ? this.illustrations.prepare(value) : value
  }
  /** @param {any} e @param {any} message */
  async sendPrivate(e, message) {
    if (e.isPrivate) return this.reply(e, message)
    throw new Error('请在与机器人的私聊中使用此命令。')
  }
  async replyPrivate() {
    throw new Error('请在与机器人的私聊中使用此命令。')
  }
  async recall() {
    return false
  }
  /** @param {any} e @param {any[]} messages @param {string} description */
  async makeForwardMsg(e, messages = [], description) {
    return [description || '', ...messages.flatMap(message => [message?.message ?? message, '\n'])]
  }
  /** @param {number} ms */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
  /** @param {string} dir */
  mkdirs(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return true
  }
  /** @param {string} url @param {string} file */
  async downFile(url, file) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (!response.ok) {
      await response.body?.cancel()
      return false
    }
    this.mkdirs(path.dirname(file))
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
    return true
  }
  /** @param {any} e */
  async uploadFile(e) {
    return this.reply(e, '请在插件数据目录的 backup 文件夹中读取备份文件。')
  }
  async restartBot() {
    return false
  }
  /** @param {any} e */
  hasContext(e) {
    return Boolean(this.contexts.get(e))
  }
  /** @param {any} e */
  getContext(e) {
    return this.contexts.get(e)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.contexts.close()
    this.redis.close()
  }
}

/** @param {ConstructorParameters<typeof OpenClawPlatform>[0]} [options] */
export function createPlatform(options) {
  return new OpenClawPlatform(options)
}
