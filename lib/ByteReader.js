/** Cursor-based Phigros binary reader/writer with checked, little-endian access. */
export default class ByteReader {
    /** @param {string | Buffer | Uint8Array | ArrayBuffer} data @param {number} [position] */
    constructor(data, position = 0) {
        if (typeof data === 'string' && (data.length % 2 || !/^[\da-f]*$/i.test(data))) {
            throw new TypeError('存档包含无效的十六进制数据')
        }
        this.data =
            typeof data === 'string'
                ? Buffer.from(data, 'hex')
                : data instanceof ArrayBuffer
                  ? Buffer.from(new Uint8Array(data))
                  : Buffer.from(data)
        this.position = position
        this.assertAvailable(0)
    }

    /** @param {number} size */
    assertAvailable(size) {
        if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            !Number.isSafeInteger(this.position) ||
            this.position < 0 ||
            size > this.data.length - this.position
        ) {
            throw new RangeError('存档数据不完整或读取位置无效')
        }
    }

    remaining() {
        this.assertAvailable(0)
        return this.data.length - this.position
    }

    /** @param {number} size @param {(position:number)=>number} read */
    readNumber(size, read) {
        this.assertAvailable(size)
        const value = read(this.position)
        this.position += size
        return value
    }

    /** @param {number} size @param {(position:number)=>unknown} write */
    writeNumber(size, write) {
        this.assertAvailable(size)
        write(this.position)
        this.position += size
    }

    getByte() {
        return this.readNumber(1, position => this.data.readUInt8(position))
    }
    getShort() {
        return this.readNumber(2, position => this.data.readUInt16LE(position))
    }
    getInt() {
        return this.readNumber(4, position => this.data.readInt32LE(position))
    }
    getFloat() {
        return this.readNumber(4, position => this.data.readFloatLE(position))
    }

    /** @param {number} value */
    putByte(value) {
        this.writeNumber(1, position => this.data.writeUInt8(value, position))
    }
    /** @param {number} value */
    putShort(value) {
        this.writeNumber(2, position => this.data.writeUInt16LE(value, position))
    }
    /** @param {number} value */
    putInt(value) {
        this.writeNumber(4, position => this.data.writeInt32LE(value, position))
    }
    /** @param {number} value */
    putFloat(value) {
        this.writeNumber(4, position => this.data.writeFloatLE(value, position))
    }

    getAllByte() {
        this.assertAvailable(0)
        return this.data.toString('base64', this.position)
    }

    getVarInt() {
        this.assertAvailable(1)
        const first = this.data[this.position]
        const size = first > 127 ? 2 : 1
        this.assertAvailable(size)
        const value = size === 2 ? (first & 0x7f) | (this.data[this.position + 1] << 7) : first
        this.position += size
        return value
    }

    /** @param {number} [count] */
    skipVarInt(count = 1) {
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('跳过数量无效')
        for (let index = 0; index < count; index++) this.getVarInt()
    }

    /** @param {()=>number} readLength */
    readBytes(readLength) {
        const start = this.position
        try {
            const length = readLength()
            this.assertAvailable(length)
            const result = this.data.subarray(this.position, this.position + length)
            this.position += length
            return result
        } catch (error) {
            this.position = start
            throw error
        }
    }

    getBytes() {
        return this.readBytes(() => this.getByte())
    }
    getString() {
        return this.readBytes(() => this.getVarInt()).toString('utf8')
    }
    skipString() {
        this.readBytes(() => this.getVarInt())
    }

    /** @param {string} value */
    putString(value) {
        const bytes = Buffer.from(value)
        if (bytes.length > 0x7fff) throw new RangeError('字符串长度超出存档格式限制')
        this.assertAvailable(bytes.length + (bytes.length > 127 ? 2 : 1))
        if (bytes.length > 127) {
            this.putByte((bytes.length & 0x7f) | 0x80)
            this.putByte(bytes.length >>> 7)
        } else this.putByte(bytes.length)
        this.data.set(bytes, this.position)
        this.position += bytes.length
    }

    /** @param {Uint8Array} bytes */
    insertBytes(bytes) {
        this.replaceBytes(0, bytes)
    }

    /** @param {number} length @param {Uint8Array} bytes */
    replaceBytes(length, bytes) {
        this.assertAvailable(length)
        this.data = Buffer.concat([this.data.subarray(0, this.position), bytes, this.data.subarray(this.position + length)])
    }
}
