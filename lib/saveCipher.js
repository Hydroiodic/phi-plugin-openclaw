import { createCipheriv, createDecipheriv } from 'node:crypto'

/** Phigros 云存档条目使用的 AES-256-CBC 密钥与 IV，随游戏客户端公开发布。 */
export const SAVE_KEY = Buffer.from('6Jaa0qVAJZuXkZCLiOa/Ax5tIZVu+taKUN1V1nqwkks=', 'base64')
export const SAVE_IV = Buffer.from('Kk/wisgNYwcAV8WVGMgyUw==', 'base64')

/**
 * 加密存档条目的明文（PKCS#7 填充）。
 * @param {Uint8Array} plain
 * @returns {Buffer}
 */
export function encryptSaveBytes(plain) {
    const cipher = createCipheriv('aes-256-cbc', SAVE_KEY, SAVE_IV)
    return Buffer.concat([cipher.update(plain), cipher.final()])
}

/**
 * 解密存档条目的密文；填充无效时抛出异常。
 * @param {Uint8Array} encrypted
 * @returns {Buffer}
 */
export function decryptSaveBytes(encrypted) {
    const decipher = createDecipheriv('aes-256-cbc', SAVE_KEY, SAVE_IV)
    return Buffer.concat([decipher.update(encrypted), decipher.final()])
}
