#!/usr/bin/env node
// Runs the actual plugin hook, table help and B30 renderer with synthetic data.
// No QQ messages, model calls or real credentials are sent.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../openclaw.mjs'
import { buildResources } from './build-resources.mjs'
import { buildIllustrations } from './build-illustrations.mjs'
import { serveRepository } from '../tests/resource-server.mjs'
import { resolveTestInfo } from './test-resources.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-openclaw-smoke-'))
await buildResources({
  output: path.join(root, 'repository'),
  version: '3.20.0',
  gameVersion: '3.20.0',
  gameCode: 154,
  info: await resolveTestInfo(),
})
const server = await serveRepository(path.join(root, 'repository'))
const previousMirror = process.env.PHI_RESOURCE_BASE_URL,
  previousVersion = process.env.PHI_RESOURCE_VERSION
process.env.PHI_RESOURCE_BASE_URL = server.url
process.env.PHI_RESOURCE_VERSION = 'latest'
const commands = new Map(),
  hooks = new Map(),
  services = []
plugin.register({
  pluginConfig: { channels: ['qqbot'], timeout: 60000 },
  logger: console,
  runtime: { state: { resolveStateDir: () => root } },
  resolvePath: p => p,
  registerCommand: def => commands.set(def.name, def),
  on: (name, fn) => hooks.set(name, fn),
  registerService: service => services.push(service),
})
const replies = []
async function dispatch(body, overrides = {}) {
  const current = []
  const result = await hooks.get('reply_dispatch')(
    {
      ctx: {
        Provider: 'qqbot',
        SenderId: 'smoke-user',
        AccountId: 'default',
        From: 'qqbot:group:smoke-group',
        To: 'qqbot:group:smoke-group',
        ChatType: 'group',
        CommandBody: body,
        RawBody: body,
        CommandAuthorized: true,
        ...overrides,
      },
      sendPolicy: 'allow',
    },
    {
      dispatcher: {
        sendFinalReply: p => {
          current.push(p)
          replies.push(p)
          return true
        },
        getQueuedCounts: () => ({ final: current.length, tool: 0, block: 0 }),
      },
      recordProcessed() {},
      markIdle() {},
    },
  )
  return { result, replies: current }
}
try {
  assert.ok(commands.has('b30'))
  const textHelp = await dispatch('/phi')
  assert.equal(textHelp.result.handled, true)
  assert.match(textHelp.replies[0].text, /\| 分类 \| 命令示例 \| 说明 \|/)
  assert.equal((await dispatch('/another-plugin')).result, undefined)
  assert.equal((await dispatch('/help')).result, undefined)
  assert.equal(server.requests.length, 0)
  assert.match((await dispatch('/b30')).replies.at(-1).text, /绑定/)
  assert.match((await dispatch('/bind secret')).replies.at(-1).text, /私聊/)
  assert.equal((await dispatch('无关聊天')).result, undefined)
  assert.equal((await dispatch('/phi', { CommandAuthorized: false })).result.handled, true)
  assert.match((await dispatch('/b30', { CommandAuthorized: false })).replies.at(-1).text, /绑定/)
  assert.match((await dispatch('<@123> /b30', { CommandAuthorized: false })).replies.at(-1).text, /绑定/)

  const [{ default: getInfo }, { default: Save }, { UserCredentials }, { default: Config }] = await Promise.all([
    import('../model/game/getInfo.js'),
    import('../model/save/Save.js'),
    import('../model/user/userCredentials.js'),
    import('../components/Config.js'),
  ])
  const { getPlatformAdapter } = await import('../components/platform/state.js')
  const { userIdentity } = await import('../src/platform.mjs')
  const adapter = getPlatformAdapter()
  const token = 'SYNTHETIC'.padEnd(25, '0')
  assert.equal(token.length, 25)
  await adapter.redis.set(`phiPlugin:userToken:${userIdentity('qqbot', 'default', 'smoke-user')}`, token)
  const fallback = fileURLToPath(new URL('../resources/html/otherimg/phigros.png', import.meta.url))
  const artworkSource = path.join(root, 'artwork-source')
  for (const directory of ['ill', 'illLow', 'illBlur', 'SP']) fs.mkdirSync(path.join(artworkSource, directory), { recursive: true })
  for (const id of Object.keys(getInfo.ori_info)) {
    for (const directory of ['ill', 'illLow', 'illBlur'])
      fs.copyFileSync(fallback, path.join(artworkSource, directory, id.replace(/\.0$/, '') + '.png'))
  }
  for (const song of Object.values(getInfo.sp_info))
    fs.copyFileSync(fallback, path.join(artworkSource, 'SP', song.id.replace(/\.0$/, '') + '.png'))
  await buildIllustrations({ input: artworkSource, output: path.join(root, 'repository') })
  Config.runtimeOverrides.LetterMarkdown = true
  const help = await dispatch('/phi help')
  assert.equal(help.result.handled, true)
  const helpImages = help.replies.flatMap(reply => reply.mediaUrls || [])
  assert.ok(helpImages.length > 0, JSON.stringify(help.replies))
  assert.ok(fs.statSync(helpImages[0]).size > 10000)
  assert.match(help.replies.at(-1).text, /帮助页常用操作/)
  assert.doesNotMatch(help.replies.at(-1).text, /^\*\*\*$/m)
  assert.ok(help.replies.findIndex(reply => reply.mediaUrls?.length) < help.replies.length - 1)
  console.log(JSON.stringify({ helpImage: helpImages[0], bytes: fs.statSync(helpImages[0]).size }))
  const records = Object.entries(getInfo.ori_info)
    .filter(([, info]) => info.chart.IN)
    .slice(0, 40)
  assert.equal(records.length, 40)
  const save = new Save(
    {
      session: token,
      global: false,
      Recordver: 1,
      gameuser: { avatar: '', background: '', selfIntro: 'OpenClaw synthetic smoke test' },
      playerInfo: {},
      saveInfo: {
        PlayerId: 'OpenClaw Test',
        modifiedAt: { iso: new Date().toISOString() },
        summary: { rankingScore: 12, challengeModeRank: 315, gameVersion: 154, updatedAt: new Date().toISOString() },
      },
      gameRecord: Object.fromEntries(
        records.map(([id], i) => [id, [null, null, { score: i < 3 ? 1000000 : 980000, acc: i < 3 ? 100 : 98, fc: true }]]),
      ),
    },
    true,
  )
  const original = UserCredentials.prototype.getUpdatedSaveFromLocal
  UserCredentials.prototype.getUpdatedSaveFromLocal = async function () {
    return { save }
  }
  try {
    const b30 = await dispatch('/b30')
    assert.equal(b30.result.handled, true)
    const images = b30.replies.flatMap(p => p.mediaUrls || [])
    assert.ok(images.length > 0, JSON.stringify(b30.replies))
    assert.ok(fs.statSync(images[0]).size > 10000)
    assert.match(b30.replies.at(-1).text, /成绩页快捷操作/)
    assert.doesNotMatch(b30.replies.at(-1).text, /^\*\*\*$/m)
    assert.ok(b30.replies.findIndex(reply => reply.mediaUrls?.length) < b30.replies.length - 1)
    assert.ok(server.requests.some(url => url.startsWith('/illustrations/objects/')))
    assert.equal(
      server.requests.filter(url => url.startsWith('/illustrations/objects/')).length,
      1,
      'identical artwork is downloaded once across render requests',
    )
    assert.equal(
      server.requests.some(url => url.startsWith('/illustrations/packages/')),
      false,
      'default rendering downloads individual objects',
    )
    console.log(
      JSON.stringify({ ok: true, commands: commands.size, stateDir: root, image: images[0], bytes: fs.statSync(images[0]).size }, null, 2),
    )
  } finally {
    UserCredentials.prototype.getUpdatedSaveFromLocal = original
  }
} finally {
  for (const service of services) await service.stop()
  await server.close()
  if (previousMirror === undefined) delete process.env.PHI_RESOURCE_BASE_URL
  else process.env.PHI_RESOURCE_BASE_URL = previousMirror
  if (previousVersion === undefined) delete process.env.PHI_RESOURCE_VERSION
  else process.env.PHI_RESOURCE_VERSION = previousVersion
}
