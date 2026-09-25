import fs from 'node:fs'
import path from 'node:path'

/** Resolves only opaque data keys; no caller can address a parent or a symlink. */
export class LocalDataDirectory {
    /** @param {string} root */
    constructor(root) {
        this.root = path.resolve(root)
    }

    /** @param {unknown} key */
    directory(key) {
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(key)) throw new Error('本地数据标识无效')
        this.assertNotLink(this.root)
        const directory = path.join(this.root, key)
        this.assertNotLink(directory)
        return directory
    }

    /** @param {unknown} key @param {'save.json'|'history.json'} name */
    file(key, name) {
        const file = path.join(this.directory(key), name)
        this.assertNotLink(file)
        return file
    }

    /** @param {string} target */
    assertNotLink(target) {
        try {
            if (fs.lstatSync(target).isSymbolicLink()) throw new Error('本地数据路径不能是符号链接')
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
        }
    }
}
