import path from 'node:path'
import { homedir } from 'node:os'
import { immediateReply, isPhigrosCommand, isForeignCommand } from './commands.mjs'
import { SAVE_TOOL_NAMES, createSaveTools } from './save-tools.mjs'

export const PLUGIN_ID = 'phi-plugin-openclaw'
const NATIVE_COMMANDS = ['phi', 'phihelp', 'b30', 'b19', 'p30', 'x30', 'fc30', 'bind', 'cnbind', 'gbbind', 'unbind', 'score', 'suggest', 'song']
const loadRuntime = options => import('./runtime.mjs').then(({ createRuntime }) => createRuntime(options))

/** Host registration and lazy runtime ownership; business modules never see the host API. */
export class PhigrosPlugin {
  constructor(api, { createRuntime = loadRuntime } = {}) {
    this.api = api
    this.config = api.pluginConfig || {}
    this.createRuntime = createRuntime
    this.pending = undefined
    this.stopped = false
    this.closing = undefined
    const stateDir = api.runtime?.state?.resolveStateDir?.() || process.env.OPENCLAW_STATE_DIR || path.join(homedir(), '.openclaw')
    // Host path resolution is valid only during registration.
    this.options = { config: this.config, logger: api.logger,
      dataRoot: this.config.dataDir ? api.resolvePath(this.config.dataDir) : path.join(stateDir, PLUGIN_ID),
      mediaRoot: path.join(stateDir, 'media', PLUGIN_ID) }
  }

  allowed(channel) { return !this.config.channels?.length || this.config.channels.includes(channel) }

  ensureRuntime() {
    if (this.stopped) throw new Error('Phigros plugin is stopping')
    if (!this.pending) {
      this.pending = Promise.resolve().then(() => this.createRuntime(this.options)).catch(error => {
        this.pending = undefined
        throw error
      })
    }
    return this.pending
  }

  async handle(context, deliver) {
    if (this.stopped || !this.allowed(context.channelId || context.channel) || isForeignCommand(context.commandBody)) return false
    if (!this.pending && !isPhigrosCommand(context.commandBody)) return false
    if (context.signal?.aborted) return true
    const immediate = immediateReply(context)
    if (immediate !== null) { await deliver({ text: immediate }); return true }
    try {
      const runtime = await this.ensureRuntime()
      if (this.stopped || context.signal?.aborted) return true
      return await runtime.dispatch(context, deliver)
    } catch (error) {
      if (this.stopped || context.signal?.aborted) return true
      // Cloud request errors may contain credentials; never echo their details.
      this.api.logger.error(`Phigros command failed (${error?.name || 'Error'}).`)
      await deliver({ text: error?.name === 'ResourceError'
        ? `Phigros 资源未就绪：${error.message} 请检查资源仓库，或配置 resourceBaseUrl / PHI_RESOURCE_BASE_URL 后重试。`
        : 'Phigros 处理失败，请稍后重试；图片失败时请检查 Chrome 路径，查分失败时请检查绑定和网络。' })
      return true
    }
  }

  async handleNative(ctx) {
    if (!this.allowed(ctx.channelId || ctx.channel)) return { text: '此 channel 未启用 Phigros。' }
    const replies = []
    await this.handle({ ...ctx, isGroup: ctx.isGroup === true || /(?:^|:)(?:group|channel|guild)(?::|$)/.test(ctx.from || '') },
      payload => { replies.push(payload); return true })
    return { text: replies.map(reply => reply.text).filter(Boolean).join('\n'), mediaUrls: replies.flatMap(reply => reply.mediaUrls || []) }
  }

  async handleDispatch(event, hook) {
    const ctx = event.ctx
    const channel = ctx.OriginatingChannel || ctx.Provider || ctx.Surface
    if (!this.allowed(channel) || event.isTailDispatch || event.sendPolicy === 'deny' || event.suppressUserDelivery || !ctx.SenderId) return
    let queuedFinal = false
    const handled = await this.handle({
      channel, channelId: channel, accountId: ctx.AccountId, senderId: ctx.SenderId,
      senderName: ctx.SenderName, commandBody: String(ctx.CommandBody ?? ctx.RawBody ?? ''), from: ctx.From, to: ctx.To,
      conversationId: ctx.From, isGroup: ctx.ChatType === 'group' || ctx.ChatType === 'channel',
      messageId: ctx.MessageSid, messageThreadId: ctx.MessageThreadId, signal: hook.abortSignal,
    }, payload => {
      if (hook.abortSignal?.aborted) return false
      const queued = hook.dispatcher.sendFinalReply(payload)
      queuedFinal ||= queued
      return queued
    })
    if (!handled) return
    hook.recordProcessed('completed', { reason: 'phigros_command' })
    hook.markIdle('phigros_complete')
    return { handled: true, queuedFinal, counts: hook.dispatcher.getQueuedCounts() }
  }

  register() {
    this.api.registerReload?.({ restartPrefixes: [`plugins.entries.${PLUGIN_ID}`] })
    for (const name of NATIVE_COMMANDS) {
      this.api.registerCommand({ name,
        description: name === 'phi' ? 'Phigros 查询与管理，/phi 查看帮助' : `Phigros ${name}`,
        acceptsArgs: true, requireAuth: false, handler: ctx => this.handleNative(ctx) })
    }
    this.api.on('reply_dispatch', (event, hook) => this.handleDispatch(event, hook), { priority: 100 })
    const saveTools = this.config.saveEditing !== false && typeof this.api.registerTool === 'function'
    if (saveTools) {
      this.api.registerTool(ctx => this.allowed(ctx.messageChannel) ? createSaveTools(ctx,
        async (...args) => (await this.ensureRuntime()).runSaveTool(...args), this.api.logger) : null, { names: SAVE_TOOL_NAMES })
    }
    this.api.registerService({ id: PLUGIN_ID,
      start: () => this.api.logger.info(`Phigros ready: commands and reply_dispatch registered${saveTools ? ', save tools enabled' : ''}.`),
      stop: () => this.close() })
  }

  close() {
    this.stopped = true
    return this.closing ||= (async () => {
      const runtime = await this.pending?.catch(() => undefined)
      await runtime?.close()
    })()
  }
}
