import fs from 'node:fs/promises'
import path from 'node:path'
import { randomInt } from 'node:crypto'
import cloudTransport from '../../lib/cloudTransport.js'
import cloudSaveArchive, { CLOUD_SAVE_LIMITS } from '../../lib/cloudSaveArchive.js'
import SaveManager from '../../lib/SaveManager.js'
import GameRecord from '../../lib/GameRecord.js'
import { decryptSaveBytes, encryptSaveBytes } from '../../lib/saveCipher.js'
import { CloudSaveUploader, md5 } from '../../lib/saveUploader.js'
import {
    LEVEL_NAMES, SaveFormatError, decodeEntry, decodeGameRecord, decodeSummary, encodeEntry, encodeGameRecord, encodeSummary,
} from '../../lib/saveCodec.js'
import { assertSessionToken } from '../../lib/sessionToken.js'
import Util from '../../lib/Util.js'
import getInfo from '../game/getInfo.js'
import { backupPath } from '../filesystem/path.js'

/** @import {DecodedEntry, SongRecord, LevelScore} from '../../lib/saveCodec.js' */
/** @import {ArchiveEntry} from '../../lib/cloudSaveArchive.js' */

const ENTRY_NAMES = /** @type {const} */ (['gameProgress', 'user', 'settings'])
const REQUIRED = [...ENTRY_NAMES, 'gameRecord']
const WORKING_COPY_TTL = 30 * 60 * 1000
const PENDING_TTL = 10 * 60 * 1000
const MAX_WORKING_COPIES = 64
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_SCORE = 1_000_000

/** 面向用户的可预期错误，消息可以直接展示。 */
export class SaveEditError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.name = 'SaveEditError'
    }
}

/**
 * @typedef {object} SaveCatalog 曲目信息查询，默认使用插件的曲库
 * @property {(query: string) => string[]} findSongs 按曲名、别名或 ID 查找曲目 ID
 * @property {(id: string) => string | undefined} songName
 * @property {(id: string) => string | undefined} backgroundName 存档里记录该曲目背景时使用的名称
 * @property {(id: string, level: string) => number | undefined} difficulty 谱面定数；没有该谱面时返回 undefined
 * @property {(name: string) => boolean} isAvatar
 */

/**
 * @typedef {object} WorkingCopy
 * @property {string} userId
 * @property {number} expiresAt
 * @property {boolean} isGlobal
 * @property {{saveId: string, userObjectId: string, fileId: string, modifiedAt: string, summary: string, nickname: string}} cloud
 * @property {Buffer} zip 读取到的原始压缩包
 * @property {ArchiveEntry[]} entries
 * @property {Record<string, number>} versions 各条目的格式版本字节
 * @property {Decoded} baseline 读取时的内容，用于列出改动
 * @property {Decoded} current 当前修改后的内容
 * @property {string | null} readOnlyReason 无法无损写回时的原因
 */

/**
 * @typedef {object} Decoded
 * @property {{songs: SongRecord[]}} gameRecord
 * @property {DecodedEntry} gameProgress
 * @property {DecodedEntry} user
 * @property {DecodedEntry} settings
 * @property {DecodedEntry} summary
 */

/**
 * @typedef {object} PendingUpload
 * @property {string} code
 * @property {number} expiresAt
 * @property {Buffer} zip
 * @property {string} summary
 * @property {string[]} changes
 * @property {WorkingCopy} copy
 */

/** 可修改的设置项及其取值检查 */
const SETTINGS_RULES = {
    chordSupport: 'boolean', fcAPIndicator: 'boolean', enableHitSound: 'boolean', lowResolutionMode: 'boolean',
    deviceName: { maxLength: 64 },
    bright: [0, 1], musicVolume: [0, 1], effectVolume: [0, 1], hitSoundVolume: [0, 1], soundOffset: [-1, 1], noteScale: [0.5, 2],
}

const SETTING_LABELS = {
    chordSupport: '多押提示', fcAPIndicator: 'FC/AP 指示器', enableHitSound: '打击音效', lowResolutionMode: '低分辨率模式',
    deviceName: '设备名', bright: '背景亮度', musicVolume: '音乐音量', effectVolume: '界面音效音量', hitSoundVolume: '打击音效音量',
    soundOffset: '谱面延迟（秒）', noteScale: '按键缩放',
}

const MONEY_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB']

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/** @param {number[]} money */
const formatMoney = money => money.map((value, index) => value ? `${value}${MONEY_UNITS[index]}` : '').filter(Boolean).reverse().join(' ') || '0KB'

/** @param {LevelScore | null | undefined} record */
const formatScore = record => record ? `${record.score} / ${record.acc.toFixed(2)}%${record.score === MAX_SCORE ? ' φ' : record.fc ? ' FC' : ''}` : '无成绩'

/** @param {number} rank */
const formatChallenge = rank => rank ? `${['', '绿', '蓝', '红', '金', '彩'][Math.floor(rank / 100)] || '?'}${rank % 100}` : '无'

/** @param {any} value */
function clone(value) {
    return structuredClone(value)
}

/**
 * 读取、修改并在用户确认后上传用户自己的云存档。
 * 所有方法只接受平台身份哈希（userId），调用方负责保证它来自可信的发送者身份。
 */
export class SaveEditService {
    /**
     * @param {object} [dependencies]
     * @param {(userId: string) => Promise<{sessionToken: string, isGlobal: boolean} | null>} [dependencies.credentials]
     * @param {() => SaveCatalog} [dependencies.catalog]
     * @param {(isGlobal: boolean) => {latestSave(session: string): Promise<{save: any, playerInfo: any}>}} [dependencies.saveManager]
     * @param {(isGlobal: boolean) => CloudSaveUploader} [dependencies.uploader]
     * @param {import('../../lib/cloudTransport.js').CloudTransport} [dependencies.transport]
     * @param {() => string} [dependencies.backupRoot]
     * @param {() => number} [dependencies.now]
     */
    constructor({
        credentials = defaultCredentials, catalog = defaultCatalog, saveManager = isGlobal => new SaveManager(isGlobal),
        uploader = isGlobal => new CloudSaveUploader({ isGlobal }), transport = cloudTransport,
        backupRoot = defaultBackupRoot, now = Date.now,
    } = {}) {
        this.credentials = credentials
        this.catalog = catalog
        this.saveManager = saveManager
        this.uploader = uploader
        this.transport = transport
        this.backupRoot = backupRoot
        this.now = now
        /** @type {Map<string, WorkingCopy>} */
        this.copies = new Map()
        /** @type {Map<string, PendingUpload>} */
        this.pending = new Map()
        /** @type {Map<string, Promise<unknown>>} */
        this.locks = new Map()
    }

    /**
     * 同一用户的操作串行执行，避免读取、修改和上传交错。
     * @template T
     * @param {string} userId
     * @param {() => Promise<T>} work
     * @returns {Promise<T>}
     */
    exclusive(userId, work) {
        const previous = this.locks.get(userId) || Promise.resolve()
        const next = previous.catch(() => {}).then(work)
        const settled = next.catch(() => {})
        this.locks.set(userId, settled)
        settled.then(() => { if (this.locks.get(userId) === settled) this.locks.delete(userId) })
        return next
    }

    /** @param {string} userId */
    async session(userId) {
        const credentials = await this.credentials(userId)
        if (!credentials?.sessionToken) throw new SaveEditError('你还没有绑定 Phigros 账号，请先私聊发送 /bind qrcode 扫码绑定。')
        assertSessionToken(credentials.sessionToken)
        return credentials
    }

    /** @param {string} userId */
    fetch(userId) {
        return this.exclusive(userId, async () => {
            const { sessionToken, isGlobal } = await this.session(userId)
            const { save, playerInfo } = await this.saveManager(isGlobal).latestSave(sessionToken)
            if (typeof save.objectId !== 'string' || typeof save.gameFile?.objectId !== 'string' || typeof save.summary !== 'string') {
                throw new SaveEditError('云端存档记录格式无效，请在游戏内重新同步存档后再试。')
            }
            const { bytes } = await this.transport.request(save.gameFile.url, { method: 'GET' }, { maxBytes: CLOUD_SAVE_LIMITS.maxArchiveBytes })
            const opened = await openArchive(bytes, save.summary)
            this.pending.delete(userId)
            this.remember({
                userId, isGlobal, expiresAt: this.now() + WORKING_COPY_TTL, zip: bytes, ...opened,
                cloud: {
                    saveId: save.objectId, userObjectId: playerInfo.objectId, fileId: save.gameFile.objectId,
                    modifiedAt: new Date(save.modifiedAt.iso).toISOString(), summary: save.summary, nickname: String(playerInfo.nickname ?? ''),
                },
                current: clone(opened.baseline),
            })
            return this.overview(this.copy(userId))
        })
    }

    /** @param {WorkingCopy} copy */
    remember(copy) {
        this.copies.delete(copy.userId)
        this.copies.set(copy.userId, copy)
        for (const [userId, item] of this.copies) {
            if (this.copies.size <= MAX_WORKING_COPIES && item.expiresAt > this.now()) continue
            this.copies.delete(userId)
            this.pending.delete(userId)
        }
    }

    /** @param {string} userId */
    copy(userId) {
        const copy = this.copies.get(userId)
        if (!copy || copy.expiresAt <= this.now()) {
            this.copies.delete(userId)
            throw new SaveEditError('还没有读取存档或读取已过期，请先读取云存档。')
        }
        copy.expiresAt = this.now() + WORKING_COPY_TTL
        return copy
    }

    /** @param {WorkingCopy} copy */
    overview(copy) {
        const { current, cloud } = copy
        const progress = current.gameProgress.values, user = current.user.values
        const summary = copy.readOnlyReason ? current.summary.values : decodeSummary(this.buildSummary(copy)).values
        const played = current.gameRecord.songs.reduce((sum, song) => sum + song.levels.filter(Boolean).length, 0)
        const changes = this.changes(copy)
        return [
            `玩家：${cloud.nickname || '未知'}（${copy.isGlobal ? '国际服' : '国服'}）`,
            `存档时间：${cloud.modifiedAt}`,
            `RKS：${Number(summary.rankingScore).toFixed(4)}，课题模式：${formatChallenge(progress.challengeModeRank)}`,
            `Data：${formatMoney(progress.money)}`,
            `头像：${user.avatar}，背景：${user.background}`,
            `简介：${user.selfIntro || '（空）'}`,
            `成绩：${current.gameRecord.songs.length} 首曲目，${played} 个谱面有成绩`,
            ...['EZ', 'HD', 'IN', 'AT'].map((level, index) =>
                `${level}：Clear ${summary.cleared[index]}，FC ${summary.fullCombo[index]}，φ ${summary.phi[index]}`),
            copy.readOnlyReason ? `注意：${copy.readOnlyReason}` : changes.length ? `未上传的修改：${changes.length} 项` : '没有未上传的修改',
        ].join('\n')
    }

    /**
     * @param {string} userId
     * @param {{section?: string, song?: string, level?: string, offset?: number, limit?: number}} [query]
     */
    async read(userId, { section = 'overview', song, level, offset = 0, limit = 20 } = {}) {
        return this.exclusive(userId, async () => {
            const copy = this.copy(userId)
            const { current } = copy
            switch (section) {
                case 'overview': return this.overview(copy)
                case 'profile': {
                    const user = current.user.values
                    return [`简介：${user.selfIntro || '（空）'}`, `头像：${user.avatar}`, `背景：${user.background}`, `显示玩家 ID：${user.showPlayerId ? '是' : '否'}`].join('\n')
                }
                case 'settings':
                    return Object.entries(SETTING_LABELS).map(([key, label]) => `${label}（${key}）：${formatValue(current.settings.values[key])}`).join('\n')
                case 'progress': {
                    const progress = current.gameProgress.values
                    return [
                        `Data：${formatMoney(progress.money)}（money：${JSON.stringify(progress.money)}，依次为 KB MB GB TB PB）`,
                        `课题模式：${formatChallenge(progress.challengeModeRank)}（challengeModeRank：${progress.challengeModeRank}）`,
                        ...Object.entries(progress).filter(([key]) => !['money', 'challengeModeRank'].includes(key))
                            .map(([key, value]) => `${key}：${formatValue(value)}`),
                    ].join('\n')
                }
                case 'records': return this.listRecords(copy, { song, level, offset, limit })
                case 'changes': {
                    const changes = this.changes(copy)
                    return changes.length ? changes.join('\n') : '没有未上传的修改。'
                }
                default: throw new SaveEditError(`未知的存档分区：${section}`)
            }
        })
    }

    /**
     * @param {WorkingCopy} copy
     * @param {{song?: string, level?: string, offset: number, limit: number}} query
     */
    listRecords(copy, { song, level, offset, limit }) {
        const catalog = this.catalog()
        const ids = song ? new Set(this.findSongIds(copy, song)) : null
        const levelIndex = level ? levelOf(level) : -1
        /** @type {{text: string, rks: number}[]} */
        const rows = []
        for (const item of copy.current.gameRecord.songs) {
            if (ids && !ids.has(item.id)) continue
            item.levels.forEach((record, index) => {
                if (!record || levelIndex >= 0 && index !== levelIndex) return
                const difficulty = catalog.difficulty(item.id, LEVEL_NAMES[index])
                rows.push({ text: `${catalog.songName(item.id) || item.id} [${item.id}] ${LEVEL_NAMES[index]}${difficulty ? ` ${difficulty}` : ''}：${formatScore(record)}`, rks: difficulty ? rksOf(record, difficulty) : 0 })
            })
        }
        if (!rows.length) return song ? `没有找到「${song}」的成绩。` : '存档里没有成绩。'
        rows.sort((a, b) => b.rks - a.rks)
        const start = Math.max(0, Math.floor(offset)), size = Math.min(Math.max(1, Math.floor(limit)), 50)
        return [`共 ${rows.length} 条成绩，按单曲 RKS 排序，显示第 ${start + 1}~${Math.min(start + size, rows.length)} 条：`,
            ...rows.slice(start, start + size).map(row => row.text)].join('\n')
    }

    /**
     * 按 ID 精确匹配，或按曲名/别名在曲库中查找。
     * @param {WorkingCopy} copy
     * @param {string} query
     */
    findSongIds(copy, query) {
        const text = String(query).trim()
        if (copy.current.gameRecord.songs.some(song => song.id === text)) return [text]
        return this.catalog().findSongs(text)
    }

    /**
     * @param {string} userId
     * @param {any} patch
     */
    edit(userId, patch) {
        return this.exclusive(userId, async () => {
            const copy = this.copy(userId)
            if (copy.readOnlyReason) throw new SaveEditError(copy.readOnlyReason)
            if (!isRecord(patch)) throw new SaveEditError('修改内容格式无效。')
            // 先在副本上应用，全部通过检查后才替换，避免一半生效
            const next = clone(copy.current)
            if (patch.profile !== undefined) this.editProfile(next, patch.profile)
            if (patch.settings !== undefined) editSettings(next, patch.settings)
            if (patch.progress !== undefined) editProgress(next, patch.progress)
            if (patch.records !== undefined) this.editRecords(copy, next, patch.records)
            copy.current = next
            this.pending.delete(userId)
            const changes = this.changes(copy)
            return changes.length ? `当前共有 ${changes.length} 项未上传的修改：\n${changes.join('\n')}` : '修改后与云端存档相同，没有需要上传的内容。'
        })
    }

    /** @param {Decoded} next @param {unknown} profile */
    editProfile(next, profile) {
        if (!isRecord(profile)) throw new SaveEditError('profile 必须是对象。')
        const values = next.user.values
        for (const [key, value] of Object.entries(profile)) {
            switch (key) {
                case 'selfIntro':
                    if (typeof value !== 'string' || [...value].length > 500) throw new SaveEditError('简介必须是不超过 500 字的文本。')
                    values.selfIntro = value
                    break
                case 'avatar':
                    if (typeof value !== 'string' || !this.catalog().isAvatar(value)) throw new SaveEditError(`头像「${value}」不存在，请使用游戏内已有的头像名称。`)
                    values.avatar = value
                    break
                case 'background': {
                    if (typeof value !== 'string') throw new SaveEditError('背景必须是曲名。')
                    const ids = this.catalog().findSongs(value)
                    const name = ids.length === 1 ? this.catalog().backgroundName(ids[0]) : undefined
                    if (!name) throw new SaveEditError(ids.length ? `「${value}」匹配到多首曲目，请写完整曲名。` : `没有找到曲目「${value}」，无法设为背景。`)
                    values.background = name
                    break
                }
                case 'showPlayerId':
                    if (typeof value !== 'boolean') throw new SaveEditError('showPlayerId 必须是 true 或 false。')
                    values.showPlayerId = value
                    break
                default: throw new SaveEditError(`不支持修改个人资料字段 ${key}。`)
            }
        }
    }

    /**
     * @param {WorkingCopy} copy
     * @param {Decoded} next
     * @param {unknown} records
     */
    editRecords(copy, next, records) {
        if (!Array.isArray(records) || records.length > 100) throw new SaveEditError('records 必须是不超过 100 项的数组。')
        const catalog = this.catalog()
        for (const change of records) {
            if (!isRecord(change) || typeof change.song !== 'string' || typeof change.level !== 'string') {
                throw new SaveEditError('每条成绩修改都需要 song 和 level。')
            }
            const level = levelOf(change.level)
            const ids = this.findSongIds(copy, change.song)
            if (ids.length !== 1) {
                throw new SaveEditError(ids.length
                    ? `「${change.song}」匹配到多首曲目：${ids.slice(0, 5).map(id => `${catalog.songName(id) || id} [${id}]`).join('、')}，请用曲目 ID 指定。`
                    : `没有找到曲目「${change.song}」。`)
            }
            const id = ids[0]
            let song = next.gameRecord.songs.find(item => item.id === id)
            if (change.remove === true) {
                if (!song?.levels[level]) throw new SaveEditError(`${id} ${LEVEL_NAMES[level]} 本来就没有成绩。`)
                song.levels[level] = null
                song.fcFlags = Util.modifyBit(song.fcFlags, level, false)
                if (song.levels.every(item => !item)) next.gameRecord.songs.splice(next.gameRecord.songs.indexOf(song), 1)
                continue
            }
            if (catalog.difficulty(id, LEVEL_NAMES[level]) === undefined) throw new SaveEditError(`${id} 没有 ${LEVEL_NAMES[level]} 难度的谱面。`)
            const old = song?.levels[level]
            const record = {
                score: change.score ?? old?.score, acc: change.acc ?? old?.acc,
                fc: change.fc ?? (change.score !== undefined || change.acc !== undefined ? undefined : old?.fc),
            }
            if (!Number.isInteger(record.score) || record.score < 0 || record.score > MAX_SCORE) throw new SaveEditError('分数必须是 0~1000000 的整数。')
            if (typeof record.acc !== 'number' || !Number.isFinite(record.acc) || record.acc < 0 || record.acc > 100) throw new SaveEditError('acc 必须是 0~100 的数字。')
            record.fc = record.score === MAX_SCORE || Boolean(record.fc ?? Math.abs(record.score - 9000 * record.acc - 100000) <= 2)
            assertPlausible(record, `${id} ${LEVEL_NAMES[level]}`)
            if (!song) {
                song = { id, levels: [null, null, null, null, null], fcFlags: 0 }
                next.gameRecord.songs.push(song)
            }
            song.levels[level] = { score: record.score, acc: Math.fround(record.acc), fc: record.fc }
            song.fcFlags = Util.modifyBit(song.fcFlags, level, record.fc)
        }
    }

    /** @param {WorkingCopy} copy */
    changes(copy) {
        const { baseline, current } = copy
        const catalog = this.catalog()
        const lines = []
        for (const [section, label] of /** @type {const} */ ([['user', '个人资料'], ['settings', '设置'], ['gameProgress', '进度']])) {
            for (const [key, value] of Object.entries(current[section].values)) {
                const before = baseline[section].values[key]
                if (JSON.stringify(before) === JSON.stringify(value)) continue
                const name = section === 'settings' ? /** @type {Record<string, string>} */ (SETTING_LABELS)[key] || key : key
                const show = key === 'money' ? formatMoney : key === 'challengeModeRank' ? formatChallenge : formatValue
                lines.push(`${label} ${name}：${show(before)} → ${show(value)}`)
            }
        }
        const before = new Map(baseline.gameRecord.songs.map(song => [song.id, song]))
        const after = new Map(current.gameRecord.songs.map(song => [song.id, song]))
        for (const id of new Set([...before.keys(), ...after.keys()])) {
            for (let level = 0; level < LEVEL_NAMES.length; level++) {
                const old = before.get(id)?.levels[level] ?? null, now = after.get(id)?.levels[level] ?? null
                if (JSON.stringify(old) === JSON.stringify(now)) continue
                lines.push(`成绩 ${catalog.songName(id) || id} ${LEVEL_NAMES[level]}：${formatScore(old)} → ${formatScore(now)}`)
            }
        }
        return lines
    }

    /**
     * 生成新的存档并等待用户亲自确认。返回的文本含确认码，应直接发给用户。
     * @param {string} userId
     */
    stage(userId) {
        return this.exclusive(userId, async () => {
            const copy = this.copy(userId)
            if (copy.readOnlyReason) throw new SaveEditError(copy.readOnlyReason)
            const changes = this.changes(copy)
            if (!changes.length) throw new SaveEditError('没有未上传的修改。')
            const summary = this.buildSummary(copy)
            const zip = await buildArchive(copy, copy.current)
            // 用读取时的同一套流程重新打开，确认生成的存档能被正确解析
            const reopened = await openArchive(zip, summary)
            if (reopened.readOnlyReason || !sameContent(reopened.baseline, { ...copy.current, summary: decodeSummary(summary) })) {
                throw new SaveEditError('生成的存档校验失败，已停止上传。')
            }
            const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
            const expiresAt = this.now() + PENDING_TTL
            this.pending.set(userId, { code, expiresAt, zip, summary, changes, copy })
            return { code, expiresAt, changes }
        })
    }

    /**
     * 用户亲自发送确认命令后上传。
     * @param {string} userId
     * @param {string} code
     */
    confirm(userId, code) {
        return this.exclusive(userId, async () => {
            const pending = this.pending.get(userId)
            if (!pending || pending.expiresAt <= this.now()) {
                this.pending.delete(userId)
                throw new SaveEditError('没有待确认的存档上传，或确认已过期。请让助手重新准备上传。')
            }
            if (String(code || '').trim().toUpperCase() !== pending.code) throw new SaveEditError('确认码不正确。')
            this.pending.delete(userId)
            const { copy } = pending
            const { sessionToken, isGlobal } = await this.session(userId)
            if (isGlobal !== copy.isGlobal) throw new SaveEditError('绑定的账号已变化，请重新读取存档。')
            // 读取之后云端若有新存档（例如在游戏内同步过），直接覆盖会丢数据
            const manager = this.saveManager(isGlobal)
            const { save, playerInfo } = await manager.latestSave(sessionToken)
            if (save.objectId !== copy.cloud.saveId || save.gameFile?.objectId !== copy.cloud.fileId || playerInfo.objectId !== copy.cloud.userObjectId) {
                this.copies.delete(userId)
                throw new SaveEditError('云端存档在读取之后发生了变化，为避免覆盖新进度，已取消上传。请重新读取后再修改。')
            }
            const backup = await this.backup(copy)
            const uploader = this.uploader(isGlobal)
            const target = { userId: copy.cloud.userObjectId, saveId: copy.cloud.saveId }
            const uploaded = await uploader.upload({ session: sessionToken, ...target, zip: pending.zip, summary: pending.summary })
            try {
                const { save: latest } = await manager.latestSave(sessionToken)
                if (latest.gameFile?.objectId !== uploaded.fileId) throw new Error()
                const { bytes } = await this.transport.request(latest.gameFile.url, { method: 'GET' }, { maxBytes: CLOUD_SAVE_LIMITS.maxArchiveBytes })
                if (md5(bytes) !== md5(pending.zip)) throw new Error()
            } catch {
                await uploader.pointSaveAt(sessionToken, { ...target, fileId: copy.cloud.fileId, summary: copy.cloud.summary, modifiedAt: copy.cloud.modifiedAt })
                    .catch(() => { throw new SaveEditError(`上传后校验失败，自动回滚也失败了。原存档已备份到插件数据目录（${path.basename(backup)}），请联系机器人管理员恢复。`) })
                throw new SaveEditError('上传后校验失败，已把云端存档恢复为修改前的版本。')
            }
            this.copies.delete(userId)
            return { changes: pending.changes }
        })
    }

    /** @param {string} userId */
    cancel(userId) {
        return this.exclusive(userId, async () => this.pending.delete(userId))
    }

    /** @param {WorkingCopy} copy */
    async backup(copy) {
        const directory = path.join(this.backupRoot(), copy.userId)
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        const file = path.join(directory, `${copy.cloud.modifiedAt.replace(/[:.]/g, '-')}-${copy.cloud.fileId.replace(/[^A-Za-z0-9]/g, '')}.zip`)
        await fs.writeFile(file, copy.zip, { mode: 0o600 })
        await fs.writeFile(`${file}.json`, `${JSON.stringify({ ...copy.cloud, isGlobal: copy.isGlobal }, null, 2)}\n`, { mode: 0o600 })
        return file
    }

    /**
     * 与云端 summary 保持一致：头像和课题分直接取存档内容；
     * 成绩有改动时重新计算 RKS，并按改动增减各难度的 Clear/FC/φ 数量。
     * @param {WorkingCopy} copy
     */
    buildSummary(copy) {
        const summary = clone(copy.current.summary)
        const values = summary.values
        values.avatar = copy.current.user.values.avatar
        values.challengeModeRank = copy.current.gameProgress.values.challengeModeRank
        const before = new Map(copy.baseline.gameRecord.songs.map(song => [song.id, song]))
        const after = new Map(copy.current.gameRecord.songs.map(song => [song.id, song]))
        let recordsChanged = false
        for (const id of new Set([...before.keys(), ...after.keys()])) {
            for (let level = 0; level < 4; level++) {
                const old = before.get(id)?.levels[level], now = after.get(id)?.levels[level]
                if (JSON.stringify(old ?? null) === JSON.stringify(now ?? null)) continue
                recordsChanged = true
                for (const [record, sign] of /** @type {const} */ ([[old, -1], [now, 1]])) {
                    if (!record) continue
                    values.cleared[level] = Math.max(0, values.cleared[level] + sign * Number(record.score >= 700000))
                    values.fullCombo[level] = Math.max(0, values.fullCombo[level] + sign * Number(record.fc || record.score === MAX_SCORE))
                    values.phi[level] = Math.max(0, values.phi[level] + sign * Number(record.score === MAX_SCORE))
                }
            }
        }
        if (!recordsChanged && JSON.stringify(copy.current.gameRecord) !== JSON.stringify(copy.baseline.gameRecord)) recordsChanged = true
        if (recordsChanged) values.rankingScore = Math.fround(this.rankingScore(copy.current.gameRecord.songs))
        return encodeSummary(summary)
    }

    /** B27 + φ3 的平均值，LEGACY 谱面不计入 @param {SongRecord[]} songs */
    rankingScore(songs) {
        const catalog = this.catalog()
        const all = [], phi = []
        for (const song of songs) {
            for (let level = 0; level < 4; level++) {
                const record = song.levels[level]
                const difficulty = record && catalog.difficulty(song.id, LEVEL_NAMES[level])
                if (!record || !difficulty) continue
                const rks = rksOf(record, difficulty)
                all.push(rks)
                if (record.score === MAX_SCORE) phi.push(rks)
            }
        }
        const top = (/** @type {number[]} */ list, /** @type {number} */ count) => list.sort((a, b) => b - a).slice(0, count).reduce((sum, value) => sum + value, 0)
        return (top(all, 27) + top(phi, 3)) / 30
    }
}

/** @param {LevelScore} record @param {number} difficulty */
function rksOf(record, difficulty) {
    if (record.acc >= 100) return difficulty
    if (record.acc < 70) return 0
    return difficulty * ((record.acc - 55) / 45) ** 2
}

/** @param {string} level */
function levelOf(level) {
    const name = String(level).trim().toUpperCase()
    const index = LEVEL_NAMES.indexOf(/** @type {any} */ (name === 'LGC' ? 'LEGACY' : name))
    if (index < 0) throw new SaveEditError(`难度必须是 ${LEVEL_NAMES.join('/')} 之一。`)
    return index
}

/**
 * Phigros 分数 = 90 万 × 准度 + 10 万 × 最大连击占比，据此检查分数与 acc 是否可能同时出现。
 * @param {{score: number, acc: number, fc: boolean}} record
 * @param {string} label
 */
function assertPlausible(record, label) {
    if ((record.score === MAX_SCORE) !== (record.acc === 100)) throw new SaveEditError(`${label}：只有 acc 为 100% 时分数才能是 1000000。`)
    const accuracyPart = 9000 * record.acc
    if (record.score < accuracyPart - 2 || record.score > accuracyPart + 100000 + 2) {
        throw new SaveEditError(`${label}：分数 ${record.score} 与 acc ${record.acc}% 不可能同时出现。`)
    }
    if (record.fc && Math.abs(record.score - accuracyPart - 100000) > 2) {
        throw new SaveEditError(`${label}：Full Combo 时分数应约为 ${Math.round(accuracyPart + 100000)}。`)
    }
}

/** @param {Decoded} next @param {unknown} settings */
function editSettings(next, settings) {
    if (!isRecord(settings)) throw new SaveEditError('settings 必须是对象。')
    for (const [key, value] of Object.entries(settings)) {
        const rule = /** @type {Record<string, any>} */ (SETTINGS_RULES)[key]
        if (!rule) throw new SaveEditError(`不支持修改设置项 ${key}。`)
        if (rule === 'boolean' && typeof value !== 'boolean') throw new SaveEditError(`${key} 必须是 true 或 false。`)
        if (Array.isArray(rule) && (typeof value !== 'number' || !Number.isFinite(value) || value < rule[0] || value > rule[1])) {
            throw new SaveEditError(`${key} 必须是 ${rule[0]}~${rule[1]} 之间的数字。`)
        }
        if (rule.maxLength && (typeof value !== 'string' || [...value].length > rule.maxLength)) throw new SaveEditError(`${key} 必须是不超过 ${rule.maxLength} 字的文本。`)
        next.settings.values[key] = typeof value === 'number' ? Math.fround(value) : value
    }
}

/** @param {Decoded} next @param {unknown} progress */
function editProgress(next, progress) {
    if (!isRecord(progress)) throw new SaveEditError('progress 必须是对象。')
    for (const [key, value] of Object.entries(progress)) {
        if (key === 'money') {
            if (!Array.isArray(value) || value.length !== 5 || value.some((amount, index) => !Number.isInteger(amount) || amount < 0 || amount > (index < 4 ? 1023 : 0x3fff))) {
                throw new SaveEditError('money 必须是 5 个整数 [KB, MB, GB, TB, PB]，前四项为 0~1023。')
            }
            next.gameProgress.values.money = [...value]
        } else if (key === 'challengeModeRank') {
            const color = Math.floor(Number(value) / 100), level = Number(value) % 100
            if (!Number.isInteger(value) || value !== 0 && (color < 1 || color > 5 || level < 1 || level > 51)) {
                throw new SaveEditError('课题模式等级格式为 颜色×100+等级，颜色 1~5（绿蓝红金彩），等级 1~51；0 表示没有。')
            }
            next.gameProgress.values.challengeModeRank = value
        } else throw new SaveEditError(`不支持修改进度字段 ${key}，目前只能修改 money 和 challengeModeRank。`)
    }
}

/** @param {unknown} value */
function formatValue(value) {
    if (typeof value === 'boolean') return value ? '开' : '关'
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
    if (typeof value === 'string') return value ? `「${value}」` : '（空）'
    return JSON.stringify(value)
}

/**
 * 比较两份存档的实际内容。flagBytes 中已知的位由 values 决定，编辑后会在编码时重新生成，
 * 未知位是否保留由编解码测试覆盖，所以这里只比较 values 和尾部字节。
 * @param {Decoded} a @param {Decoded} b
 */
function sameContent(a, b) {
    const content = (/** @type {Decoded} */ decoded) => ({
        gameRecord: decoded.gameRecord,
        ...Object.fromEntries([...ENTRY_NAMES, 'summary'].map(name => {
            const { values, tail } = decoded[/** @type {typeof ENTRY_NAMES[number] | 'summary'} */ (name)]
            return [name, { values, tail }]
        })),
    })
    return JSON.stringify(content(a), bufferReplacer) === JSON.stringify(content(b), bufferReplacer)
}

/** @param {string} _ @param {unknown} value */
function bufferReplacer(_, value) {
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
    if (isRecord(value) && /** @type {any} */ (value).type === 'Buffer' && Array.isArray(/** @type {any} */ (value).data)) {
        return Buffer.from(/** @type {any} */ (value).data).toString('base64')
    }
    return value
}

/**
 * 解压、解密并解析云存档，同时确认重新编码后与原文逐字节一致；否则只读。
 * @param {Buffer} zip
 * @param {string} summary 云端记录里的 base64 summary
 */
export async function openArchive(zip, summary) {
    const entries = await cloudSaveArchive.readEntries(zip)
    /** @type {Record<string, number>} */
    const versions = {}
    /** @type {Record<string, Buffer>} */
    const plain = {}
    for (const name of REQUIRED) {
        const entry = entries.find(item => item.name === name)
        if (!entry || entry.data.length < 17 || (entry.data.length - 1) % 16 !== 0) throw new SaveEditError('云存档内容损坏，请在游戏内重新同步后再试。')
        versions[name] = entry.data[0]
        try { plain[name] = decryptSaveBytes(entry.data.subarray(1)) } catch { throw new SaveEditError('云存档解密失败，请在游戏内重新同步后再试。') }
    }
    let readOnlyReason = null
    if (versions.gameRecord !== GameRecord.version) readOnlyReason = '存档格式版本已更新，插件暂时只能读取不能上传。'
    /** @type {Decoded} */
    let baseline
    try {
        baseline = {
            gameRecord: decodeGameRecord(plain.gameRecord),
            gameProgress: decodeEntry('gameProgress', plain.gameProgress),
            user: decodeEntry('user', plain.user),
            settings: decodeEntry('settings', plain.settings),
            summary: decodeSummary(summary),
        }
    } catch (error) {
        if (error instanceof SaveFormatError) throw new SaveEditError(`无法解析云存档（${error.message}），请更新插件或在游戏内重新同步。`)
        throw error
    }
    const lossless = encodeGameRecord(baseline.gameRecord).equals(plain.gameRecord)
        && ENTRY_NAMES.every(name => encodeEntry(name, baseline[name]).equals(plain[name]))
        && encodeSummary(baseline.summary) === Buffer.from(summary, 'base64').toString('base64')
    if (!lossless) readOnlyReason ??= '插件无法无损重建这份存档（格式可能已更新），为安全起见只能读取不能上传。'
    return { entries, versions, baseline, readOnlyReason }
}

/**
 * @param {Pick<WorkingCopy, 'entries' | 'versions'>} copy
 * @param {Decoded} content
 */
async function buildArchive(copy, content) {
    /** @type {Record<string, Buffer>} */
    const plain = {
        gameRecord: encodeGameRecord(content.gameRecord),
        gameProgress: encodeEntry('gameProgress', content.gameProgress),
        user: encodeEntry('user', content.user),
        settings: encodeEntry('settings', content.settings),
    }
    return cloudSaveArchive.write(copy.entries.map(entry => plain[entry.name]
        ? { ...entry, data: Buffer.concat([Buffer.of(copy.versions[entry.name]), encryptSaveBytes(plain[entry.name])]) }
        : entry))
}

/** @param {string} userId */
async function defaultCredentials(userId) {
    const { default: userCredentialStore } = await import('../user/userCredentialStore.js')
    const { default: getSave } = await import('./getSave.js')
    const sessionToken = await userCredentialStore.getSessionToken(userId)
    if (!sessionToken) return null
    const save = await getSave.getSaveBySessionToken(sessionToken)
    return { sessionToken, isGlobal: Boolean(save?.global) }
}

/** @returns {SaveCatalog} */
function defaultCatalog() {
    return {
        findSongs: query => getInfo.fuzzysongsnick(query, 0.85, true),
        songName: id => getInfo.info(/** @type {idString} */ (id), true)?.song,
        backgroundName: id => getInfo.backgroundName(/** @type {idString} */ (id)),
        difficulty: (id, level) => getInfo.info(/** @type {idString} */ (id), true)?.chart?.[/** @type {allLevelKind} */ (level)]?.difficulty,
        isAvatar: name => Boolean(getInfo.avatarid?.includes(name)),
    }
}

function defaultBackupRoot() {
    return path.join(backupPath, 'saves')
}

export default new SaveEditService()
