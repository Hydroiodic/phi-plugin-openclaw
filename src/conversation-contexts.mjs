const MAX_TIMEOUT_SECONDS = Math.floor(2 ** 31 / 1000)

/** Owns interactive command sessions and their expiry timers. */
export class ConversationContexts {
  constructor() {
    this.entries = new Map()
    this.closed = false
  }

  /** @param {any} event @param {boolean} isGroup */
  key(event, isGroup) {
    return JSON.stringify([event.chatId, isGroup ? null : event.user_id])
  }

  /** @param {any} event */
  get(event) {
    return this.entries.get(this.key(event, false)) || this.entries.get(this.key(event, true))
  }

  /** @param {any} instance @param {string} name @param {boolean} [isGroup] @param {number} [timeout] */
  set(instance, name, isGroup = false, timeout = 120) {
    if (this.closed) return false
    if (!instance.e?.chatId || !instance.e?.user_id) throw new TypeError('交互上下文缺少会话或用户身份。')
    if (typeof name !== 'string' || !name || typeof instance[name] !== 'function') throw new TypeError('交互上下文处理方法不存在。')
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) throw new RangeError('交互上下文超时时间无效。')
    const key = this.key(instance.e, isGroup)
    this.remove(key)
    const entry = { instance, name, isGroup, timer: /** @type {NodeJS.Timeout | null} */ (null) }
    entry.timer = setTimeout(
      () => {
        if (this.entries.get(key) === entry) this.remove(key)
      },
      Math.max(1, timeout * 1000),
    )
    entry.timer.unref()
    this.entries.set(key, entry)
    return true
  }

  /** @param {any} instance @param {string} name @param {boolean} [isGroup] */
  finish(instance, name, isGroup = false) {
    const key = this.key(instance.e, isGroup)
    const current = this.entries.get(key)
    if (!current || current.instance !== instance || (name && current.name !== name)) return false
    this.remove(key)
    return true
  }

  /** @param {string} key */
  remove(key) {
    const current = this.entries.get(key)
    if (!current) return
    clearTimeout(current.timer)
    this.entries.delete(key)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const key of this.entries.keys()) this.remove(key)
  }
}
