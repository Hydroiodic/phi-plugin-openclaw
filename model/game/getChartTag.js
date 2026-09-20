import getFile from '../filesystem/getFile.js'
import path from 'node:path'
import { otherDataPath } from '../filesystem/path.js'

/** @typedef {{agree:string[],disagree:string[]}} ChartTagVote */

export class ChartTagStore {
    /** @param {string} [filePath] */
    constructor(filePath = path.join(otherDataPath, 'chartTagData.json')) {
        this.filePath = filePath
        /** @type {Record<string, Record<string, Record<string, ChartTagVote>>>} */
        this.data = getFile.FileReader(filePath) || {}
    }

    /** @param {string} id @param {string} rank @param {string} tag */
    vote(id, rank, tag) {
        const song = Object.hasOwn(this.data, id) ? this.data[id] : undefined
        const chart = song && Object.hasOwn(song, rank) ? song[rank] : undefined
        return chart && Object.hasOwn(chart, tag) ? chart[tag] : undefined
    }

    /** @param {idString} songId @param {levelKind} rank @param {boolean} [all] */
    get(songId, rank, all = false) {
        const song = Object.hasOwn(this.data, songId) ? this.data[songId] : undefined
        const chart = song && Object.hasOwn(song, rank) ? song[rank] : undefined
        return Object.entries(chart || {}).map(([name, vote]) => ({
            name, value: (vote.agree?.length || 0) - (vote.disagree?.length || 0),
        })).filter(vote => all || vote.value > 0)
    }

    /** @param {idString} id @param {string} tag @param {levelKind} rank @param {string} userId @param {boolean | undefined} agree */
    update(id, tag, rank, userId, agree) {
        if (!id || !tag || !userId || !['EZ', 'HD', 'IN', 'AT', 'Legacy'].includes(rank)) return false
        const old = this.vote(id, rank, tag)
        const vote = {
            agree: (old?.agree || []).filter(value => value !== userId),
            disagree: (old?.disagree || []).filter(value => value !== userId),
        }
        if (agree === true) vote.agree.push(userId)
        if (agree === false) vote.disagree.push(userId)
        const song = Object.hasOwn(this.data, id) ? this.data[id] : {}
        const chart = Object.hasOwn(song, rank) ? song[rank] : {}
        const nextChart = { ...chart }
        if (vote.agree.length || vote.disagree.length) Object.defineProperty(nextChart, tag, { value: vote, enumerable: true, configurable: true })
        else delete nextChart[tag]
        const next = { ...this.data, [id]: { ...song, [rank]: nextChart } }
        if (!getFile.SetFile(this.filePath, next)) return false
        this.data = next
        return true
    }

    /** @param {idString} id @param {string} tag @param {levelKind} rank @param {boolean} agree @param {string} userId */
    add(id, tag, rank, agree, userId) { return this.update(id, tag, rank, userId, agree) }

    /** @param {idString} id @param {string} tag @param {levelKind} rank @param {string} userId */
    cancel(id, tag, rank, userId) { return this.update(id, tag, rank, userId, undefined) }
}

export default new ChartTagStore()
