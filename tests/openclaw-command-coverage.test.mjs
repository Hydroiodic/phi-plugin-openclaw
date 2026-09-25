import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { createPlatform } from '../src/platform.mjs'
import { createRouter, isPhigrosCommand, normalizeCommand } from '../src/commands.mjs'

// One representative for every enabled business rule. The coverage assertion
// also fails when a rule is added or removed without updating this inventory.
const cases = {
  RankList: { rankList: 'ranklist', rankfind: 'rankfind 1' },
  aliasProposal: { propose: 'alias submit Credits | test', mine: 'alias mine', publicList: 'alias public', appeal: 'alias appeal 1', vote: 'alias vote 1', unvote: 'alias unvote 1' },
  apiSetting: { setApiToken: 'setApiToken test', tokenList: 'tkls', auth: 'auth', clearApiData: 'clearApiData', updateHistory: 'updateHistory', updateUserToken: 'updateUserToken', updateComment: 'updateComment', apiset: 'apiset' },
  b19: { b19: 'b30', p30: 'p30', arcgrosB19: 'a b30', lmtAcc: 'lmtacc 98', bestn: 'best 1', singlescore: 'score Credits', suggest: 'suggest', chap: 'chap', achievement: 'achievement' },
  botClient: { resetApiBot: 'resetApiBot', claimLink: 'botClaimLink' },
  chart: { chart: 'chart Credits', tag: 'tag Credits', settag: 'settag Credits' },
  guessGame: { start: 'ltr', guess: 'Credits', reveal: '/开 a', getTip: 'tip', ans: 'ans' },
  help: { help: 'help', tkhelp: 'tk help', apihelp: 'api help' },
  manage: { restartpu: 'repu', backup: 'backup', restore: 'restore', get: 'get test', del: 'del test', allow: 'allow test', ban: 'ban test', unban: 'unban test' },
  market: { market: 'market', marketPage: 'nx' },
  money: { sign: 'sign', tasks: 'task', retask: 'retask', send: 'send 1 2', theme: 'theme 1', jrrp: 'jrrp' },
  phisong: { song: 'song Credits', search: 'search Credits', setnick: 'setnick Credits', ill: 'ill Credits', randClg: 'randclg', randmic: 'rand', alias: 'alias Credits', comrks: 'com 15 98', tips: 'tips', newSong: 'newlog', live: 'live', table: 'table 15', difHis: 'difHistory Credits', comment: 'comment Credits', recallComment: 'recmt 1', myComment: 'mycmt', addtag: 'addtag Credits', newNotice: 'newnotice' },
  saveEdit: { confirm: 'saveupload ABC234', cancel: 'savecancel' },
  session: { bind: 'gbbind qrcode', update: 'update', unbind: 'unbind', clean: 'clean', getSstk: 'sessionToken' },
  setting: { showUserSetting: 'myset', set: 'set' },
  update: { update: '强制更新', illustrations: 'down ill' },
  user: { data: 'data', info: 'info', lvscore: 'lvsco', list: 'list', analyze2025SaveHistory: '2025history', hisb30: 'hisb30' },
}

const aliases = {
  'RankList.rankList': ['排行榜'], 'RankList.rankfind': ['查询排名 1'],
  'aliasProposal.propose': ['alias 提案 Credits | 测试'], 'aliasProposal.mine': ['alias 我的'],
  'aliasProposal.publicList': ['alias 公审'], 'aliasProposal.appeal': ['alias 申诉 1'],
  'aliasProposal.vote': ['alias 投票 1'], 'aliasProposal.unvote': ['alias 撤票 1'],
  'apiSetting.tokenList': ['lstk'],
  'b19.b19': ['B30', 'b 30', 'rks', 'pgr', 'RKS', 'PGR'],
  'b19.p30': ['x30', 'fc30', 'P30', 'X30', 'FC30', 'p 30'],
  'b19.arcgrosB19': ['啊比三零', '阿币30', '批必30', '屁b30', '劈B30'],
  'b19.singlescore': ['单曲成绩 Credits', 'score1 Credits', 'score2 Credits', '单曲成绩2 Credits'],
  'b19.suggest': ['推分', '推分建议'], 'b19.achievement': ['ahv'],
  'botClient.resetApiBot': ['重置API Bot身份'], 'botClient.claimLink': ['获取Bot认领链接'],
  'guessGame.start': ['letter', '开字母', '猜曲绘', '提示猜曲', 'tipgame', 'guess', 'ltr -L 5'],
  'guessGame.getTip': ['提示'], 'guessGame.ans': ['答案', '结束'],
  'help.help': ['命令', '帮助', '菜单', '说明', '功能', '指令', '使用说明'],
  'help.tkhelp': ['token帮助', 'tokhelp', 'tken说明', 'tk 菜单'], 'help.apihelp': ['api帮助'],
  'manage.backup': ['backup back'], 'market.marketPage': ['pr', '上一页', '下一页'],
  'money.sign': ['sign in', '签到', '打卡'], 'money.tasks': ['我的任务'], 'money.retask': ['刷新任务'],
  'money.send': ['送 1 2', '转 1 2'], 'money.theme': ['theme1'], 'money.jrrp': ['今日人品'],
  'phisong.song': ['曲 Credits'], 'phisong.search': ['查找 Credits', '检索 Credits'],
  'phisong.setnick': ['setnic Credits', '设置别名 Credits'], 'phisong.ill': ['曲绘 Credits', 'Ill Credits'],
  'phisong.randmic': ['随机', 'random'], 'phisong.comrks': ['计算 15 98'],
  'phisong.table': ['定数表 15', 'table 15 -v 3.20.0'],
  'phisong.difHis': ['difHis Credits', 'difhis Credits', 'difhistory Credits', '历史定数 Credits'],
  'phisong.comment': ['cmt Credits', '评论 Credits', '评价 Credits', 'comment Credits\n很好听'],
  'phisong.addtag': ['subtag Credits', 'retag Credits'],
  'saveEdit.confirm': ['确认上传 ABC234'], 'saveEdit.cancel': ['取消上传'],
  'session.bind': ['bind qrcode', 'cnbind qrcode', '绑定 qrcode', 'cn绑定 qrcode', 'gb绑定 qrcode'],
  'session.update': ['更新存档'], 'session.unbind': ['解绑'], 'session.getSstk': ['sessiontoken'],
  'setting.showUserSetting': ['mysetting', '用户设置', '个人设置'], 'setting.set': ['设置'],
  'update.update': ['更新', 'gx', 'qzgx', 'qz更新', '强制gx'],
  'update.illustrations': ['下载曲绘', '更新曲绘', 'gxill', 'downill', 'up ill'],
  'user.info': ['info1', 'info2'], 'user.lvscore': ['lvscore', 'scolv'],
  'user.analyze2025SaveHistory': ['年度总结'],
}

test('every enabled app command reaches its handler through the OpenClaw router', async t => {
  const adapter = createPlatform(), apps = {}, originals = {}, observed = []
  t.after(() => adapter.close())
  for (const file of (await fs.readdir(new URL('../apps/', import.meta.url))).filter(name => name.endsWith('.js'))) {
    const mod = await import(new URL(`../apps/${file}`, import.meta.url))
    const RealApp = Object.values(mod).find(value => typeof value === 'function')
    assert.ok(RealApp, `${file}: app module must export a command class`)
    const key = file.slice(0, -3), instance = new RealApp()
    for (const rule of instance.rule) assert.equal(typeof instance[rule.fnc], 'function', `${key}.${rule.fnc}: declared handler must exist`)
    originals[key] = instance
    apps[key] = class extends adapter.PluginBase {
      constructor() { super({ rule: instance.rule, priority: instance.priority }) }
    }
    for (const rule of instance.rule) apps[key].prototype[rule.fnc] = async () => { observed.push(`${key}.${rule.fnc}`); return true }
    assert.deepEqual([...new Set(instance.rule.map(rule => rule.fnc))].sort(), Object.keys(cases[key] || {}).sort(), `${key}: incomplete command inventory`)
    assert.equal(instance.rule.length, Object.keys(cases[key]).length, `${key}: every rule needs its own coverage example`)
  }
  assert.deepEqual(Object.keys(apps).sort(), Object.keys(cases).sort())
  const router = createRouter(apps, adapter)
  let count = 0
  async function check(body, expected) {
    const e = adapter.fromContext({ channel: 'qqbot', senderId: 'audit-user', from: 'audit', commandBody: body }, () => true)
    e.isMaster = true
    assert.equal(await router.dispatch(e), true, body)
    assert.equal(observed.at(-1), expected, body)
    count++
  }
  for (const [app, handlers] of Object.entries(cases)) for (const [handler, example] of Object.entries(handlers)) {
    const bare = app === 'guessGame' && ['guess', 'reveal'].includes(handler)
    const body = bare ? example : `/phi ${example}`
    if (handler !== 'guess') assert.equal(isPhigrosCommand(body), true, body)
    await check(body, `${app}.${handler}`)
  }
  for (const [body, expected] of [
    ['/gbbind qrcode', 'session.bind'], ['/cnbind qrcode', 'session.bind'],
    ['/pgr b30', 'b19.b19'], ['/PGRB30', 'b19.b19'], ['/屁股肉帮助', 'help.help'],
    ['杠phi啊比三零', 'b19.arcgrosB19'], ['phisign', 'money.sign'], ['phi task', 'money.tasks'], ['phitheme1', 'money.theme'],
    ['/开a', 'guessGame.reveal'], ['#open A', 'guessGame.reveal'],
    ['/phi tipgame', 'guessGame.start'], ['/phi guess', 'guessGame.start'],
    ['/phi qzgx', 'update.update'], ['/phi backup back', 'manage.backup'],
    ['/phi p40', 'b19.p30'], ['/phi x30', 'b19.p30'], ['/phi FC30', 'b19.p30'],
    ['/phi rks', 'b19.b19'], ['/phi 单曲成绩2 Credits', 'b19.singlescore'],
    ['/phi 下一页', 'market.marketPage'], ['/phi setApiToken test', 'apiSetting.setApiToken'],
  ]) {
    assert.equal(isPhigrosCommand(body), true, body)
    await check(body, expected)
  }
  for (const [expected, examples] of Object.entries(aliases)) for (const example of examples) {
    await check(`/phi ${example}`, expected)
    await check(`#phi${example}`, expected)
  }
  // All unambiguous short forms use the same router, including before startup.
  for (const [app, handlers] of Object.entries(cases)) for (const [handler, example] of Object.entries(handlers)) {
    if (app === 'guessGame' && ['guess', 'reveal'].includes(handler) || ['help', 'send', 'a b30'].includes(example) || example.startsWith('send ')) continue
    const body = `/${example}`
    assert.equal(isPhigrosCommand(body), true, body)
    await check(body, `${app}.${handler}`)
  }
  for (const body of ['/help', '/send', '/model', '/another-plugin']) assert.equal(isPhigrosCommand(body), false)
  assert.equal(normalizeCommand('/help'), '/help')
  t.diagnostic(`${Object.keys(apps).length} apps, ${Object.values(originals).reduce((n, app) => n + app.rule.length, 0)} rules, ${count} routed command cases`)
})
