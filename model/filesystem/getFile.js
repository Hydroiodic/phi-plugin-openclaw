import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import logger from '../../components/Logger.js'
import atomicFile from './atomicFile.js'

/** Serialization and file IO; account paths are validated by their repositories. */
export default class FileRepository {
    /**
     * @param {string} filePath
     * @param {'JSON'|'YAML'|'CSV'|'TSV'|'TXT'} [style]
     * @returns {any}
     */
    static FileReader(filePath, style) {
        try {
            const text = fs.readFileSync(filePath, 'utf8')
            const format = style || path.extname(filePath).slice(1).toUpperCase()
            if (format === 'JSON') return JSON.parse(text)
            if (format === 'YAML') return YAML.parse(text)
            if (format === 'CSV' || format === 'TSV') {
                // Phigros metadata uses tab-separated columns, including .csv.
                const [header, ...lines] = text.replace(/\r/g, '').split('\n')
                const headers = header.split('\t')
                return lines.filter(Boolean).map(line => {
                    const columns = line.split('\t')
                    return Object.fromEntries(headers.map((key, index) => [key, columns[index]]))
                })
            }
            return text
        } catch (/** @type {any} */ error) {
            if (error.code !== 'ENOENT') logger.warn(`[phi-plugin] 文件读取失败：${filePath}`)
            return false
        }
    }

    /** @param {string} file @param {any} data @param {'JSON'|'YAML'|'TXT'} [style] */
    static SetFile(file, data, style) {
        try {
            const format = style || path.extname(file).slice(1).toUpperCase()
            const content = format === 'JSON' ? JSON.stringify(data) : format === 'YAML' ? YAML.stringify(data) : data
            if (typeof content !== 'string' && !ArrayBuffer.isView(content)) throw new TypeError('Invalid file content')
            atomicFile.write(file, /** @type {string | NodeJS.ArrayBufferView} */ (content))
            return true
        } catch {
            logger.warn(`[phi-plugin] 文件保存失败，请检查磁盘空间和权限：${file}`)
            return false
        }
    }

    /** @param {string} file */
    static async DelFile(file) {
        try {
            await fs.promises.unlink(file)
            return true
        } catch (/** @type {any} */ error) {
            if (error.code !== 'ENOENT') logger.warn(`[phi-plugin] 文件删除失败：${file}`)
            return false
        }
    }
}
