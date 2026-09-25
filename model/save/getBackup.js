import JSZip from 'jszip'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { backupPath, pluginDataPath, savePath } from '../filesystem/path.js'
import fCompute from '../game/fCompute.js'
import send from '../render/send.js'
import logger from '../../components/Logger.js'
import userCredentialStore from '../user/userCredentialStore.js'
import { themesDir } from '../theme/paths.js'
import { withMarketInstallLock } from '../theme/installLock.js'
import { BackupArchive, BackupRestoreService } from './backupRestoreService.js'
import { isSessionToken } from '../../lib/sessionToken.js'

const MaxNum = 1e4
const THEME_DIR_RE = /^[a-zA-Z0-9_-]+$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

class LazyFileReadStream extends Readable {
    /** @param {string} file */
    constructor(file) {
        super()
        this.file = file
        /** @type {fs.ReadStream|null} */
        this.source = null
    }

    _read() {
        if (this.source) {
            this.source.resume()
            return
        }
        const descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
        const source = fs.createReadStream(this.file, { fd: descriptor, autoClose: true })
        this.source = source
        source.on('data', chunk => {
            if (!this.push(chunk)) source.pause()
        })
        source.on('end', () => this.push(null))
        source.on('error', error => this.destroy(error))
    }

    /** @param {Error|null} error @param {(error?:Error|null)=>void} callback */
    _destroy(error, callback) {
        this.source?.destroy()
        callback(error)
    }
}

/** @param {string} directory */
function readDataDirectory(directory) {
    try {
        const stat = fs.lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('备份源必须是普通数据目录')
        return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []
        throw error
    }
}

/** @param {JSZip} zip @param {string} source @param {string} relative */
function addThemeDirectory(zip, source, relative) {
    let files = 0
    for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = path.join(source, entry.name)
        const archivePath = `${relative}/${entry.name}`
        const stat = fs.lstatSync(fullPath)
        if (stat.isSymbolicLink()) {
            logger.warn(`[phi-plugin][backup] 跳过主题中的符号链接：${fullPath}`)
            continue
        }
        if (stat.isDirectory()) {
            zip.folder(archivePath)
            files += addThemeDirectory(zip, fullPath, archivePath)
        } else if (stat.isFile()) {
            zip.file(archivePath, new LazyFileReadStream(fullPath))
            files++
        }
    }
    return files
}

/** @param {JSZip} zip Add installed/local themes, excluding transaction directories. */
export function addThemesToBackup(zip) {
    if (!fs.existsSync(themesDir)) return { themes: 0, files: 0 }
    let themes = 0
    let files = 0
    for (const entry of fs.readdirSync(themesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.phi-market-') || !THEME_DIR_RE.test(entry.name)) continue
        zip.folder(`themes/${entry.name}`)
        files += addThemeDirectory(zip, path.join(themesDir, entry.name), `themes/${entry.name}`)
        themes++
    }
    return { themes, files }
}

/** @param {string} name @param {boolean} directory */
function parseThemeArchivePath(name, directory) {
    if (!name.startsWith('themes/') || name.includes('\u0000')) return null
    if (process.platform === 'win32' && /[\\\u0001-\u001f\u007f]/.test(name)) return null
    const relative = name.slice('themes/'.length)
    const segments = relative.split('/')
    if (directory && segments.at(-1) === '') segments.pop()
    if (
        segments.length < (directory ? 1 : 2) ||
        !THEME_DIR_RE.test(segments[0]) ||
        segments.some(
            segment =>
                !segment ||
                segment === '.' ||
                segment === '..' ||
                (process.platform === 'win32' && (segment.includes(':') || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment))),
        )
    )
        return null
    return segments
}

/** @param {JSZip} zip Restore missing themes atomically; existing themes are preserved. */
async function restoreThemesFromBackupUnlocked(zip) {
    const archive = new BackupArchive(zip)
    const entries = Object.values(zip.files).filter(file => file.name.startsWith('themes/') && file.name !== 'themes/')
    if (!entries.length) return { restored: 0, skipped: 0 }

    /** @type {{file:import('jszip').JSZipObject,segments:string[],directory:boolean}[]} */
    const parsed = []
    for (const file of entries) {
        const originalName = /** @type {any} */ (file).unsafeOriginalName ?? file.name
        const segments = parseThemeArchivePath(originalName, file.dir)
        if (!segments) throw new Error(`备份中的主题路径不安全：${originalName}`)
        parsed.push({ file, segments, directory: file.dir })
    }

    fs.mkdirSync(themesDir, { recursive: true, mode: 0o700 })
    const stage = await fs.promises.mkdtemp(path.join(themesDir, '.phi-market-restore-'))
    const themeNames = new Set(parsed.map(item => item.segments[0]))
    let restored = 0
    let skipped = 0
    try {
        for (const item of parsed) {
            const output = path.join(stage, ...item.segments)
            const relative = path.relative(stage, output)
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                throw new Error(`备份中的主题路径越界：${item.file.name}`)
            }
            if (item.directory) {
                await fs.promises.mkdir(output, { recursive: true, mode: 0o700 })
            } else {
                await fs.promises.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
                await fs.promises.writeFile(output, await archive.read(item.file), { mode: 0o600, flag: 'wx' })
            }
        }
        for (const themeName of [...themeNames].sort()) {
            const source = path.join(stage, themeName)
            const target = path.join(themesDir, themeName)
            const exists = await fs.promises.lstat(target).then(
                () => true,
                () => false,
            )
            if (exists) {
                skipped++
                continue
            }
            await fs.promises.rename(source, target)
            restored++
        }
    } finally {
        await fs.promises.rm(stage, { recursive: true, force: true })
    }
    return { restored, skipped }
}

/** @param {JSZip} zip Restore themes under the same lock used by market installs. */
export function restoreThemesFromBackup(zip) {
    return withMarketInstallLock(() => restoreThemesFromBackupUnlocked(zip))
}

/**@import {botEvent} from "../../components/baseClass.js" */
export default class getBackup {
    /**
     * 备份
     * @param {botEvent} e
     * @param {{saveRoot?:string,pluginDataRoot?:string,outputRoot?:string,includeThemes?:boolean}} [options]
     */
    static async backup(e, { saveRoot = savePath, pluginDataRoot = pluginDataPath, outputRoot = backupPath, includeThemes = true } = {}) {
        const zip = new JSZip()
        for (const source of [
            { root: saveRoot, archive: 'saveData', nested: true },
            { root: pluginDataRoot, archive: 'pluginData', nested: false },
        ]) {
            const entries = readDataDirectory(source.root)
            if (entries.length >= MaxNum) throw new Error('数据数量过多，请手动备份数据目录')
            await send.send_with_At(e, `开始备份 ${source.archive}，请稍等...`)
            for (const entry of entries) {
                if (entry.isSymbolicLink()) {
                    logger.warn('[phi-plugin][backup] 已跳过数据目录中的符号链接')
                    continue
                }
                const location = path.join(source.root, entry.name)
                if (source.nested) {
                    if (!entry.isDirectory() || !isSessionToken(entry.name)) continue
                    for (const file of readDataDirectory(location)) {
                        if (!file.isFile() || !['save.json', 'history.json'].includes(file.name)) continue
                        zip.file(`${source.archive}/${entry.name}/${file.name}`, new LazyFileReadStream(path.join(location, file.name)))
                    }
                } else if (entry.isFile() && entry.name.endsWith('.json')) {
                    zip.file(`${source.archive}/${entry.name}`, new LazyFileReadStream(location))
                }
            }
        }
        const credentials = await userCredentialStore.listSessionCredentials()
        zip.file('user_token.json', JSON.stringify(Object.fromEntries(credentials)))
        await fs.promises.mkdir(outputRoot, { recursive: true, mode: 0o700 })
        const outputStat = await fs.promises.lstat(outputRoot)
        if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) throw new Error('备份输出必须是普通目录')
        const zipName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.zip`
        const outputPath = path.join(outputRoot, zipName)
        const temporary = path.join(outputRoot, `.phi-backup-${randomUUID()}.tmp`)
        try {
            await withMarketInstallLock(async () => {
                if (includeThemes) {
                    const themes = addThemesToBackup(zip)
                    if (themes.themes) await send.send_with_At(e, `已加入 ${themes.themes} 个主题到备份`)
                }
                await send.send_with_At(e, '开始压缩备份数据，请稍等...')
                await pipeline(
                    zip.generateNodeStream({ streamFiles: true }),
                    fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true }),
                )
                await fs.promises.rename(temporary, outputPath)
            })
        } finally {
            await fs.promises.rm(temporary, { force: true })
        }
        await send.send_with_At(e, `${zipName} 已成功保存到备份目录。`)
        if (e.msg.replace(/^[#/].*backup/, '').includes('back')) await fCompute.sendFile(e, outputPath, zipName)
        return { zipName, zip }
    }

    /**
     * 从zip中恢复
     * @param {string} zipPath
     */
    static async restore(zipPath) {
        const stat = await fs.promises.lstat(zipPath)
        if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error('备份必须是小于 512 MiB 的普通 ZIP 文件')
        const zip = await JSZip.loadAsync(await fs.promises.readFile(zipPath))
        const archive = new BackupArchive(zip)
        const service = new BackupRestoreService({
            saveRoot: savePath,
            pluginDataRoot: pluginDataPath,
            credentialStore: userCredentialStore,
        })
        const plan = await service.prepare(archive)
        const themeRestore = await restoreThemesFromBackup(zip)
        if (themeRestore.restored || themeRestore.skipped) {
            logger.info(`[phi-plugin][backup] 主题恢复完成：恢复 ${themeRestore.restored} 个，保留现有 ${themeRestore.skipped} 个`)
        }
        return { ...(await service.apply(plan)), themes: themeRestore }
    }
}
