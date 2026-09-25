import ByteReader from './ByteReader.js'
import Util from './Util.js'

/** 插件无法无损读写的存档格式；此时只能读取，不能上传。 */
export class SaveFormatError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.name = 'SaveFormatError'
    }
}

export const LEVEL_NAMES = /** @type {const} */ (['EZ', 'HD', 'IN', 'AT', 'LEGACY'])
/** ByteReader 只读两字节 varint，写入时也不超过这个范围 */
const MAX_VARINT = 0x3fff
const LEVEL_MASK = 0b11111

/**
 * @typedef {{type: 'flags', bits: string[]}
 *   | {type: 'byte' | 'short' | 'varint' | 'float' | 'string', name: string}
 *   | {type: 'varints', name: string, count: number}
 *   | {type: 'levelStats'}} FieldSpec
 */

/**
 * 已知字段的二进制布局；字段之后的未知字节原样保留在 tail 中。
 * @type {Record<'gameProgress' | 'user' | 'settings' | 'summary', FieldSpec[]>}
 */
export const ENTRY_LAYOUTS = {
    gameProgress: [
        { type: 'flags', bits: ['isFirstRun', 'legacyChapterFinished', 'alreadyShowCollectionTip', 'alreadyShowAutoUnlockINTip'] },
        { type: 'string', name: 'completed' },
        { type: 'varint', name: 'songUpdateInfo' },
        { type: 'short', name: 'challengeModeRank' },
        { type: 'varints', name: 'money', count: 5 },
        { type: 'byte', name: 'unlockFlagOfSpasmodic' },
        { type: 'byte', name: 'unlockFlagOfIgallta' },
        { type: 'byte', name: 'unlockFlagOfRrharil' },
        { type: 'byte', name: 'flagOfSongRecordKey' },
        { type: 'byte', name: 'randomVersionUnlocked' },
        { type: 'flags', bits: ['chapter8UnlockBegin', 'chapter8UnlockSecondPhase', 'chapter8Passed'] },
        { type: 'byte', name: 'chapter8SongUnlocked' },
    ],
    user: [
        { type: 'flags', bits: ['showPlayerId'] },
        { type: 'string', name: 'selfIntro' },
        { type: 'string', name: 'avatar' },
        { type: 'string', name: 'background' },
    ],
    settings: [
        { type: 'flags', bits: ['chordSupport', 'fcAPIndicator', 'enableHitSound', 'lowResolutionMode'] },
        { type: 'string', name: 'deviceName' },
        { type: 'float', name: 'bright' },
        { type: 'float', name: 'musicVolume' },
        { type: 'float', name: 'effectVolume' },
        { type: 'float', name: 'hitSoundVolume' },
        { type: 'float', name: 'soundOffset' },
        { type: 'float', name: 'noteScale' },
    ],
    summary: [
        { type: 'byte', name: 'saveVersion' },
        { type: 'short', name: 'challengeModeRank' },
        { type: 'float', name: 'rankingScore' },
        { type: 'varint', name: 'gameVersion' },
        { type: 'string', name: 'avatar' },
        { type: 'levelStats' },
    ],
}

/**
 * @typedef {object} DecodedEntry
 * @property {Record<string, any>} values 已知字段
 * @property {number[]} flagBytes 各 flags 字段的原始字节，用于保留未知位
 * @property {Buffer} tail 已知字段之后的原始字节
 */

/** @param {number} value @param {number} min @param {number} max @param {string} what */
function assertInt(value, min, max, what) {
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${what} 超出存档格式允许的范围（${min}~${max}）`)
}

class ByteWriter {
    constructor() {
        /** @type {Buffer[]} */
        this.chunks = []
    }

    /** @param {number} size @param {(buffer: Buffer) => unknown} write */
    push(size, write) {
        const buffer = Buffer.alloc(size)
        write(buffer)
        this.chunks.push(buffer)
    }

    /** @param {number} value @param {string} [what] */
    byte(value, what = 'byte') {
        assertInt(value, 0, 0xff, what)
        this.push(1, buffer => buffer.writeUInt8(value))
    }

    /** @param {number} value @param {string} [what] */
    short(value, what = 'short') {
        assertInt(value, 0, 0xffff, what)
        this.push(2, buffer => buffer.writeUInt16LE(value))
    }

    /** @param {number} value @param {string} [what] */
    int(value, what = 'int') {
        assertInt(value, -0x80000000, 0x7fffffff, what)
        this.push(4, buffer => buffer.writeInt32LE(value))
    }

    /** @param {number} value @param {string} [what] */
    float(value, what = 'float') {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${what} 必须是有限数字`)
        this.push(4, buffer => buffer.writeFloatLE(value))
    }

    /** @param {number} value @param {string} [what] */
    varint(value, what = 'varint') {
        assertInt(value, 0, MAX_VARINT, what)
        if (value < 0x80) this.byte(value)
        else {
            this.byte((value & 0x7f) | 0x80)
            this.byte(value >>> 7)
        }
    }

    /** @param {string} value @param {string} [what] */
    string(value, what = 'string') {
        if (typeof value !== 'string') throw new TypeError(`${what} 必须是字符串`)
        const bytes = Buffer.from(value, 'utf8')
        this.varint(bytes.length, `${what} 的长度`)
        this.chunks.push(bytes)
    }

    /** @param {Uint8Array} bytes */
    raw(bytes) {
        this.chunks.push(Buffer.from(bytes))
    }

    toBuffer() {
        return Buffer.concat(this.chunks)
    }
}

/**
 * @param {keyof typeof ENTRY_LAYOUTS} name
 * @param {Buffer} bytes 解密后的明文
 * @returns {DecodedEntry}
 */
export function decodeEntry(name, bytes) {
    const reader = new ByteReader(bytes)
    /** @type {Record<string, any>} */
    const values = {}
    const flagBytes = []
    try {
        for (const field of ENTRY_LAYOUTS[name]) {
            switch (field.type) {
                case 'flags': {
                    const flags = reader.getByte()
                    flagBytes.push(flags)
                    field.bits.forEach((bit, index) => { values[bit] = Util.getBit(flags, index) })
                    break
                }
                case 'byte': values[field.name] = reader.getByte(); break
                case 'short': values[field.name] = reader.getShort(); break
                case 'varint': values[field.name] = reader.getVarInt(); break
                case 'float': values[field.name] = reader.getFloat(); break
                case 'string': values[field.name] = reader.getString(); break
                case 'varints': values[field.name] = Array.from({ length: field.count }, () => reader.getVarInt()); break
                case 'levelStats': {
                    values.cleared = []
                    values.fullCombo = []
                    values.phi = []
                    for (let level = 0; level < 4; level++) {
                        values.cleared.push(reader.getShort())
                        values.fullCombo.push(reader.getShort())
                        values.phi.push(reader.getShort())
                    }
                    break
                }
            }
        }
    } catch (error) {
        if (error instanceof RangeError) throw new SaveFormatError(`${name} 数据不完整`)
        throw error
    }
    return { values, flagBytes, tail: Buffer.from(reader.data.subarray(reader.position)) }
}

/**
 * @param {keyof typeof ENTRY_LAYOUTS} name
 * @param {DecodedEntry} entry
 */
export function encodeEntry(name, { values, flagBytes, tail }) {
    const writer = new ByteWriter()
    let flagIndex = 0
    for (const field of ENTRY_LAYOUTS[name]) {
        switch (field.type) {
            case 'flags': {
                let flags = flagBytes[flagIndex++] ?? 0
                field.bits.forEach((bit, index) => { flags = Util.modifyBit(flags, index, Boolean(values[bit])) })
                writer.byte(flags)
                break
            }
            case 'byte': writer.byte(values[field.name], field.name); break
            case 'short': writer.short(values[field.name], field.name); break
            case 'varint': writer.varint(values[field.name], field.name); break
            case 'float': writer.float(values[field.name], field.name); break
            case 'string': writer.string(values[field.name], field.name); break
            case 'varints': {
                const list = values[field.name]
                if (!Array.isArray(list) || list.length !== field.count) throw new RangeError(`${field.name} 必须包含 ${field.count} 个数字`)
                list.forEach((value, index) => writer.varint(value, `${field.name}[${index}]`))
                break
            }
            case 'levelStats': {
                for (let level = 0; level < 4; level++) {
                    writer.short(values.cleared[level], 'cleared')
                    writer.short(values.fullCombo[level], 'fullCombo')
                    writer.short(values.phi[level], 'phi')
                }
                break
            }
        }
    }
    writer.raw(tail)
    return writer.toBuffer()
}

/**
 * @typedef {{score: number, acc: number, fc: boolean}} LevelScore
 * @typedef {{id: string, levels: (LevelScore | null)[], fcFlags: number}} SongRecord
 */

/** @param {Buffer} bytes 解密后的 gameRecord 明文 @returns {{songs: SongRecord[]}} */
export function decodeGameRecord(bytes) {
    const reader = new ByteReader(bytes)
    /** @type {SongRecord[]} */
    const songs = []
    try {
        const count = reader.getVarInt()
        while (reader.remaining() > 0) {
            const id = reader.getString()
            const length = reader.getVarInt()
            const start = reader.position
            const present = reader.getByte()
            const fcFlags = reader.getByte()
            if (present & ~LEVEL_MASK) throw new SaveFormatError('gameRecord 含有插件不认识的难度')
            /** @type {(LevelScore | null)[]} */
            const levels = []
            for (let level = 0; level < LEVEL_NAMES.length; level++) {
                levels.push(Util.getBit(present, level) ? { score: reader.getInt(), acc: reader.getFloat(), fc: Util.getBit(fcFlags, level) } : null)
            }
            if (reader.position - start !== length) throw new SaveFormatError('gameRecord 条目长度与内容不符')
            songs.push({ id, levels, fcFlags })
        }
        if (count !== songs.length) throw new SaveFormatError('gameRecord 曲目数量与内容不符')
    } catch (error) {
        if (error instanceof RangeError) throw new SaveFormatError('gameRecord 数据不完整')
        throw error
    }
    return { songs }
}

/** @param {{songs: SongRecord[]}} record */
export function encodeGameRecord({ songs }) {
    const writer = new ByteWriter()
    writer.varint(songs.length, '曲目数量')
    for (const song of songs) {
        writer.string(song.id, '曲目 ID')
        let present = 0
        // 没有成绩的难度保留原始 fc 位，只改写有成绩的难度
        let fcFlags = song.fcFlags
        const body = new ByteWriter()
        song.levels.forEach((level, index) => {
            if (!level) return
            present = Util.modifyBit(present, index, true)
            fcFlags = Util.modifyBit(fcFlags, index, level.fc)
        })
        body.byte(present)
        body.byte(fcFlags, 'fc 标记')
        song.levels.forEach(level => {
            if (!level) return
            body.int(level.score, `${song.id} 的分数`)
            body.float(level.acc, `${song.id} 的 acc`)
        })
        const bytes = body.toBuffer()
        writer.varint(bytes.length)
        writer.raw(bytes)
    }
    return writer.toBuffer()
}

/** @param {string} base64 云端 gamesave 记录中的 summary @returns {DecodedEntry} */
export function decodeSummary(base64) {
    return decodeEntry('summary', Buffer.from(base64, 'base64'))
}

/** @param {DecodedEntry} summary */
export function encodeSummary(summary) {
    return encodeEntry('summary', summary).toString('base64')
}
