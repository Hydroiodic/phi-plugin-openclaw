import { createHash } from 'node:crypto'

/** @param {...unknown} parts */
export const identity = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/**
 * 插件内的用户 ID：按 channel、机器人账号和发送者隔离，不同入口算出的值必须一致。
 * @param {string} channel @param {string} account @param {string} sender
 */
export const userIdentity = (channel, account, sender) => identity(channel, account || 'default', sender)
