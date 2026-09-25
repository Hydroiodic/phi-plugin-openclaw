
import YAML from 'yaml'
import fs from 'node:fs'
import YamlReader from './YamlReader.js'
import fileWatcherRegistry from './FileWatcherRegistry.js'
import { configPath, defaultPath } from '../model/filesystem/path.js'
import logger from './Logger.js'
import platform from './platform/index.js'
import { getHostSettings, writeHostSetting } from './settings/host.js'
import settings from './settings/shared.cjs'

export class Config {
    /** @param {{configDir?: string, defaultDir?: string, watchers?: import('./FileWatcherRegistry.js').FileWatcherRegistry}} [options] */
    constructor({ configDir = configPath, defaultDir = defaultPath, watchers = fileWatcherRegistry } = {}) {
        this.configDir = configDir
        this.defaultDir = defaultDir
        this.registry = watchers
        this.dirty = new Set()
        /** @type {Record<string, any>} */
        this.config = {}
        /** @type {Record<string, any>} */
        this.runtimeOverrides = {}

        /** 监听文件 */
        /** @type {Record<string, any>} */
        this.watcher = {}

        this.initCfg()
    }

    /** 初始化配置 */
    initCfg() {
        const path = `${this.configDir}/`
        const pathDef = `${this.defaultDir}/`
        fs.mkdirSync(path, { recursive: true, mode: 0o700 })
        const files = fs.readdirSync(pathDef).filter(file => file.endsWith('.yaml'))
        for (const file of files) {
            if (!fs.existsSync(`${path}${file}`)) {
                fs.copyFileSync(`${pathDef}${file}`, `${path}${file}`)
            }
            fs.chmodSync(`${path}${file}`, 0o600)
            this.watch(`${path}${file}`, file.replace('.yaml', ''), 'config')
        }
    }

    /** 群配置 */
    getGroup(groupId = '') {
        const config = this.getConfig('whole')
        const group = this.getConfig('group')
        const defCfg = this.getdefSet('whole')

        if (group[groupId]) {
            return { ...defCfg, ...config, ...group[groupId] }
        }
        return { ...defCfg, ...config }
    }

    /**
     * @overload
     * @param {'config'} name 文件名
     * @param {configName} style key值
     * @returns {any} 配置值
     */
    /**
     * @overload
     * @param {'nickconfig'} name 文件名
     * @param {string} mic 别名
     * @returns {idString[]} 原曲id
     */
    /**
     * @overload
     * @param {'nickconfig'} name 文件名
     * @returns {Record<string, idString[]>} <别名: 原曲id[]>
     */
    /**
     * @overload
     * @param {'otherinfo'} name 文件名
     * @returns {any} 其他信息
     */
    /**
     * @param {'config'|'nickconfig'|'otherinfo'} name 文件名
     * @param {any} [style] key值
     * @description 默认配置和用户配置
    */
    getUserCfg(name, style = undefined) {
        const def = this.getdefSet(name)
        const config = this.getConfig(name)
        if (name == 'otherinfo' && config) {
            for (const i in config) {
                config[i].sp_vis = true;
            }
        }
        if (style) {
            if (typeof config[style] != 'undefined') {
                return config[style]
            } else {
                /**对设置进行补全 */
                if (name == 'config') {
                    this.modify(name, style, def[style])
                }
                return def[style]
            }
        }
        else
            return (config ? config : def)
    }

    /** 默认配置 */
    /**
     * @param {string} name
     * @returns {Record<string, any>}
     */
    getdefSet(name) {
        return this.getYaml('default_config', name)
    }

    /** 用户配置 */
    /**
     * @param {string} name
     * @returns {Record<string, any>}
     */
    getConfig(name) {
        const local = this.getYaml('config', name)
        return name === 'config' ? { ...local, ...getHostSettings(), ...this.runtimeOverrides } : local
    }

    /**
     * 获取配置yaml
     * @param {'config'|'default_config'} type 默认配置-defSet，用户配置-config
     * @param {string} name 名称
     * @returns {Record<string, any>}
     */
    getYaml(type, name) {
        if (!/^[\w-]+$/.test(name)) throw new TypeError('Invalid configuration name')
        const file = `${type === 'config' ? this.configDir : this.defaultDir}/${name}.yaml`
        const key = `${type}.${name}`

        if (this.config[key] && !this.dirty.has(key)) return this.config[key]
        try {
            const value = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}
            if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Configuration must be a mapping')
            this.config[key] = name === 'config' ? { ...value, ...settings.validateSettings(value) } : value
        } catch (error) {
            if (type !== 'config') throw new Error(`无法读取默认配置 ${name}`, { cause: error })
            // Keep the last valid value; never echo file contents or overwrite
            // a malformed file that the administrator may still be editing.
            logger.warn(`[phi-plugin] 配置 ${name} 无法读取，使用上次有效值或默认配置。`)
            this.config[key] ??= this.getdefSet(name)
        }
        this.dirty.delete(key)
        this.watch(file, name, type)

        return this.config[key]
    }

    /** 监听配置文件 */
    /**
     * @param {string} file
     * @param {string} name
     * @param {'config'|'default_config'} [type]
     */
    watch(file, name, type = 'default_config') {
        const key = `${type}.${name}`

        if (this.watcher[key]) return

        const watcherKey = `config:${key}`
        const watcher = this.registry.watch(watcherKey, file, path => {
            this.dirty.add(key)
            if (!platform.isBotReady()) return
            logger.mark(`[phi修改配置文件][${type}][${name}]`)
            const changeHandler = /** @type {Record<string, any>} */ (this)[`change_${name}`]
            if (typeof changeHandler === 'function') {
                changeHandler.call(this)
            }
        })

        this.watcher[key] = watcher
    }

    /** 关闭当前配置实例创建的全部监听器。 */
    async close() {
        const entries = Object.entries(this.watcher)
        this.watcher = {}
        await Promise.allSettled(entries.map(([, lease]) => lease.close()))
    }

    /**
     * @overload
     * @param {'config'} name 文件名
     * @param {configName} key 修改的key值
     * @param {String|Number|boolean} value 修改的value值
     * @param {'config'|'default_config'} [type] 配置文件或默认，默认为配置
     * @returns {void}
     */
    /**
     * @overload
     * @param {'nickconfig'} name 文件名
     * @param {any} key 别名
     * @param {String|Number|any[]} value 修改的value值
     * @param {'config'|'default_config'} [type] 配置文件或默认，默认为配置
     * @returns {void}
     */
    /**
     * @description: 修改设置
     * @param {'config'|'nickconfig'} name 文件名
     * @param {any} key 修改的key值
     * @param {String|Number|boolean|any[]} value 修改的value值
     * @param {'config'|'default_config'} [type] 配置文件或默认
     */
    modify(name, key, value, type = 'config') {
        if (name === 'config' && type === 'config' && writeHostSetting(key, value)) return
        const path = `${type === 'config' ? this.configDir : this.defaultDir}/${name}.yaml`
        new YamlReader(path).set(key, value)
        delete this.config[`${type}.${name}`]
    }

    /**
     * @description: 修改配置数组
     * @param {'config'|'nickconfig'} name 文件名
     * @param {string | number} key key值
     * @param {String|Number} value value
     * @param {'add'|'del'} category 类别 add or del
     * @param {'config'|'default_config'} type 配置文件或默认
     */
    modifyarr(name, key, value, category = 'add', type = 'config') {
        const path = `${type === 'config' ? this.configDir : this.defaultDir}/${name}.yaml`
        const yaml = new YamlReader(path)
        const keyPath = String(key)
        if (category == 'add') {
            yaml.addIn(keyPath, value)
        } else {
            const values = yaml.get(keyPath)
            if (!Array.isArray(values)) return
            const index = values.indexOf(value)
            if (index < 0) return
            yaml.delete(`${keyPath}.${index}`)
        }
        delete this.config[`${type}.${name}`]
    }
}

export default new Config()
