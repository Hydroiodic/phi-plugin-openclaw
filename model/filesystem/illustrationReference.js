/** Opaque references are resolved to verified cache files by the platform. */
export const ILLUSTRATION_PREFIX = 'phi-illustration:///'

/** @param {...string} parts @returns {string} */
export function illustrationReference(...parts) {
    return ILLUSTRATION_PREFIX + parts.map(encodeURIComponent).join('/')
}
