/**
 * Public TapTap/LeanCloud client identifiers that ship with the Phigros game client.
 * They identify the game, not a user; every request still needs the player's own session.
 */
const REGIONS = Object.freeze({
    cn: Object.freeze({
        clientId: 'rAK3FfdieFob2Nn8Am',
        appKey: 'Qr9AEqtuoSVS3zeD6iVbM4ZC0AtkJcQ89tywVyi0',
        leanCloud: 'https://rak3ffdi.cloud.tds1.tapapis.cn/1.1',
        accounts: 'https://accounts.tapapis.cn',
        openApi: 'https://open.tapapis.cn',
    }),
    global: Object.freeze({
        clientId: 'kviehleldgxsagpozb',
        appKey: 'tG9CTm0LDD736k9HMM9lBZrbeBGRmUkjSfNLDNib',
        leanCloud: 'https://kviehlel.cloud.ap-sg.tapapis.com/1.1',
        accounts: 'https://accounts.tapapis.com',
        openApi: 'https://open.tapapis.com',
    }),
})

/** @param {boolean} [isGlobal] 是否为国际服 */
export function tapRegion(isGlobal = false) {
    return isGlobal ? REGIONS.global : REGIONS.cn
}
