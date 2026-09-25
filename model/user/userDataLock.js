import { AsyncLocalStorage } from 'node:async_hooks'

/** Ordered per-user locks; nested operations may reuse their already-owned keys. */
export class UserDataLock {
    constructor() {
        /** @type {Map<string, Promise<void>>} */
        this.pending = new Map()
        /** @type {AsyncLocalStorage<{keys:Set<string>,active:boolean}>} */
        this.scope = new AsyncLocalStorage()
    }

    /** @template T @param {string[]} userIds @param {()=>Promise<T>|T} operation @returns {Promise<T>} */
    async run(userIds, operation) {
        const keys = [...new Set(userIds)].sort()
        const owned = this.scope.getStore()
        if (owned?.active && keys.every(key => owned.keys.has(key))) return operation()
        if (owned?.active && owned.keys.size) throw new Error('用户数据操作不能嵌套请求未持有的锁')
        const owner = { keys: new Set(keys), active: true }
        /** @type {(()=>void)[]} */
        const releases = []
        try {
            for (const key of keys) {
                const previous = this.pending.get(key) || Promise.resolve()
                /** @type {()=>void} */
                let release = () => {}
                const gate = new Promise(resolve => {
                    release = () => resolve(undefined)
                })
                const tail = previous.then(() => gate)
                this.pending.set(key, tail)
                await previous
                releases.push(() => {
                    release()
                    if (this.pending.get(key) === tail) this.pending.delete(key)
                })
            }
            return await this.scope.run(owner, operation)
        } finally {
            owner.active = false
            for (const release of releases.reverse()) release()
        }
    }
}
