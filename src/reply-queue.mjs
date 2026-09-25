/** One command's replies and deferred menus, shared by all event clones. */
export class ReplyQueue {
  constructor(isActive = () => true) {
    this.isActive = isActive
    /** @type {Set<Promise<unknown>>} */
    this.pending = new Set()
    /** @type {Promise<unknown>} */
    this.tail = Promise.resolve()
    /** @type {Array<() => unknown>} */
    this.after = []
    /** @type {Promise<void> | null} */
    this.flushing = null
    this.count = 0
  }

  /** @template T @param {Promise<T>} task */
  track(task) {
    const promise = Promise.resolve(task)
    this.pending.add(promise)
    // Handlers may deliberately fire-and-forget. flush remains the owner of
    // failures, while this handler prevents an unhandled rejection meanwhile.
    promise.catch(() => {})
    return promise
  }

  /** @param {() => unknown} callback */
  enqueue(callback) {
    if (!this.isActive()) return Promise.resolve(false)
    this.count += 1
    const task = this.track(this.tail.then(() => (this.isActive() ? callback() : false)))
    this.tail = task.catch(() => {})
    return task
  }

  /** @param {() => unknown} callback */
  defer(callback) {
    if (typeof callback !== 'function') throw new TypeError('Reply footer must be a function')
    if (this.isActive()) this.after.push(callback)
  }

  flush() {
    // Concurrent flushes must join the same drain: a second caller must not
    // run a footer while the first caller is awaiting a slow image delivery.
    if (!this.flushing) {
      this.flushing = Promise.resolve()
        .then(() => this.drain())
        .finally(() => {
          this.flushing = null
        })
    }
    return this.flushing
  }

  async drain() {
    let failure
    let failed = false
    while (this.pending.size || this.after.length) {
      if (this.pending.size) {
        const pending = [...this.pending]
        this.pending.clear()
        for (const result of await Promise.allSettled(pending)) {
          if (result.status === 'rejected' && !failed) {
            failed = true
            failure = result.reason
          }
        }
      } else if (failed || !this.isActive()) {
        this.after.length = 0
      } else {
        try {
          await this.after.shift()?.()
        } catch (error) {
          failed = true
          failure = error
          this.after.length = 0
        }
      }
    }
    if (failed) throw failure
  }
}
