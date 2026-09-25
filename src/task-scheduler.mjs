/** Owns background task timers and drains running work before storage closes. */
export class TaskScheduler {
  constructor(logger) {
    this.logger = logger
    this.timers = new Set()
    this.running = new Map()
    this.stopped = false
  }

  schedule(instance) {
    if (this.stopped) throw new Error('Task scheduler is closed')
    const task = instance.task
    if (!task?.interval) return
    if (!Number.isInteger(task.interval) || task.interval < 1 || task.interval > 2 ** 31 - 1) throw new RangeError('Invalid task interval')
    const callback = typeof task.fnc === 'string' ? instance[task.fnc] : task.fnc
    if (typeof callback !== 'function') throw new TypeError('Invalid task handler')
    const timer = setInterval(() => this.run(instance, callback), task.interval)
    timer.unref()
    this.timers.add(timer)
  }

  run(instance, callback) {
    if (this.stopped || this.running.has(instance)) return
    const work = Promise.resolve()
      .then(() => callback.call(instance))
      .catch(() => {
        this.logger.warn('Phigros 后台同步失败，将于下一周期重试。')
      })
      .finally(() => this.running.delete(instance))
    this.running.set(instance, work)
    return work
  }

  async close() {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    await Promise.allSettled([...this.running.values()])
  }
}
