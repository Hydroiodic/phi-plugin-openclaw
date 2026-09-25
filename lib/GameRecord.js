import LevelRecord from './LevelRecord.js'
import ByteReader from './ByteReader.js'
import Util from './Util.js'

class GameRecord {
    /** 云存档中 gameRecord 条目的格式版本 */
    static version = 1

    /**
     * @param {string} data 解密后的十六进制明文
     */
    constructor(data) {
        this.data = new ByteReader(data)
        /** @type {Record<string, LevelRecord[]>} */
        this.Record = {}
        this.songsnum = 0
    }

    async init() {
        this.songsnum = this.data.getVarInt()
        while (this.data.remaining() > 0) {
            const key = this.data.getString()
            this.data.skipVarInt()
            const length = this.data.getByte()
            const fc = this.data.getByte()
            /** @type {LevelRecord[]} */
            const song = []
            for (let level = 0; level < 5; level++) {
                if (!Util.getBit(length, level)) continue
                const record = new LevelRecord()
                record.score = this.data.getInt()
                record.acc = this.data.getFloat()
                record.fc = (record.score === 1000000 && record.acc === 100) || Util.getBit(fc, level)
                song[level] = record
            }
            this.Record[key] = song
        }
    }
}

export default GameRecord
