import platform from './platform/index.js'

/** Version information comes from the installed package and verified resources. */
export class ProjectVersion {
    get ver() { return `v${platform.getPackageVersion()}` }
    get phigros() { return platform.resourceManifest?.game.version || '' }
    get phigrosVerNum() { return platform.resourceManifest?.game.code || 0 }
    toJSON() { return { ver: this.ver, phigros: this.phigros, phigrosVerNum: this.phigrosVerNum } }
}

export default new ProjectVersion()
