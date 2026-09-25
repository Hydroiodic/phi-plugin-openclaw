import Config from '../../components/Config.js'
import logger from '../../components/Logger.js'
/** @import LevelRecordInfo from './LevelRecordInfo.js' */
import { MAX_DIFFICULTY } from './constNum.js'
import getInfo from './getInfo.js'
import platform from '../../components/platform/index.js'

/**
 * Unity 富文本标签（已做 HTML 转义后的形式）及其 HTML 渲染方式
 * @type {[RegExp, (inner: string, attr: string) => string][]}
 */
const RICH_TEXT_RULES = [
    [/&lt;color\s*=\s*(?<attr>.*?)&gt;(?<inner>.*?)&lt;\/color&gt;/, (inner, color) => `<span style="color:${cssColor(color)}">${inner}</span>`],
    [/&lt;size\s*=\s*.*?&gt;(?<inner>.*?)&lt;\/size&gt;/, inner => inner],
    [/&lt;i&gt;(?<inner>.*?)&lt;\/i&gt;/, inner => `<i>${inner}</i>`],
    [/&lt;b&gt;(?<inner>.*?)&lt;\/b&gt;/, inner => `<b>${inner}</b>`],
]

/**
 * 只接受颜色名或十六进制色值，避免玩家在 style 属性里注入其他 CSS
 * @param {string} value
 */
function cssColor(value) {
    const color = value.replace(/["'\s]/g, '')
    return /^(#[\da-f]{3,8}|[a-z]+)$/i.test(color) ? color : 'inherit'
}

export default class fCompute {
    /**
     * 计算等效rks
     * @param {number} acc 
     * @param {number} difficulty 
     * @returns 
     */
    static rks(acc, difficulty) {
        if (acc == 100) {
            /**满分原曲定数即为有效rks */
            return Number(difficulty)
        } else if (acc < 70) {
            /**无效acc */
            return 0
        } else {
            /**非满分计算公式 [(((acc - 55) / 45) ^ 2) * 原曲定数] */
            return difficulty * (((acc - 55) / 45) * ((acc - 55) / 45))
        }
    }

    /**
     * @overload
     * @param {number} rks 目标rks
     * @param {number} difficulty 定数
     * @param {number} count 保留位数
     * @returns {string}
     */
    /**
     * @overload
     * @param {number} rks 目标rks
     * @param {number} difficulty 定数
     * @param {undefined} [count=undefined] 保留位数
     * @returns {number}
     */
    /**
     * 计算所需acc
     * @param {number} rks 目标rks
     * @param {number} difficulty 定数
     * @param {number | undefined} [count=undefined] 保留位数
     * @returns 所需acc
     */
    static suggest(rks, difficulty, count = undefined) {
        const ans = 45 * Math.sqrt(rks / difficulty) + 55

        if (ans >= 100)
            if (count != undefined) {
                return "无法推分"
            } else {
                return -1;
            }
        else {
            if (count != undefined) {
                return `${ans.toFixed(count)}%`
            } else {
                return ans
            }
        }
    }

    /**
     * 发送文件
     * @param {*} e 
     * @param {string | Buffer} file
     * @param {string} filename 
     */
    static async sendFile(e, file, filename) {
        try {
            await platform.uploadFile(e, file, filename)

        } catch (err) {
            // @ts-ignore
            logger.error(`文件上传错误：${logger.red(err.stack)}`)
            console.error(err)
            // @ts-ignore
            await platform.reply(e, `文件上传错误：${err.stack}`)
        }
    }

    /**
     * 获取角色介绍背景曲绘
     * @param {string} save_background 
     * @returns 
     */
    static getBackground(save_background) {
        try {
            return getInfo.getBackground(save_background)
        } catch (err) {
            logger.error(`获取背景曲绘错误`, err)
            return false
        }
    }

    /**
     * 为数字添加前导零
     * @param {number} num 原数字
     * @param {number} cover 总位数
     * @returns 前导零数字
     */
    static ped(num, cover) {
        return num.toString().padStart(cover, '0')
    }

    /**
     * 标准化分数
     * @param {number} score 分数
     * @returns 标准化的分数 0'000'000
     */
    static std_score(score) {
        const s1 = Math.floor(score / 1e6)
        const s2 = Math.floor(score / 1e3) % 1e3
        const s3 = score % 1e3
        return `${s1}'${this.ped(s2, 3)}'${this.ped(s3, 3)}`
    }

    /**
     * 随机数，包含上下界
     * @param {number} min 最小值
     * @param {number} max 最大值
     * @returns 随机数
     */
    static randInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1) + min)
    }

    /**
     * 随机数，不包含上界
     * @param {number} min 最小值
     * @param {number} max 最大值
     * @param {number} [precision=4] 小数位数
     * @returns 随机数
     */
    static randFloatBetween(min, max, precision = 4) {
        return Math.floor((Math.random() * (max - min) + min) * (10 ** precision)) / (10 ** precision)
    }

    /**
     * 随机打乱数组
     * @template T
     * @param {T[]} arr 原数组
     * @returns {T[]} 返回传入类型的数组
     */
    static randArray(arr) {
        const newArr = [...arr]
        // Fisher-Yates：sort 配随机比较器得到的排列并不均匀
        for (let i = newArr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[newArr[i], newArr[j]] = [newArr[j], newArr[i]]
        }
        return newArr
    }

    /**
     * 转换时间格式
     * @param {Date|string|number} [date] 时间
     * @param {string} [formater='YYYY/MM/DD hh:mm:ss'] 格式
     * @returns 2020/10/08 10:08:08
     */
    static formatDate(date, formater = 'YYYY/MM/DD hh:mm:ss') {
        if (!date) {
            date = new Date()
        }
        date = new Date(date)

        const month = (date.getMonth() + 1).toString().padStart(2, '0')
        const day = date.getDate().toString().padStart(2, '0')
        const hours = date.getHours().toString().padStart(2, '0')
        const minutes = date.getMinutes().toString().padStart(2, '0')
        const seconds = date.getSeconds().toString().padStart(2, '0')

        return formater.replace('YYYY', `${date.getFullYear()}`)
            .replace('MM', month)
            .replace('DD', day)
            .replace('hh', hours)
            .replace('mm', minutes)
            .replace('ss', seconds)
    }

    /**
     * 转换时间格式
     * @param {Date|string|number} date 时间
     * @returns {string} -100d
     */
    static formatDateToNow(date) {
        return `-${((new Date().getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000)).toFixed(0)}d`;
    }

    /**
     * 转换unity富文本
     * @param {string} richText 
     * @param {boolean} [onlyText=false] 是否只返回文本
     * @returns 
     */
    static convertRichText(richText, onlyText = false) {
        if (!richText) {
            return richText
        }
        let text = richText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        // 每轮替换掉一个标签；替换结果里没有转义后的尖括号，所以一定会结束
        for (;;) {
            const rule = RICH_TEXT_RULES.find(([reg]) => reg.test(text))
            if (!rule) break
            const [reg, render] = rule
            text = text.replace(reg, (...args) => {
                const { inner, attr } = args[args.length - 1]
                return onlyText ? inner : render(inner, attr)
            })
        }
        if (onlyText) return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        return text.replace(/\r?\n/g, '<br>')
    }

    /**
     * 是否是管理员
     * @param {any} e
     */
    static is_admin(e) {
        if (e?.member?.is_admin) {
            return true;
        }
        if (!e?.member?.permissions) {
            return false;
        }
        // 2 超管、4 频道主、5 子频道管理、7 分组管理
        return [2, 4, 5, 7].includes(e.member.permissions[1])
    }

    /**
     * 捕获消息中的范围
     * @param {string} msg 消息字符串
     * @param {number[]} range 范围数组
     */
    static match_range(msg, range) {
        if (!range) {
            range = [0, MAX_DIFFICULTY]
        }
        if (msg.match(/[0-9]+(\.[0-9]+)?\s*[-～~]\s*[0-9]+(\.[0-9]+)?/g)) {
            /**0-16.9 */
            const matched = msg.match(/[0-9]+(\.[0-9]+)?\s*[-～~]\s*[0-9]+(\.[0-9]+)?/g)?.[0]
            if (!matched) return range;
            const result = matched.split(/\s*[-～~]\s*/g)
            range[0] = Number(result[0])
            range[1] = Number(result[1])
            if (range[0] > range[1]) {
                const tem = range[1]
                range[1] = range[0]
                range[0] = tem
            }
            if (range[1] % 1 == 0 && !result.includes(".0")) range[1] += 0.9
        } else if (msg.match(/[0-9]+(\.[0-9]+)?\s*[-+]/g)) {
            /**16.9- 15+ */
            const matched = msg.match(/[0-9]+(\.[0-9]+)?\s*[-+]/g)?.[0]
            if (!matched) return range;
            const result = matched.replace(/\s*[-+]/g, '')
            if (matched.includes('+')) {
                range[0] = Number(result)
            } else {
                range[1] = Number(result)
                if (range[1] % 1 == 0 && !result.includes(".0")) range[1] += 0.9
            }
        } else if (msg.match(/[0-9]+(\.[0-9]+)?/g)) {
            /**15 */
            const matched = msg.match(/[0-9]+(\.[0-9]+)?/g)?.[0]
            if (!matched) return range;
            range[0] = range[1] = Number(matched)
            if (!matched.includes('.')) {
                range[1] += 0.9
            }
        }

    }

    /**
     * 匹配消息中对成绩的筛选
     * @param {string} e_msg 
     * @param {number} [max_range] 最大范围
     * @returns 
     */
    static match_request(e_msg, max_range) {
        const range = [0, max_range || MAX_DIFFICULTY]

        const msg = e_msg.replace(/^[#/](.*?)(lvsco(re)?)(\s*)/, "")
        const { isask, scoreAsk } = this.parseLevelAndRating(msg)
        this.match_range(e_msg, range)
        return { range, isask, scoreAsk }
    }

    /**
     * 解析消息中的难度（EZ HD IN AT）与评级筛选；未指定时全部选中
     * @param {string} msg
     */
    static parseLevelAndRating(msg) {
        msg = msg.toUpperCase()
        const levels = ['EZ', 'HD', 'IN', 'AT']
        /**EZ HD IN AT */
        const isask = levels.some(level => msg.includes(level)) ? levels.map(level => msg.includes(level)) : [true, true, true, true]
        msg = msg.replace(/(LIST|AT|IN|HD|EZ)/g, "")

        let scoreAsk = { NEW: true, F: true, C: true, B: true, A: true, S: true, V: true, FC: true, PHI: true }
        // 按整词匹配评级，避免 FC 同时选中 F、AP 同时选中 A
        const selectedTags = msg.match(/\b(?:NEW|F|C|B|A|S|V|FC|PHI|AP)\b/g)
        if (selectedTags) {
            scoreAsk = { NEW: false, F: false, C: false, B: false, A: false, S: false, V: false, FC: false, PHI: false }
            for (const tag of selectedTags) {
                scoreAsk[/** @type {keyof typeof scoreAsk} */ (tag === 'AP' ? 'PHI' : tag)] = true
            }
        }
        return { isask, scoreAsk }
    }

    /**
     * 
     * @param {number} real_score 真实成绩
     * @param {boolean | number} fc 是否fc
     * @param {number} [tot_score=1000000] 
     * @returns {ratingKind} 评级
     */
    static rate(real_score, fc, tot_score = 1000000) {
        if (real_score == tot_score) {
            return 'phi'
        } else if (fc) {
            return 'FC'
        } else if (real_score >= tot_score * 0.96) {
            return 'V'
        } else if (real_score >= tot_score * 0.92) {
            return 'S'
        } else if (real_score >= tot_score * 0.88) {
            return 'A'
        } else if (real_score >= tot_score * 0.82) {
            return 'B'
        } else if (real_score >= tot_score * 0.70) {
            return 'C'
        } else if (real_score > 0) {
            return 'F'
        } else {
            return 'NEW';
        }
    }

    /**
     * 计算百分比
     * @param {Number} value 值
     * @param {number[]} range 区间数组 (0,..,1)，只考虑首尾
     * @returns 百分数，单位%
     */
    static range(value, range) {
        if (range[0] == range[range.length - 1]) {
            return 50
        } else {
            return Math.abs((value - range[0]) / (range[range.length - 1] - range[0]) * 100)
        }
    }

    /**
     * 根据百分比和区间获取对应的值
     * @param {number} percent 
     * @param {[number,number]} range 
     * @returns 
     */
    static getValueFromRange(percent, range) {
        if (range[0] == range[1]) {
            return range[0]
        }
        return Math.round((range[1] - range[0]) * percent / 100 + range[0])
    }

    /**
     * 模糊搜索，返回相似度大于0.8的结果
     * @param {string} str 搜索字符串
     * @param {Object<string, string[]>} data 搜索数组
     * @returns {Array<{ key:string, score:number, value:string }>} 相似度大于0.8的结果
     */
    static fuzzySearch(str, data) {
        /**
         * @type {{ key:string, score:number, value:string }[]}
         */
        const result = []
        for (const key in data) {
            const score = this.jaroWinklerDistance(str, key)
            if (score > 0.8) {
                data[key].forEach((value) => {
                    result.push({ key, score, value })
                })
            }
        }
        return result.sort((a, b) => b.score - a.score)
    }

    /**
     * 采用Jaro-Winkler编辑距离算法来计算str间的相似度，复杂度为O(n)=>n为较长的那个字符出的长度
     * @param {string} s1 
     * @param {string} s2 
     * @returns {number} 相似度 0-1
     */
    static jaroWinklerDistance(s1, s2) {
        s1 = s1.trim();
        s2 = s2.trim();
        if (s1 == s2) {
            return 1
        }
        //首先第一次去除空格和其他符号，并转换为小写
        const pattern = /[\s~`!@#$%^&*()\-=_+[\]「」『』{}|;:'",<.>/?！￥…（）—【】、；‘’：“”，《。》？↑↓←→]/g
        s1 = s1.replace(pattern, '').toLowerCase()
        s2 = s2.replace(pattern, '').toLowerCase()
        let m = 0 //匹配的字符数量

        //如果任任一字符串为空则距离为0
        if (s1.length === 0 || s2.length === 0) {
            return 0
        }

        //字符串完全匹配，距离为1
        if (s1 === s2) {
            return 1
        }

        const range = (Math.floor(Math.max(s1.length, s2.length) / 2)) - 1, //搜索范围
            s1Matches = new Array(s1.length),
            s2Matches = new Array(s2.length)

        //查找匹配的字符
        for (let i = 0; i < s1.length; i++) {
            const low = (i >= range) ? i - range : 0,
                high = (i + range <= (s2.length - 1)) ? (i + range) : (s2.length - 1)

            for (let j = low; j <= high; j++) {
                if (s1Matches[i] !== true && s2Matches[j] !== true && s1[i] === s2[j]) {
                    ++m
                    s1Matches[i] = s2Matches[j] = true
                    break
                }
            }
        }

        //如果没有匹配的字符，那么捏Jaro距离为0
        if (m === 0) {
            return 0
        }

        //计算转置的数量
        let k = 0, n_trans = 0
        for (let i = 0; i < s1.length; i++) {
            if (s1Matches[i] === true) {
                let j
                for (j = k; j < s2.length; j++) {
                    if (s2Matches[j] === true) {
                        k = j + 1
                        break
                    }
                }

                if (s1[i] !== s2[j]) {
                    ++n_trans
                }
            }
        }

        //计算Jaro距离
        let weight = (m / s1.length + m / s2.length + (m - (n_trans / 2)) / m) / 3,
            l = 0
        const p = 0.1

        //如果Jaro距离大于0.7，计算Jaro-Winkler距离
        if (weight > 0.7) {
            while (s1[l] === s2[l] && l < 4) {
                ++l
            }

            weight = weight + l * p * (1 - weight)
        }

        return weight
    }

    /**
     * 获取BOT平台名称
     * @param {any} e 
     * @returns 
     */
    static getAdapterName(e) {
        return platform.getAdapterName(e)
    }

    /**
     * 多别名的返回消息
     * @param {idString[]} idArr 
     */
    static mutiNick(idArr) {
        /**
         * 筛选出重复的别名
         * @type {Record<string, number>}
         */
        const nickCnt = {};
        idArr.forEach((id) => {
            (getInfo?.nicklist?.[id] || []).forEach((nick) => {
                if (!nickCnt[nick]) {
                    nickCnt[nick] = 1;
                } else {
                    nickCnt[nick]++;
                }
            })
        })
        /**
         * @type {string[]}
         */
        const nickList = []
        for (const nick in nickCnt) {
            if (nickCnt[nick] > 1) {
                nickList.push(nick);
            }
        }
        /**生成消息 */
        let msg = '你要找的是不是：\n';
        idArr.forEach((id, index) => {
            const info = getInfo.info(id);
            if (info) {
                msg += `${index + 1}. ${info.song}\n-作者：${info.composer}\n`;
                if (getInfo.nicklist?.[id]) {
                    for (const nick of getInfo.nicklist[id]) {
                        if (!nickList.includes(nick)) {
                            msg += `-其他别名：${nick}\n`;
                            break;
                        }
                    }
                } else {
                    msg += `-其他别名：${info.id.replace('.', ' . ')}\n`;
                }
            } else {
                msg += `${index + 1}. ${id}\n暂无信息\n`;
            }
        })
        msg += `请在${Config.getUserCfg('config', 'mutiNickWaitTimeOut')}秒内回复序号`;
        return msg
    }

    /**
     * 判断是不是1GOOD
     * @param {number} score 
     * @param {number} maxc 总物量
     * @returns 
     */
    static comJust1Good(score, maxc) {
        const tar = 900000 * (1 - (0.35 / maxc)) + 100000;
        return Math.abs(score - tar) <= 2;
    }

    /**
     * 从Record中获取key数组
     * @template {Record<PropertyKey, unknown>} T
     * @param {T} record 
     * @returns {(keyof T)[]} key数组
     */
    static objectKeys(record) {
        return /**@type {(keyof T)[]} */(Object.keys(record));
    }

    /**
     * 
     * @param {{phi: LevelRecordInfo[], b27: LevelRecordInfo[]}} b30List 
     * @param {LevelRecordInfo[]} newRecords 
     */
    static updateB30(b30List, newRecords) {
        // 同一谱面以曲目 id + 难度等级区分；定数相同的不同等级不能互相覆盖
        /** @param {LevelRecordInfo} item */
        const key = item => `${item.id}-${item.rank}`
        /** @param {LevelRecordInfo} a @param {LevelRecordInfo} b */
        const byRks = (a, b) => b.rks - a.rks
        const newPhis = newRecords.filter(record => record.acc >= 100)
        const newPhiKeys = new Set(newPhis.map(key))
        const newRecordKeys = new Set(newRecords.map(key))

        const phi = [...b30List.phi.filter(item => !newPhiKeys.has(key(item))), ...newPhis].sort(byRks).slice(0, 3)
        const b27 = [...b30List.b27.filter(item => !newRecordKeys.has(key(item))), ...newRecords].sort(byRks).slice(0, 27)
        return { phi, b27 };
    }

    /**
     * 定义一个函数，接受一个整数参数，返回它的十六进制形式
     * @param {number} num 
     * @returns 
     */
    static toHex(num) {
        return num.toString(16).padStart(2, '0')
    }

    // 定义一个函数，不接受参数，返回一个随机的背景色
    static getRandomBgColor() {
        // 生成三个 0 到 200 之间的随机整数，分别代表红、绿、蓝分量
        const red = Math.floor(Math.random() * 201);
        const green = Math.floor(Math.random() * 201);
        const blue = Math.floor(Math.random() * 201);
        // 将三个分量转换为十六进制形式，然后拼接成一个 RGB 颜色代码
        const hexColor = "#" + this.toHex(red) + this.toHex(green) + this.toHex(blue);
        // 返回生成的颜色代码
        return hexColor;
    }

    /**
     * 将 rgba 字符串转换为难度条渐变 CSS 值，与 atlas.css 中常规难度渐变模式一致
     * @param {string} [rgba] - 逗号分隔的 R,G,B,A 字符串，如 "183,0,253,1"
     * @returns {string|undefined} linear-gradient CSS 值，rgba 无效时返回 undefined
     */
    static rgbaToGradient(rgba) {
        if (!rgba) return undefined;
        const parts = rgba.split(',');
        if (parts.length < 3) return undefined;
        const r = parts[0].trim();
        const g = parts[1].trim();
        const b = parts[2].trim();
        return `linear-gradient(90deg, rgb(${r},${g},${b}) 95px, transparent 95px, rgba(${r},${g},${b},0.53) 105px, rgba(${r},${g},${b},0.53) 50%, transparent 100%)`;
    }

    /**
     *
     * @param {ratingKind} a
     * @param {ratingKind} b
     * @returns
     */
    static cmpRat(a, b) {
        /**@type {ratingKind[]} */
        const rankOrder = ['NEW', 'F', 'C', 'B', 'A', 'S', 'V', 'FC', 'phi']
        return rankOrder.indexOf(a) - rankOrder.indexOf(b);
    }

    /**
     * 从数组中随机选择一个元素，数组元素为[值,权重]，权重越大被选中的概率越大
     * @template T
     * @param {[T,number][]} arr 
     * @return {T} 选中的元素
     */
    static randFromArray(arr) {
        const sum = arr.reduce((acc, cur) => acc + cur[1], 0);
        let rand = Math.random() * sum;
        for (let i = 0; i < arr.length; i++) {
            if (rand < arr[i][1]) {
                return arr[i][0];
            }
            rand -= arr[i][1];
        }
        // 如果没有找到，返回最后一个元素
        return arr[arr.length - 1][0];
    }

    /**
     * 
     * @param {string} content 
     */
    static getRexWithCmdHead(content) {
        const rex = new RegExp(`^[#/]\\s*${Config.getUserCfg('config', 'cmdhead')}\\s*(${content})\\s*`, 'i')
        return rex;
    }

}
