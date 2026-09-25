class Util {
    /**
     * @param {number} data
     * @param {number} index
     */
    static getBit(data, index) {
        return (data & (1 << index)) !== 0
    }

    /**
     * @param {number} data
     * @param {number} index
     * @param {boolean} value
     */
    static modifyBit(data, index, value) {
        return value ? data | (1 << index) : data & ~(1 << index)
    }
}

export default Util
