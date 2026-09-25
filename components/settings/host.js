import shared from './shared.cjs'

/** @type {{values: Record<string, any>, write: (values: Record<string, any>) => void} | undefined} */
let host

/**
 * 设置 schema 与持久化字段之间的通用映射；OpenClaw 运行时使用本地 YAML。
 * @param {Record<string, any>} values
 * @param {(values: Record<string, any>) => void} write
 */
export function bindHostSettings(values, write) {
    const binding = { values: shared.validateSettings({ ...shared.defaults, ...shared.readGeneratedSettings(), ...values }), write }
    host = binding
    return () => {
        if (host === binding) host = undefined
    }
}

export function getHostSettings() {
    return host ? { ...host.values } : {}
}

/** @param {string} key @param {any} value */
export function writeHostSetting(key, value) {
    if (!host || !shared.fields.has(key)) return false
    return writeHostSettings({ [key]: value })
}

/** @param {Record<string, any>} values */
export function updateHostSettings(values) {
    if (host) host.values = shared.validateSettings({ ...host.values, ...values })
}

/** 批量保存签发的身份，避免三项凭据被分别更新。 @param {Record<string, any>} values */
export function writeHostSettings(values) {
    if (!host) return false
    const binding = host
    const next = shared.validateSettings({ ...binding.values, ...values })
    binding.write(next)
    binding.values = next
    return true
}
