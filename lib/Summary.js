import ByteReader from './ByteReader.js'
import Base64 from './Base64.js';

class Summary {
    /**
     * @param {string} summary
     */
    constructor(summary) {
        let now = Date().toString()
        let time = now.split(' ')
        this.updatedAt = `${time[3]} ${time[1]}.${time[2]} ${time[4]}`
        this.saveVersion = 0;
        this.challengeModeRank = 0;
        this.rankingScore = 0;
        this.gameVersion = 0;
        this.avatar = 0;

        this.cleared = new Int16Array(4);
        this.fullCombo = new Int16Array(4);
        this.phi = new Int16Array(4);

        const reader = new ByteReader(Base64.decode(summary));
        this.saveVersion = reader.getByte();
        this.challengeModeRank = reader.getShort();
        this.rankingScore = reader.getFloat();
        this.gameVersion = reader.getVarInt();
        this.avatar = reader.getString();
        this.cleared = [];
        this.fullCombo = [];
        this.phi = [];
        for (let level = 0; level < 4; level++) {
            this.cleared[level] = reader.getShort();
            this.fullCombo[level] = reader.getShort();
            this.phi[level] = reader.getShort();
        }
    }
}


export default Summary
