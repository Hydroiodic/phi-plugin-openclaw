import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Same-directory replacement keeps a failed save from truncating valid data. */
export class AtomicFileWriter {
    /** @param {typeof fs} [filesystem] */
    constructor(filesystem = fs) { this.fs = filesystem }

    /** @param {string} file @param {string | NodeJS.ArrayBufferView} data */
    write(file, data) {
        const directory = path.dirname(file)
        this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        const temporary = path.join(directory, `.phi-write-${randomUUID()}.tmp`)
        let descriptor
        try {
            descriptor = this.fs.openSync(temporary, 'wx', 0o600)
            this.fs.writeFileSync(descriptor, data)
            this.fs.fsyncSync(descriptor)
            this.fs.closeSync(descriptor)
            descriptor = undefined
            this.fs.renameSync(temporary, file)
        } finally {
            if (descriptor !== undefined) this.fs.closeSync(descriptor)
            this.fs.rmSync(temporary, { force: true })
        }
    }
}

export default new AtomicFileWriter()
