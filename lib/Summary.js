import ByteReader from './ByteReader.js'

class Summary {
    /**
     * @param {string} summary Base64 编码的云存档摘要
     */
    constructor(summary) {
        const time = Date().toString().split(' ')
        this.updatedAt = `${time[3]} ${time[1]}.${time[2]} ${time[4]}`

        const reader = new ByteReader(Buffer.from(summary, 'base64'))
        this.saveVersion = reader.getByte()
        this.challengeModeRank = reader.getShort()
        this.rankingScore = reader.getFloat()
        this.gameVersion = reader.getVarInt()
        this.avatar = reader.getString()
        /** @type {number[]} */
        this.cleared = []
        /** @type {number[]} */
        this.fullCombo = []
        /** @type {number[]} */
        this.phi = []
        for (let level = 0; level < 4; level++) {
            this.cleared[level] = reader.getShort()
            this.fullCombo[level] = reader.getShort()
            this.phi[level] = reader.getShort()
        }
    }
}

export default Summary
