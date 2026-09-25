import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { install, Browser, detectBrowserPlatform } from '@puppeteer/browsers'
import puppeteer from 'puppeteer-core'

function systemCandidates() {
  return [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ]
}

/** @param {string} file */
function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves usable local browsers and coalesces installs per independent cache. */
export class BrowserResolver {
  /** @param {{candidates?: () => Array<string | undefined>, installBrowser?: typeof install,
   * executable?: (file: string) => boolean, platform?: typeof detectBrowserPlatform, buildId?: string}} [options] */
  constructor({
    candidates = systemCandidates,
    installBrowser = install,
    executable = isExecutable,
    platform = detectBrowserPlatform,
    buildId = /** @type {any} */ (puppeteer).defaultBrowserRevision,
  } = {}) {
    this.candidates = candidates
    this.installBrowser = installBrowser
    this.executable = executable
    this.platform = platform
    this.buildId = buildId
    /** @type {Map<string, Promise<string>>} */
    this.pending = new Map()
  }

  /** @param {string | undefined} dataRoot */
  async resolve(dataRoot) {
    const found = this.candidates().find(file => file && this.executable(file))
    if (found) return found
    const cacheDir = path.resolve(dataRoot || os.tmpdir(), 'browser')
    const platform = this.platform()
    if (!platform) throw new Error('当前系统不支持自动安装 Chrome，请配置 chromiumPath。')
    const key = JSON.stringify([cacheDir, platform, this.buildId])
    const existing = this.pending.get(key)
    if (existing) return existing
    const pending = Promise.resolve()
      .then(() => this.installBrowser({ browser: Browser.CHROME, buildId: this.buildId, platform, cacheDir }))
      .then(browser => browser.executablePath)
      .finally(() => this.pending.delete(key))
    // Retain in-flight work only. A later resolve rechecks installation state,
    // so deleting the cache or changing dataRoot cannot leave a stale path.
    this.pending.set(key, pending)
    return pending
  }
}

const resolver = new BrowserResolver()
/** @param {string | undefined} dataRoot */
export const resolveBrowser = dataRoot => resolver.resolve(dataRoot)
