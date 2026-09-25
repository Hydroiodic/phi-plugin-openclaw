import readFile from '../filesystem/getFile.js'
import { DlcInfoPath, dataPath, imgPath, infoPath, ortherIllPath, oldInfoPath, pluginResources } from '../filesystem/path.js'
import { illustrationReference } from '../filesystem/illustrationReference.js'
import path from 'path'
import Config from '../../components/Config.js'
import SongsInfo from './SongsInfo.js'
import fs from 'fs'
import { allLevel, Level, MAX_DIFFICULTY } from './constNum.js'
import fCompute from './fCompute.js'
import logger from '../../components/Logger.js'
import fileWatcherRegistry from '../../components/FileWatcherRegistry.js'
/** @import Chart from './Chart.js' */
/** @import Save from '../save/Save.js' */


/**
 * 存档 user.background 中与曲名不一致的写法
 * @type {Record<string, string>}
 */
const SAVE_BACKGROUND_ALIASES = {
    'Another Me ': 'Another Me (KALPA)',
    'Another Me': 'Another Me (Rising Sun Traxx)',
    'Re_Nascence (Psystyle Ver.) ': 'Re_Nascence (Psystyle Ver.)',
    'Energy Synergy Matrix': 'ENERGY SYNERGY MATRIX',
    'Le temps perdu-': 'Le temps perdu',
}

export default new class getInfo {



    /**
     * @typedef csvDifObject
     * @property {idStringWithout0} id 曲目id
     * @property {string} EZ EZ难度
     * @property {string} HD HD难度
     * @property {string} IN IN难度
     * @property {string} [AT] AT难度
     */

    /**
     * @typedef {Object} updatedChartObject
     * @property {number|number[]|undefined} tap
     * @property {number|number[]|undefined} drag
     * @property {number|number[]|undefined} hold
     * @property {number|number[]|undefined} flick
     * @property {number|number[]|undefined} difficulty
     * @property {number|number[]|undefined} combo
     * @property {boolean|undefined} isNew
     */

    /**
     * @typedef {object} versionInfoObject
     * @property {string} version_label 版本号
     * @property {number} update_date 版本更新时间戳(秒)
     * @property {string} whatsnew 版本更新内容
     * @property {number} version_code 版本号（整数）
     * @property {string} version 版本号（整数）字符版
     * 
     */

    /**
     * @typedef {{[versionCode: string]: Record<idString, csvDifObject>}} historyDifficultyByVersionObject
     */

    /**
     * @typedef {Record<idString, {[versionCode: string]: Record<levelKind, number>}>} historyDifficultyBySongIdObject
     */

    /**
     * @typedef {string & { readonly brand: unique symbol }} kongYouId 空游的id
     * 
     * @typedef {Object} kongYouSongListObject
     * @property {idString} id 曲目id
     * @property {kongYouId} kyId 空游id
     * @property {object} videoLink 攻略链接
     * @property {string} videoLink.ez EZ难度攻略链接
     * @property {string} videoLink.hd HD难度攻略链接
     * @property {string} videoLink.in IN难度攻略链接
     * @property {string} videoLink.at AT难度攻略链接
     */

    constructor() {
        /**
         * 难度映射
         * @type {allLevelKind[]}
         */
        this.allLevel = allLevel

        /**
         * 难度映射
         * @type {levelKind[]}
         */
        this.Level = Level

        /**
         * @type {string[]}
         * @description Tips
         */
        this.tips = []


        /**
         * @type {{[key:idString]:Partial<SongsInfo> | undefined}}
         * @description 原版信息
         */
        this.ori_info = {}
        /**
         * @type {{[key:idString]:songString}}
         * @description 通过id获取曲名
         */
        this.songsid = {}
        /**
         * @type {{[key:songString]:idString}}
         * @description 原曲名称获取id
         */
        this.idssong = {}
        /**
         * @type {idString[]}
         * @description 含有曲绘的曲目列表，id名称
         */
        this.illlist = []

        /**
         * @type {{[key:string]: string[]}}
         * @description 章节别名，以别名为key，内容为章节名
         */
        this.chapNick = {}

        /**
         * 按dif分的info
         * @type {Record<string, Chart[]>}
         */
        this.info_by_difficulty = {}


        /**
         * @type {idString[]}
         */
        this.updatedSong = []


        /**
         * @type {Record<idString, Partial<Record<levelKind, updatedChartObject>>>}
         */
        this.updatedChart = {}

        /** @type {{[versionLabel: string]: versionInfoObject}} */
        this.versionInfoByLabel = {}

        /** @type {{[versionCode: string]: versionInfoObject}} */
        this.versionInfoByCode = {}

        /** @type {historyDifficultyByVersionObject} */
        this.historyDifficultyByVersion = {}

        /** @type {historyDifficultyBySongIdObject} */
        this.historyDifficultyBySongId = {}

        /** @type {Record<string, Record<string, {id: idString, rank: levelKind, difficulty: number}[]>>} */
        this.historyDifficultyByVerDifficulty = {}

        /**@type {{title: string, code: number, content: string[]}} */
        this.noticeJson = { title: '', code: 0, content: [] }

        /**@type {Save | null} */
        this.badSave = null;


        this.kongYouData = {
            timeStamp: 0,
            songList: [],
            tagsTree: [],
            tagsTop: {},
        }

        this.initIng = false
        this.reinitRequested = false

        if (Config.getUserCfg('config', 'watchInfoPath')) {
            this.infoWatcher = fileWatcherRegistry.watch('info:directory', infoPath, () => {
                void this.init().catch(err => logger.error('[phi-plugin]热更新曲目信息失败', err))
            });
        } else {
            void fileWatcherRegistry.close('info:directory')
        }
    }

    async init() {

        if (this.initIng) {
            this.reinitRequested = true
            return
        }
        this.initIng = true
        this.reinitRequested = false

        try {
            logger.info(`[phi-plugin]初始化曲目信息`)


        this.allLevel = allLevel;
        this.Level = Level;
        this.tips = [];
        this.ori_info = {};
        this.songsid = {};
        this.idssong = {};
        this.illlist = [];
        this.chapNick = {};
        this.info_by_difficulty = {};
        this.updatedSong = [];
        this.updatedChart = {};
        this.versionInfoByLabel = {};
        this.versionInfoByCode = {};
        this.historyDifficultyByVersion = {};
        this.historyDifficultyBySongId = {};
        this.noticeJson = readFile.FileReader(path.join(infoPath, 'notice.json'));
        this.badSave = await readFile.FileReader(path.join(pluginResources, '0608badSave', 'save.json'));


        /**
         * @type {Record<string, string[]>}
         * @description 扩增曲目信息
         **/
        this.DLC_Info = {}
        const files = fs.readdirSync(DlcInfoPath).filter(file => file.endsWith('.json'))
        for (const file of files) {
            this.DLC_Info[path.basename(file, '.json')] = await readFile.FileReader(path.join(DlcInfoPath, file))
        }

        /**
         * @type {string[]}
         * @description 头像id
         */
        this.avatarid = readFile.FileReader(path.join(infoPath, 'avatar.txt')).replace(/\r/g, '').split('\n')

        /**
         * @type {string[]}
         * @description Tips
         */
        this.tips = await readFile.FileReader(path.join(infoPath, 'tips.txt')).replace(/\r/g, '').split('\n')

        /**自定义信息 */
        const user_song = Config.getUserCfg('config', 'otherinfo')
        if (Config.getUserCfg('config', 'otherinfo')) {
            for (const i in user_song) {
                if (user_song[i]['illustration_big']) {
                    this.illlist.push(user_song[i].song)
                }
            }
        }

        /**
         * @type {Record<idString, SongsInfo>}
         * @description SP信息
         */
        const sp_json = (await readFile.FileReader(path.join(infoPath, 'spinfo.json')))

        /**
         * @type {Record<idString, SongsInfo>}
         * @description SP信息
         */
        this.sp_info = {}

        for (const i of fCompute.objectKeys(sp_json)) {
            const id = /** @type {idString} */(i + '.0');
            this.sp_info[id] = { ...sp_json[i] }
            this.sp_info[id].sp_vis = true
            this.sp_info[id].id = id
            this.idssong[/** @type {songString} */ (/** @type {unknown} */ (i))] = id
            this.idssong[this.sp_info[id].song] = id
            if (this.sp_info[id]?.illustration) {
                this.illlist.push(this.sp_info[id].id)
            }
        }

        /**最高定数 */
        this.MAX_DIFFICULTY = 0

        /**
         * 所有曲目曲名列表
         * @type {songString[]}
         */
        this.songlist = []

        /**
         * 曲目id列表
         * @type {idString[]}
         */
        this.idList = []

        /**
         * @typedef {Object} notesInfoObject
         * @property {number} m MaxTime
         * @property {[tap: number, drag: number, hold: number, flick: number, tot: number][]} d note分布 [tap,drag,hold,flick,tot]
         * @property {[number,number,number,number]} t note统计 [tap,drag,hold,flick]
         */
        /**
         * note统计
         * @type {{[x:idStringWithout0]:Record<levelKind, notesInfoObject>}}
         */
        const notesInfo = await readFile.FileReader(path.join(infoPath, 'notesInfo.json'))


        const historyVersionList = fs.readdirSync(oldInfoPath)

        /**@type {csvDifObject[]} */
        let oldDif = /**@type {any} */({})

        let versionCodes = historyVersionList.map(ver => Number(ver))

        versionCodes = versionCodes.sort((a, b) => a - b)

        const lastVersionCode = versionCodes[versionCodes.length - 2].toFixed(0)

        for (const ver of historyVersionList) {
            /**@type {versionInfoObject} */
            const verInfo = await readFile.FileReader(path.join(oldInfoPath, ver, 'info.json'))
            /**@type {csvDifObject[]} */
            const csvDifInfo = await readFile.FileReader(path.join(oldInfoPath, ver, 'change.csv'))
            /**@type {Record<idString, csvDifObject>} */
            const difInfo = {}

            if (ver == lastVersionCode) {
                oldDif = csvDifInfo
            }

            csvDifInfo.forEach(item => {
                difInfo[idWithout0ToIdWith0(item.id)] = item
            })
            this.versionInfoByCode[ver] = verInfo
            this.versionInfoByLabel[verInfo.version_label] = verInfo

            this.historyDifficultyByVersion[ver] = difInfo

            this.historyDifficultyByVerDifficulty[ver] = {}

            const ids = fCompute.objectKeys(difInfo)

            for (const id of ids) {
                /** @type {Record<levelKind, number>} */
                const dif = /** @type {any} */ ({})
                Level.forEach(level => {
                    if (!difInfo[id][level]) return;
                    const songDif = Number(difInfo[id][level]);
                    dif[level] = songDif;
                    if (!this.historyDifficultyByVerDifficulty[ver][songDif.toFixed(1)]) {
                        this.historyDifficultyByVerDifficulty[ver][songDif.toFixed(1)] = []
                    }
                    this.historyDifficultyByVerDifficulty[ver][songDif.toFixed(1)].push({
                        id: id,
                        rank: level,
                        difficulty: songDif
                    })
                })
                if (!this.historyDifficultyBySongId[id]) {
                    this.historyDifficultyBySongId[id] = {}
                    this.historyDifficultyBySongId[id][ver] = dif
                } else {
                    this.historyDifficultyBySongId[id][ver] = dif
                }
            }

        }

        /**
         * @typedef {Object} csvInfoObject
         * @property {idStringWithout0} id 曲目id
         * @property {songString} song 曲目名称
         * @property {string} composer 作曲
         * @property {string} illustrator 插画师
         * @property {string} EZ EZ难度定数
         * @property {string} HD HD难度定数
         * @property {string} IN IN难度定数
         * @property {string|undefined} AT AT难度定数
         * @property {string} EZC EZ难度谱师
         * @property {string} HDC HD难度谱师
         * @property {string} INC IN难度谱师
         * @property {string|undefined} ATC AT难度谱师
         */
        /**
         * 信息文件
         * @type {csvInfoObject[]}
         */
        const CsvInfo = await readFile.FileReader(path.join(infoPath, 'info.csv'))
        const Jsoninfo = await readFile.FileReader(path.join(infoPath, 'infolist.json'))

        /**
         * note统计
         * @type {{[x:idStringWithout0]:Record<levelKind, notesInfoObject>}}
         */
        const oldNotes = await readFile.FileReader(path.join(infoPath, 'oldNotesInfo.json'))
        /**
         * @type {Record<idStringWithout0, Partial<Record<levelKind, number>>>}
         */
        const OldDifList = {}
        for (const i in oldDif) {
            OldDifList[oldDif[i].id] = {}
            for (const level of this.Level) {
                if (oldDif[i][level]) {
                    OldDifList[oldDif[i].id][level] = Number(oldDif[i][level])
                }
            }
        }


        for (let i = 0; i < CsvInfo.length; i++) {

            const id = /**@type {idString} */(CsvInfo[i].id + '.0')
            const idWithout0 = CsvInfo[i].id

            /**比较新曲部分 */
            if (!OldDifList[idWithout0]) {
                this.updatedSong.push(id)
            }

            switch (idWithout0) {
                case 'AnotherMe.DAAN': {
                    CsvInfo[i].song = /** @type {songString} */('Another Me (KALPA)');
                    break;
                }
                case 'AnotherMe.NeutralMoon': {
                    CsvInfo[i].song = /** @type {songString} */('Another Me (Rising Sun Traxx)');
                    break;
                }
                default: {
                    break;
                }
            }


            this.songsid[id] = CsvInfo[i].song
            this.idssong[CsvInfo[i].song] = id

            this.ori_info[id] = { ...Jsoninfo[CsvInfo[i].id] }
            if (!this.ori_info[id]) {
                this.ori_info[id] = { chapter: '', bpm: '', length: '' }
                logger.mark(`[phi-plugin]曲目详情未更新：${id}`)
            }

            this.ori_info[id].id = id
            this.ori_info[id].song = CsvInfo[i].song
            this.ori_info[id].composer = CsvInfo[i].composer
            this.ori_info[id].illustrator = CsvInfo[i].illustrator
            this.ori_info[id].chart = {}
            for (const level of this.Level) {

                if (CsvInfo[i][level]) {

                    if (!this.ori_info[id].chart) {
                        this.ori_info[id].chart = {}
                    }

                    this.ori_info[id].chart[level] = {
                        id: id,
                        rank: level,
                        charter: CsvInfo[i][/**@type {levelKind} */(level + "C")] || '',
                        difficulty: Number(CsvInfo[i][level]),
                        tap: notesInfo[idWithout0][level].t[0],
                        drag: notesInfo[idWithout0][level].t[1],
                        hold: notesInfo[idWithout0][level].t[2],
                        flick: notesInfo[idWithout0][level].t[3],
                        combo: notesInfo[idWithout0][level].t[0] + notesInfo[idWithout0][level].t[1] + notesInfo[idWithout0][level].t[2] + notesInfo[idWithout0][level].t[3],
                        maxTime: notesInfo[idWithout0][level].m,
                        distribution: notesInfo[idWithout0][level].d
                    }

                    /**比较新曲部分 */
                    if (OldDifList[idWithout0]) {
                        if (!OldDifList[idWithout0][level] || OldDifList[idWithout0][level] != this.ori_info[id].chart[level].difficulty || JSON.stringify(oldNotes[idWithout0][level].t) != JSON.stringify(notesInfo[idWithout0][level].t)) {
                            /**
                             * @type {updatedChartObject}
                             */
                            const tem = {
                                tap: undefined,
                                drag: undefined,
                                hold: undefined,
                                flick: undefined,
                                difficulty: undefined,
                                combo: undefined,
                                isNew: undefined
                            }
                            if (!OldDifList[CsvInfo[i].id][level]) {
                                Object.assign(tem, {
                                    tap: notesInfo[idWithout0][level].t[0],
                                    drag: notesInfo[idWithout0][level].t[1],
                                    hold: notesInfo[idWithout0][level].t[2],
                                    flick: notesInfo[idWithout0][level].t[3],
                                    difficulty: this.ori_info[id].chart[level].difficulty,
                                    combo: notesInfo[idWithout0][level].t[0] + notesInfo[idWithout0][level].t[1] + notesInfo[idWithout0][level].t[2] + notesInfo[idWithout0][level].t[3],
                                    isNew: true
                                })
                            } else {
                                if (OldDifList[idWithout0][level] != this.ori_info[id].chart[level].difficulty) {
                                    Object.assign(tem, { difficulty: [OldDifList[idWithout0][level], this.ori_info[id].chart[level].difficulty] })
                                }
                                if (oldNotes[idWithout0][level].t[0] != notesInfo[idWithout0][level].t[0]) {
                                    Object.assign(tem, { tap: [oldNotes[idWithout0][level].t[0], notesInfo[idWithout0][level].t[0]] })
                                }
                                if (oldNotes[idWithout0][level].t[1] != notesInfo[idWithout0][level].t[1]) {
                                    Object.assign(tem, { drag: [oldNotes[idWithout0][level].t[1], notesInfo[idWithout0][level].t[1]] })
                                }
                                if (oldNotes[idWithout0][level].t[2] != notesInfo[idWithout0][level].t[2]) {
                                    Object.assign(tem, { hold: [oldNotes[idWithout0][level].t[2], notesInfo[idWithout0][level].t[2]] })
                                }
                                if (oldNotes[idWithout0][level].t[3] != notesInfo[idWithout0][level].t[3]) {
                                    Object.assign(tem, { flick: [oldNotes[idWithout0][level].t[3], notesInfo[idWithout0][level].t[3]] })
                                }
                                const oldCombo = oldNotes[idWithout0][level].t[0] + oldNotes[idWithout0][level].t[1] + oldNotes[idWithout0][level].t[2] + oldNotes[idWithout0][level].t[3]
                                const newCombo = notesInfo[idWithout0][level].t[0] + notesInfo[idWithout0][level].t[1] + notesInfo[idWithout0][level].t[2] + notesInfo[idWithout0][level].t[3]
                                if (oldCombo != newCombo) {
                                    Object.assign(tem, { combo: [oldCombo, newCombo] })
                                }
                            }
                            if (!this.updatedChart[id]) {
                                this.updatedChart[id] = {}
                            }
                            this.updatedChart[id][level] = tem
                        }
                    }


                    /**最高定数 */
                    this.MAX_DIFFICULTY = Math.max(this.MAX_DIFFICULTY, this.ori_info[id].chart[level].difficulty)
                }
            }
            if (Jsoninfo[idWithout0]?.chart) {
                this.ori_info[id].chart = { ...this.ori_info[id].chart, ...Jsoninfo[idWithout0].chart }
            }
            this.illlist.push(id)
            this.songlist.push(this.ori_info[id].song)
            this.idList.push(id)
        }


        if (this.MAX_DIFFICULTY != MAX_DIFFICULTY) {
            console.error('[phi-plugin] MAX_DIFFICULTY 常量未更新，请回报作者！', MAX_DIFFICULTY, this.MAX_DIFFICULTY)
        }

        /**
         * 曲目别名列表 (id不带.0)
         * @type {Record<idStringWithout0, string[]>}
         */
        const nicklistTemp = await readFile.FileReader(path.join(infoPath, 'nicklist.yaml')) || {}
        this.baseNicklist = /** @type {Record<idStringWithout0, string[]>} */ (structuredClone(nicklistTemp))
        this.approvedNicklist = /** @type {Record<idStringWithout0, string[]>} */ (
            await readFile.FileReader(path.join(dataPath, 'alias', 'approved-nicklist.yaml')) || {}
        )
        /** 
         * 默认别名，以id为key
         * @type {Record<idString, string[]>} 
         **/
        this.nicklist = {}
        /**
         * 以别名为key
         * @type {Record<string, idString[]>}
         */
        this.songnick = {}


        this.rebuildAliasIndex()

        /**
         * @type {{[key:string]: string[]}}
         * @description 章节列表，以章节名为key，内容为别名
         */
        this.chapList = await readFile.FileReader(path.join(infoPath, 'chaplist.yaml'))

        for (const i in this.chapList) {
            for (const item of this.chapList[i]) {
                if (this.chapNick[item]) {
                    this.chapNick[item].push(i)
                } else {
                    this.chapNick[item] = [i]
                }
            }
        }

        /**
         * jrrp
         * @type {Record<'good'|'bad'|'common', string[]>}
         */
        this.word = await readFile.FileReader(path.join(infoPath, 'jrrp.json'))

        for (const songId of this.idList) {
            for (const level of this.allLevel) {
                const info = this.ori_info[songId]
                if (!info?.chart?.[level]?.difficulty) continue;
                const difStr = info.chart[level].difficulty.toFixed(1);
                if (this.info_by_difficulty[difStr]) {
                    this.info_by_difficulty[difStr].push({
                        ...info.chart[level],
                    })
                } else {
                    this.info_by_difficulty[difStr] = [{
                        ...info.chart[level],
                    }]
                }
            }
        }



            logger.info(`[phi-plugin]初始化曲目信息完成`)
        } finally {
            this.initIng = false
            if (this.reinitRequested) {
                this.reinitRequested = false
                queueMicrotask(() => {
                    void this.init().catch(err => logger.error('[phi-plugin]补跑曲目信息初始化失败', err))
                })
            }
        }
    }

    /** 关闭曲库目录监听器。 */
    async close() {
        const watcherLease = this.infoWatcher
        this.infoWatcher = undefined
        if (watcherLease) await watcherLease.close()
    }

    /**
     * 以“内置别名 + Approved 快照”的顺序重建运行时索引。
     * 同一曲目的重复别名按不区分大小写去重，远端快照删除后不会残留。
     * @returns {void}
     */
    rebuildAliasIndex() {
        this.nicklist = {}
        this.songnick = {}
        /** @type {Array<Record<idStringWithout0, string[]>>} */
        const layers = [this.baseNicklist || {}, this.approvedNicklist || {}]
        for (const layer of layers) {
            for (const rawId of Object.keys(layer)) {
                const idWithout0 = /** @type {idStringWithout0} */ (rawId)
                const id = idWithout0ToIdWith0(idWithout0)
                const aliases = Array.isArray(layer[idWithout0]) ? layer[idWithout0] : []
                this.nicklist[id] ||= []
                for (const rawAlias of aliases) {
                    const alias = String(rawAlias).trim()
                    if (!alias) continue
                    if (!this.nicklist[id].some(item => item.toLowerCase() === alias.toLowerCase())) {
                        this.nicklist[id].push(alias)
                    }
                    this.songnick[alias] ||= []
                    if (!this.songnick[alias].includes(id)) this.songnick[alias].push(id)
                }
            }
        }
    }

    /**
     * 原子快照落盘成功后替换 Approved 内存层并立即重建索引。
     * @param {Record<string, string[]>} snapshot 已严格校验的公开 YAML 数据
     * @returns {void}
     */
    setApprovedAliasSnapshot(snapshot) {
        this.approvedNicklist = /** @type {Record<idStringWithout0, string[]>} */ (structuredClone(snapshot || {}))
        this.rebuildAliasIndex()
    }

    /**
     * 
     * @param {idString} id 原曲曲名
     * @param {boolean} [original=false] 仅使用原版
     * @returns {SongsInfo | undefined} 曲目信息对象
     */
    info(id, original = false) {
        let result
        switch (original ? 0 : Config.getUserCfg('config', 'otherinfo')) {
            case 0: {
                result = { ...this.ori_info, ...this.sp_info }
                break;
            }
            case 1: {
                result = { ...this.ori_info, ...this.sp_info, ...Config.getUserCfg('otherinfo') }
                break;
            }
            case 2: {
                result = Config.getUserCfg('otherinfo')
                break;
            }
        }
        return result[id] ? new SongsInfo(result[id]) : undefined
    }

    /**
     * 
     * @param {boolean} [original=false] 仅使用原版
     * @returns {Record<idString, SongsInfo>} 所有曲目信息对象
     */
    all_info(original = false) {
        switch (original ? 0 : Config.getUserCfg('config', 'otherinfo')) {
            case 0: {
                return { ...this.ori_info, ...this.sp_info }
            }
            case 1: {
                return { ...this.ori_info, ...this.sp_info, ...Config.getUserCfg('otherinfo') }
            }
            case 2: {
                return Config.getUserCfg('otherinfo')
            }
            default: {
                return { ...this.ori_info, ...this.sp_info }
            }
        }
    }

    /**
    * 根据参数模糊匹配返回原曲名称
    * @param {string} mic 别名
    * @param {number} [Distance=0.85] 阈值 猜词0.95
    * @param {boolean} [original=false] 仅使用原版
    * @returns {idString[]} 原曲id数组，按照匹配程度降序
    */
    fuzzysongsnick(mic, Distance = 0.85, original = false) {
        /**为空返回空 */
        if (!mic) return []
        /**
         * 按照匹配程度排序
         * @type {{id: idString, dis: number}[]}
         */
        let result = []

        const usernick = Config.getUserCfg('nickconfig')
        const allinfo = this.all_info(original)

        for (const std in this.songnick) {
            const dis = fCompute.jaroWinklerDistance(mic, std)
            if (dis >= Distance) {
                for (const i in this.songnick[std]) {
                    result.push({ id: this.songnick[std][i], dis: dis })
                }
            }
        }

        const ids = fCompute.objectKeys(allinfo);
        for (const std of ids) {
            let dis = fCompute.jaroWinklerDistance(mic, std)
            if (dis >= Distance) {
                result.push({ id: allinfo[std].id, dis: dis })
            }
            if (!allinfo[std]?.id) continue
            dis = fCompute.jaroWinklerDistance(mic, allinfo[std].song)
            if (dis >= Distance) {
                result.push({ id: allinfo[std].id, dis: dis })
            }
        }



        for (const std in usernick) {
            const dis = fCompute.jaroWinklerDistance(mic, std)
            if (dis >= Distance) {
                usernick[std].forEach((id, i) => {
                    if (this.info(id) == undefined) return; //过滤无效id
                    result.push({ id: usernick[std][i], dis: dis })
                })
            }
        }


        result = result.sort((a, b) => b.dis - a.dis)

        /**
         * @type {idString[]}
         */
        const all = []
        for (const i of result) {

            if (all.includes(i.id)) continue //去重
            /**如果有完全匹配的曲目则放弃剩下的 */
            if (result[0].dis == 1 && i.dis < 1) break


            all.push(i.id)
        }

        return all
    }

    /**
     * 设置别名
     * @param {string} mic 原名
     * @param {string} nick 别名
     */
    async setnick(mic, nick) {
        if (!Config.getUserCfg('nickconfig', mic)) {
            Config.modify('nickconfig', nick, [mic])
        } else {
            Config.modifyarr('nickconfig', nick, mic, 'add')
        }
    }

    /** @param {'ill'|'illBlur'|'illLow'|'SP'|'chartimg'|'table'|'chap'} type @param {...string} parts */
    getResourceIllustration(type, ...parts) {
        return illustrationReference(type, ...parts)
    }

    /** @param {idString} id @param {'common'|'blur'|'low'} [kind] */
    getill(id, kind = 'common') {
        const song = this.all_info()[id]
        const custom = Config.getUserCfg('config', 'otherinfo') ? Config.getUserCfg('otherinfo')?.[id]?.illustration : undefined
        if (custom) {
            if (/^https?:\/\//i.test(custom)) return custom
            const local = path.resolve(ortherIllPath, custom)
            if (local.startsWith(path.resolve(ortherIllPath) + path.sep) && fs.existsSync(local)) return local
        }
        const filename = String(song?.id || id || '').replace(/\.0$/, '') + '.png'
        if (this.ori_info?.[id]) {
            const directory = /** @type {const} */ ({ common: 'ill', blur: 'illBlur', low: 'illLow' })
            return this.getResourceIllustration(directory[kind] || 'ill', filename)
        }
        if (this.sp_info?.[id]) return this.getResourceIllustration('SP', filename)
        return path.join(imgPath, 'phigros.png')
    }

    /**
     * 按版本号（如 3.10.0）或版本代码查找历史定数版本
     * @param {string | number} version
     * @returns {versionInfoObject | undefined}
     */
    findVersion(version) {
        const key = String(version)
        return key.includes('.') ? this.versionInfoByLabel[key] : this.versionInfoByCode[key]
    }

    /**
     * 曲目在存档 user.background 中的写法（个别曲目与曲名不同）
     * @param {idString} id
     * @returns {string | undefined}
     */
    backgroundName(id) {
        const song = this.info(id, true)?.song
        if (!song) return undefined
        return Object.keys(SAVE_BACKGROUND_ALIASES).find(key => SAVE_BACKGROUND_ALIASES[key] === song) || song
    }

    /**
     * 随机选一张曲绘作为背景
     * @param {'common'|'blur'|'low'} [kind]
     */
    randomBackground(kind = 'common') {
        return this.getill(this.illlist[Math.floor(Math.random() * this.illlist.length)], kind)
    }

    /** @param {idString} songId @param {levelKind} dif */
    getChartImg(songId, dif) {
        return this.getResourceIllustration('chartimg', dif, songId.replace(/\.0$/, '') + '.png')
    }

    /** @param {number} dif */
    getTableImg(dif) {
        return this.getResourceIllustration('table', `${dif}.png`)
    }

    /** @param {string} name */
    getChapIll(name) {
        return this.getResourceIllustration('chap', `${name}.png`)
    }

    /**
     * 通过id获得头像文件名称
     * @param {string} id 
     * @returns file name
     */
    idgetavatar(id) {
        if (this.avatarid?.includes(id)) {
            if (id == "Cipher : /2&//<|0") {
                return "Cipher1"
            }
            if (id == "Oblivion: PHIN") {
                return "OblivionPHIN"
            }
            return id
        } else {
            return 'Introduction'
        }
    }

    /**
     * 根据曲目id获取原名
     * @param {idString} id 曲目id
     * @returns {songString | undefined} 原名
     */
    idgetsong(id) {
        return this.songsid?.[id]
    }

    /**
     * 通过原曲曲目获取曲目id
     * @param {songString} song 原曲曲名
     * @returns {idString | undefined} 曲目id
     */
    SongGetId(song) {
        return this.idssong?.[song]
    }

    /**
     * 获取角色介绍背景曲绘
     * @param {string} save_background 
     * @returns 
     */
    getBackground(save_background) {
        try {
            if (Object.hasOwn(SAVE_BACKGROUND_ALIASES, save_background)) save_background = SAVE_BACKGROUND_ALIASES[save_background]
            // @ts-ignore
            return this.getill(this.SongGetId(save_background) || save_background)
        } catch (err) {
            logger.error(`获取背景曲绘错误`, err)
            return 'Introduction';
        }
    }

}()

/**
 * 
 * @param {idStringWithout0} idWithout0 
 * @returns {idString}
 */
function idWithout0ToIdWith0(idWithout0) {
    return /** @type {idString} */(idWithout0 + '.0')
}
