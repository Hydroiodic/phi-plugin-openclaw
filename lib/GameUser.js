import ByteReader from './ByteReader.js';
import Util from './Util.js';

class GameUser {
    /**
     * @param {string} data
     */
    constructor(data) {
        const Reader = new ByteReader(data)
        this.showPlayerId = Util.getBit(Reader.getByte(), 0);
        this.selfIntro = Reader.getString();
        this.avatar = Reader.getString();
        this.background = Reader.getString();
    }
}

export default GameUser
