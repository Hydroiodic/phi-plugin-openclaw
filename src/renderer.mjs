import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import template from 'art-template'
import { getPlatformAdapter } from '../components/platform/state.js'

export class TemplateRenderer {
  /** @param {any} data */
  constructor(data = {}) {
    this.id = data.id || 'renderer'
    this.type = data.type || 'image'
    this.render = /** @type {any} */ (this)[data.render || 'render']
    this.watcher = {}
    this.html = {}
    /** @type {Set<string>} */
    this.generatedFiles = new Set()
    this.dir = path.join(getPlatformAdapter()?.dataRoot || process.cwd(), 'temp', 'html')
  }
  /** @param {string} source @param {any} data */
  renderTemplate(source, data) {
    return template.render(source, data)
  }
  /** @param {string} name @param {any} data */
  dealTpl(name, data) {
    if (!fs.existsSync(data.tplFile)) return false
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const file = path.join(this.dir, `${randomUUID()}.html`)
    const source = fs.readFileSync(data.tplFile, 'utf8')
    const resources = fileURLToPath(new URL('../resources/', import.meta.url))
    const html = template.render(source, { ...data, resPath: pathToFileURL(resources).href + '/' }, { filename: data.tplFile })
    const fd = fs.openSync(file, 'wx', 0o600)
    this.generatedFiles.add(file)
    try {
      try {
        fs.writeFileSync(fd, html)
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      this.releaseTemplate(file)
      throw error
    }
    return file
  }

  /** Delete only files created by this renderer, never a template or caller path.
   * @param {string | undefined} file */
  releaseTemplate(file) {
    if (!file || !this.generatedFiles.has(file)) return false
    fs.rmSync(file, { force: true })
    this.generatedFiles.delete(file)
    return true
  }

  closeTemplates() {
    const errors = []
    for (const file of this.generatedFiles) {
      try {
        this.releaseTemplate(file)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, '渲染临时文件清理失败。')
  }
}
