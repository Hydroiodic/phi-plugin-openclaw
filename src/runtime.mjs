import fs from 'node:fs'
import { createPlatform } from './platform.mjs'
import { setPlatformAdapter } from '../components/platform/state.js'
import { createRouter } from './commands.mjs'
import { ensureResources } from './resources.mjs'
import { TaskScheduler } from './task-scheduler.mjs'
import { IllustrationRepository } from './illustrations.mjs'

/** Runtime owns dispatch, timers and shutdown; initialization may fail safely. */
export class PhigrosRuntime {
  constructor(adapter, router, { pictures, watchers, config, apiMonitor } = {}) {
    this.adapter = adapter
    this.router = router
    this.pictures = pictures
    this.watchers = watchers
    this.config = config
    this.apiMonitor = apiMonitor
    this.scheduler = new TaskScheduler(adapter.logger)
    this.abortController = new AbortController()
    this.active = new Set()
    this.stopped = false
    this.closing = undefined
  }

  dispatch(context, deliver) {
    if (this.stopped) return Promise.reject(new Error('Phigros runtime is closed'))
    if (context.signal?.aborted) return Promise.resolve(false)
    const operation = (async () => {
      const signal = context.signal ? AbortSignal.any([context.signal, this.abortController.signal]) : this.abortController.signal
      const e = this.adapter.fromContext({ ...context, signal }, deliver)
      try { return await this.router.dispatch(e) }
      finally { await this.adapter.flush(e) }
    })()
    this.active.add(operation)
    operation.finally(() => this.active.delete(operation)).catch(() => {})
    return operation
  }

  startTasks() {
    for (const { instance } of this.router.routes) this.scheduler.schedule(instance)
  }

  close() {
    this.stopped = true
    this.abortController.abort()
    return this.closing ||= (async () => {
      // Start each disposer independently: a synchronous throw must not prevent
      // other shutdown work or active requests from draining.
      const stopped = await Promise.allSettled([
        Promise.resolve().then(() => this.scheduler.close()),
        Promise.resolve().then(() => this.apiMonitor?.close()),
        Promise.resolve().then(() => this.adapter.illustrations?.close()), ...this.active,
      ])
      const cleanup = [() => this.pictures?.close(), () => this.config?.close(), () => this.watchers?.closeAll(), () => this.adapter.close()]
      const errors = stopped.slice(0, 3).filter(result => result.status === 'rejected').map(result => result.reason)
      for (const dispose of cleanup) {
        try { await dispose() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Phigros runtime cleanup failed')
    })()
  }
}

export async function createRuntime(options) {
  // Resolve metadata before importing feature modules with persistent paths.
  const resources = await ensureResources(options)
  const adapter = createPlatform(options)
  const runtime = new PhigrosRuntime(adapter)
  try {
    adapter.resourceInfoPath = resources.infoPath
    adapter.resourceManifest = resources.manifest
    adapter.illustrations = new IllustrationRepository({ baseUrl: resources.baseUrl, cacheRoot: resources.cacheRoot, logger: adapter.logger })
    adapter.downloadIllustrations = () => adapter.illustrations.installAll()
    setPlatformAdapter(adapter)
    runtime.watchers = (await import('../components/FileWatcherRegistry.js')).default
    runtime.config = (await import('../components/Config.js')).default
    runtime.config.runtimeOverrides = { cmdhead: 'phi', openPhiPluginApi: options.config?.enableApi === true }
    for (const key of ['renderScale', 'renderNum', 'timeout']) {
      if (options.config?.[key] !== undefined) runtime.config.runtimeOverrides[key] = options.config[key]
    }
    runtime.apiMonitor = (await import('../model/api/autoSeekApi.js')).default
    const { default: getInfo } = await import('../model/game/getInfo.js')
    await getInfo.init()
    runtime.pictures = (await import('../model/render/picmodle.js')).default
    const apps = {}
    for (const file of fs.readdirSync(new URL('../apps/', import.meta.url)).filter(file => file.endsWith('.js'))) {
      const module = await import(new URL(`../apps/${file}`, import.meta.url))
      const App = Object.values(module).find(value => typeof value === 'function')
      if (App) apps[file.slice(0, -3)] = App
    }
    runtime.router = createRouter(apps, adapter)
    runtime.startTasks()
    return runtime
  } catch (error) {
    await runtime.close().catch(() => {})
    throw error
  }
}
