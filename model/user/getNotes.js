import readFile from '../filesystem/getFile.js'
import path from 'path'
import { pluginDataPath } from '../filesystem/path.js'
import fs from 'fs'
import PluginData from './pluginData.js'
import { UserDataLock } from './userDataLock.js'

const locks = new UserDataLock()

export default class getNotes {
    /** @template T @param {string[]} userIds @param {()=>Promise<T>|T} operation @returns {Promise<T>} */
    static withUsers(userIds, operation) {
        return locks.run(userIds, operation)
    }

    /** @param {string} userId */
    static file(userId) {
        if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(userId)) throw new Error('用户数据标识无效')
        const file = path.join(pluginDataPath, `${userId}_.json`)
        try {
            if (fs.lstatSync(file).isSymbolicLink()) throw new Error('用户数据文件不能是符号链接')
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
        }
        return file
    }

    /** @param {number} value */
    static assertBalance(value) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Notes 余额无效或超出安全范围')
    }

    /** @template T @param {string} userId @param {(data:PluginData)=>Promise<T>|T} mutation */
    static update(userId, mutation) {
        return this.withUsers([userId], async () => {
            const data = await this.getNotesData(userId)
            const result = await mutation(data)
            if ((await this.putNotesData(userId, data)) === false) throw new Error('用户数据保存失败')
            return { data, result }
        })
    }

    /** @param {string} sender @param {string} target @param {number} amount */
    static transfer(sender, target, amount) {
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('转账数量必须是正整数')
        return this.withUsers([sender, target], async () => {
            const source = await this.getNotesData(sender)
            const destination = sender === target ? source : await this.getNotesData(target)
            this.assertBalance(source.money)
            this.assertBalance(destination.money)
            if (source.money < amount) return { status: 'insufficient', source, destination }
            if (sender === target) return { status: 'self', source, destination }
            const sourceBefore = source.money,
                targetBefore = destination.money
            const received = Math.ceil(amount * 0.8)
            this.assertBalance(targetBefore + received)
            source.money -= amount
            destination.money += received
            let sourceWritten = false
            try {
                if ((await this.putNotesData(sender, source)) === false) throw new Error('转出方数据保存失败')
                sourceWritten = true
                if ((await this.putNotesData(target, destination)) === false) throw new Error('转入方数据保存失败')
            } catch (error) {
                source.money = sourceBefore
                destination.money = targetBefore
                if (sourceWritten && (await this.putNotesData(sender, source)) === false) {
                    throw new Error('转账中断且余额回滚失败，请停止转账并联系管理员核对数据')
                }
                throw error
            }
            return { status: 'success', source, destination, sourceBefore, targetBefore, received }
        })
    }

    /**
     * 获取并初始化用户数据
     * @param {string} user_id
     * @returns {Promise<PluginData>} 娱乐数据
     */
    static async getNotesData(user_id) {
        return this.withUsers([user_id], () => {
            const file = this.file(user_id)
            const data = readFile.FileReader(file)
            if ((!data || typeof data !== 'object' || Array.isArray(data)) && fs.existsSync(file))
                throw new Error('用户数据损坏，已停止写入以保护数据')
            if (data && Object.hasOwn(data, 'money')) this.assertBalance(data.money)
            const result = new PluginData(data)
            this.assertBalance(result.money)
            return result
        })
    }

    /**
     * 获取并初始化用户数据
     * @param {string} user_id
     * @param {PluginData} data
     */
    static putNotesData(user_id, data) {
        this.assertBalance(data.money)
        return readFile.SetFile(this.file(user_id), data)
    }

    /**
     * 删除用户数据
     * @param {string} user_id
     */
    static delNotesData(user_id) {
        return this.withUsers([user_id], () => fs.rmSync(this.file(user_id), { force: true }))
    }
}
