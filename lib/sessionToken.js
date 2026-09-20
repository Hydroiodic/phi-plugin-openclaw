/** @param {unknown} value @returns {value is phigrosToken} */
export function isSessionToken(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9]{25}$/.test(value)
}

/** @param {unknown} value @returns {asserts value is phigrosToken} */
export function assertSessionToken(value) {
    if (!isSessionToken(value)) throw new Error('SessionToken格式错误')
}
