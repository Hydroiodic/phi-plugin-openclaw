import chalk from 'chalk'
import logger from '../../components/Logger.js'
import { APIBASEURL } from '../game/constNum.js'
import { setTimeout as delay } from 'node:timers/promises'
import axios from 'axios'
import { Config } from '../../components/index.js'
import Version from '../../components/Version.js'
import botApiAuth from './botApiAuth.js'
import { classifyApiConnectionError, getPhiApiUserMessage, isFatalBotIdentityError } from './phiApiErrors.js'
import { compareApiVersion, isApiVersionBlocked, setApiVersionBlocked, SUPPORTED_API_VERSION } from './apiVersion.js'

export class AutoSeekApi {
    /** @param {{retryDelayMs?: number}} [options] */
    constructor({ retryDelayMs = 30_000 } = {}) {
        if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 2 ** 31 - 1)
            throw new RangeError('Invalid API retry delay')
        this.retryDelayMs = retryDelayMs
        this.stopped = false
        this.abortController = new AbortController()
        /** @type {Promise<void> | undefined} */
        this.statusPromise = undefined
        /** @type {Promise<void> | undefined} */
        this.retryPromise = undefined
        /** @type {Promise<void> | undefined} */
        this.closing = undefined
        //是否在等待API状态测试结果
        this.waitApi = false
        //是否在轮询检测API状态
        this.seekingApi = false

        this.openPhiPluginApi = false
        // 主版本不兼容或版本响应无效时阻止所有 API 业务请求。
        this.remoteApiVersion = ''
    }

    /**
     * 判断当前运行周期是否因 API 协议版本不兼容而被关闭。
     * @returns {boolean}
     */
    isVersionBlocked() {
        return isApiVersionBlocked()
    }

    /**
     * 校验状态接口返回的 API 协议版本并更新运行时开关。
     * @param {unknown} version API 返回的版本号
     * @returns {boolean} 是否允许继续初始化 API 客户端
     */
    validateApiVersion(version) {
        const result = compareApiVersion(version)
        this.remoteApiVersion = result.apiVersion

        if (result.status === 'major_mismatch') {
            setApiVersionBlocked(true)
            this.openPhiPluginApi = false
            this.seekingApi = false
            logger.error(
                `[phi-plugin] API大版本不兼容：API ${result.apiVersion}，插件支持 ${result.supportedVersion}。` +
                    '已自动关闭 API 功能，请更新 phi-plugin 后重启。',
            )
            return false
        }

        if (result.status === 'invalid') {
            setApiVersionBlocked(true)
            this.openPhiPluginApi = false
            this.seekingApi = false
            logger.error(
                `[phi-plugin] API未返回有效的协议版本，插件支持 ${SUPPORTED_API_VERSION}。` +
                    '已自动关闭 API 功能，请更新 phi-plugin 后重启。',
            )
            return false
        }

        setApiVersionBlocked(false)
        if (result.status === 'minor_mismatch') {
            logger.warn(
                `[phi-plugin] API小版本不一致：API ${result.apiVersion}，插件支持 ${result.supportedVersion}。` +
                    '当前仍可继续使用，建议尽快更新 phi-plugin。',
            )
        }
        return true
    }

    /** Closed services must not read configuration or recreate file watchers. */
    isEnabled() {
        if (this.stopped) return false
        return Boolean(Config.getUserCfg('config', 'openPhiPluginApi'))
    }

    /** Coalesces status checks so shutdown can await the complete recovery chain. */
    testStatus() {
        if (!this.isEnabled()) {
            this.openPhiPluginApi = false
            this.seekingApi = false
            return Promise.resolve()
        }
        if (this.statusPromise) return this.statusPromise
        this.waitApi = true
        this.statusPromise = this.checkStatus().finally(() => {
            this.waitApi = false
            this.statusPromise = undefined
        })
        return this.statusPromise
    }

    async checkStatus() {
        logger.mark(chalk.yellow('正在测试API链接...'))
        const url = `${APIBASEURL}/status`
        try {
            // Use the default HTTPS certificate verification, and abort an in-flight
            // status request as soon as the owning runtime begins to shut down.
            const res = await axios.get(url, { timeout: 5000, signal: this.abortController.signal })
            if (this.stopped) return
            if (res.status !== 200) {
                logger.error(`[phi-plugin] API状态接口返回 HTTP ${res.status}`)
                this.openPhiPluginApi = false
                this.seekApi()
                return
            }
            const resdata = res.data?.data ?? res.data
            if (!this.validateApiVersion(resdata?.version)) return
            logger.mark(chalk.green(`API地址测试成功！${resdata?.id || 'phi-plugin-api'} ${resdata.version}`))
            this.openPhiPluginApi = true
            try {
                const identity = await botApiAuth.recoverAfterReconnect(Version.ver)
                if (this.stopped) return
                logger.mark(chalk.green(`API Bot身份已就绪：${identity.clientId}`))
                const { default: botSyncService } = await import('./botSyncService.js')
                if (this.stopped) return
                await botSyncService.recoverAfterReconnect()
                if (this.stopped) return
                const { default: aliasProposalService } = await import('./aliasProposalService.js')
                if (this.stopped) return
                await aliasProposalService.initialize()
                this.seekingApi = false
            } catch (/** @type {any} */ error) {
                if (this.stopped) return
                logger[isFatalBotIdentityError(error) ? 'error' : 'warn'](
                    `[phi-plugin] API已恢复，但Bot身份恢复失败：${error?.code || getPhiApiUserMessage(error)}`,
                )
                if (isFatalBotIdentityError(error)) this.seekingApi = false
                else this.seekApi()
            }
        } catch (e) {
            if (this.stopped) return
            const error = classifyApiConnectionError(e)
            logger.error(`[phi-plugin] API连接检测失败：${error.code}`)
            this.openPhiPluginApi = false
            this.seekApi()
        }
    }

    seekApi() {
        if (!this.isEnabled() || isApiVersionBlocked()) {
            this.openPhiPluginApi = false
            this.seekingApi = false
            return Promise.resolve()
        }
        if (this.retryPromise) return this.retryPromise
        this.seekingApi = true
        this.retryPromise = this.retryLoop()
            .catch(() => {
                if (!this.stopped) logger.warn('[phi-plugin] API自动重连失败，将于下次请求时重试。')
            })
            .finally(() => {
                this.seekingApi = false
                this.retryPromise = undefined
            })
        return this.retryPromise
    }

    async retryLoop() {
        while (!this.stopped && this.seekingApi) {
            await delay(this.retryDelayMs, undefined, { signal: this.abortController.signal, ref: false })
            if (!this.seekingApi) return
            if (!this.isEnabled() || isApiVersionBlocked()) {
                this.openPhiPluginApi = false
                this.seekingApi = false
                return
            }
            await this.testStatus()
        }
    }

    /** Stop timers first, then drain any identity/synchronization already in flight. */
    close() {
        if (this.closing) return this.closing
        this.stopped = true
        this.seekingApi = false
        this.openPhiPluginApi = false
        this.abortController.abort()
        this.closing = Promise.allSettled([this.statusPromise, this.retryPromise]).then(() => {
            this.waitApi = false
        })
        return this.closing
    }
}

export default new AutoSeekApi()
