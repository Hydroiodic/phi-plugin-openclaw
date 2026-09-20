import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import chokidar from 'chokidar'
import { getPlatformAdapter } from './platform/state.js'

const registrySymbol = Symbol.for('phi-plugin.fileWatcherRegistry')
const globalStore = /** @type {Record<symbol, any>} */ (globalThis)

/** @param {unknown} error */
function reportWatcherError(error) {
    const logger = getPlatformAdapter()?.logger
    if (logger) logger.warn('[phi-plugin] 文件监听失败', error)
    else console.warn('[phi-plugin] 文件监听失败。')
}

/**
 * @typedef {object} FileWatcherLease
 * @property {import('chokidar').FSWatcher} watcher
 * @property {Promise<void>} ready
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {object} FileWatcherEntry
 * @property {string} file
 * @property {import('chokidar').FSWatcher} watcher
 * @property {Promise<void>} ready
 * @property {(...args: any[]) => void} onChange
 * @property {FileWatcherLease} lease
 * @property {(error?: unknown) => void} settleReady
 * @property {Promise<void>} [closing]
 * @property {string[]} events
 * @property {import('chokidar').ChokidarOptions} options
 */

export class FileWatcherRegistry {
    /** @param {{watch?: typeof chokidar.watch, onError?: (error: unknown) => void}} [options] */
    constructor({ watch = chokidar.watch, onError = reportWatcherError } = {}) {
        this.createWatcher = watch
        this.onError = onError
        /** @type {Set<Promise<void>>} */
        this.closing = new Set()
        /** @type {Map<string, FileWatcherEntry>} */
        this.entries = new Map()
    }

    /**
     * 同一个 key 在热重载后复用 watcher，只替换回调以释放旧模块引用。
     * @param {string} key
     * @param {string} file
     * @param {(...args: any[]) => void} onChange
     * @param {string[]} [events=['change']] 需要监听的 chokidar 事件（change/add/unlink/addDir/unlinkDir…）
     * @param {import('chokidar').ChokidarOptions} [watchOptions]
     * @returns {FileWatcherLease}
     */
    watch(key, file, onChange, events = ['change'], watchOptions = {}) {
        const normalizedFile = path.resolve(file)
        const current = this.entries.get(key)
        if (current?.file === normalizedFile && isDeepStrictEqual(current.events, events) && isDeepStrictEqual(current.options, watchOptions)) {
            current.onChange = onChange
            current.lease = this.createLease(key, current.watcher, current.ready)
            return current.lease
        }

        if (current) {
            this.entries.delete(key)
            void this.closeEntry(current)
        }

        /** @type {FileWatcherEntry} */
        const entry = {
            file: normalizedFile,
            watcher: /** @type {any} */ (null),
            ready: /** @type {any} */ (null),
            onChange,
            lease: /** @type {any} */ (null),
            settleReady: () => {},
            events: [...events],
            options: { ...watchOptions },
        }
        entry.watcher = this.createWatcher(normalizedFile, watchOptions)
        entry.ready = new Promise((resolve, reject) => {
            entry.settleReady = error => error ? reject(error) : resolve()
        })
        // A consumer may never await ready; still observe initialization errors.
        entry.ready.catch(() => {})
        entry.watcher.once('ready', () => entry.settleReady())
        entry.watcher.on('error', error => {
            entry.settleReady(error)
            this.reportError(error)
        })
        const watcher = /** @type {any} */ (entry.watcher)
        for (const event of events) {
            watcher.on(event, /** @type {(...args: any[]) => void} */ ((...args) => {
                try { Promise.resolve(entry.onChange(...args)).catch(error => this.reportError(error)) }
                catch (error) { this.reportError(error) }
            }))
        }
        entry.lease = this.createLease(key, entry.watcher, entry.ready)
        this.entries.set(key, entry)
        return entry.lease
    }

    /**
     * @param {string} key
     * @param {import('chokidar').FSWatcher} watcher
     * @param {Promise<void>} ready
     * @returns {FileWatcherLease}
     */
    createLease(key, watcher, ready) {
        /** @type {FileWatcherLease} */
        const lease = {
            watcher,
            ready,
            close: () => this.close(key, lease),
        }
        return lease
    }

    /**
     * @param {string} key
     * @param {FileWatcherLease} [expectedLease]
     */
    async close(key, expectedLease) {
        const entry = this.entries.get(key)
        if (!entry) return
        if (expectedLease && entry.lease !== expectedLease) return
        this.entries.delete(key)
        await this.closeEntry(entry)
    }

    async closeAll() {
        const entries = [...this.entries.values()]
        this.entries.clear()
        for (const entry of entries) void this.closeEntry(entry)
        await Promise.allSettled([...this.closing])
    }

    /** @param {{watcher: import('chokidar').FSWatcher, settleReady: (error?: unknown) => void, closing?: Promise<void>}} entry */
    closeEntry(entry) {
        if (entry.closing) return entry.closing
        entry.settleReady(Object.assign(new Error('文件监听已关闭。'), { code: 'PHI_WATCHER_CLOSED' }))
        const task = Promise.resolve().then(() => entry.watcher.close())
        entry.closing = task
        this.closing.add(task)
        task.then(() => this.closing.delete(task), error => { this.closing.delete(task); this.reportError(error) })
        return task
    }

    /** @param {unknown} error */
    reportError(error) {
        try { this.onError(error) }
        catch { console.warn('[phi-plugin] 文件监听错误处理失败。') }
    }
}

const fileWatcherRegistry = /** @type {FileWatcherRegistry} */ (
    globalStore[registrySymbol] ||= new FileWatcherRegistry()
)

export default fileWatcherRegistry
