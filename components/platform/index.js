import { getPlatformAdapter, setPlatformAdapter } from './state.js'
import { createPlatform } from '../../src/platform.mjs'

// Production injects the OpenClaw runtime before loading features. Isolated
// library consumers/tests get ephemeral SQLite, never a host framework adapter.
if (!getPlatformAdapter()) {
    setPlatformAdapter(/** @type {any} */ (createPlatform()))
}

export * from './state.js'
export { default } from './state.js'
