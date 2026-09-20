#!/usr/bin/env node
// Exercise the installed host's startup planner and QQ's buffered dispatcher.
// Isolated state, synthetic users, captured delivery and a stub model resolver.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildResources } from './build-resources.mjs'
import { resolveTestInfo } from './test-resources.mjs'
import { serveRepository } from '../tests/resource-server.mjs'

const pluginRoot = path.resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)))
const executable = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'openclaw'))
  .find(candidate => fs.existsSync(candidate))
const hostRoot = process.env.OPENCLAW_PACKAGE_ROOT || (executable && path.dirname(fs.realpathSync(executable)))
if (!hostRoot) throw new Error('需要安装 OpenClaw，或设置 OPENCLAW_PACKAGE_ROOT 指向其 npm 包目录。')
const dist = path.join(hostRoot, 'dist')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-gateway-smoke-'))
const info = await resolveTestInfo()
// Set these before importing any host module; never open the real user's state.
process.env.OPENCLAW_STATE_DIR = root
process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'openclaw.json')
await buildResources({ output: path.join(root, 'repository'), version: '3.20.0', gameCode: 154, info })
const server = await serveRepository(path.join(root, 'repository'))
process.env.PHI_RESOURCE_BASE_URL = server.url
process.env.PHI_RESOURCE_VERSION = 'latest'
const cfg = {
  plugins: { allow: ['phi-plugin-openclaw'], slots: { memory: 'none' }, load: { paths: [pluginRoot] },
    entries: { 'phi-plugin-openclaw': { enabled: true, config: { channels: ['qqbot'] } } } },
  agents: { defaults: { workspace: path.join(root, 'workspace') } },
  session: { store: path.join(root, 'sessions.json') },
}
const hostImport = name => import(pathToFileURL(path.join(dist, name)).href)
let registry
try {
  // The planner is an internal host module. Locate this version's bundle by
  // prefix instead of hardcoding a build hash; incompatible hosts fail clearly.
  const plannerFile = fs.readdirSync(dist).find(name => /^gateway-startup-plugin-ids-.*\.mjs$/.test(name))
  assert.ok(plannerFile, 'OpenClaw startup planner unavailable; update this integration test for the host version')
  const planner = await hostImport(plannerFile)
  const planWithMetadata = Object.values(planner).find(value => value?.name === 'loadGatewayStartupPluginPlanWithMetadata')
  const planFromRegistry = Object.values(planner).find(value => value?.name === 'resolveGatewayStartupPluginPlanFromRegistry')
  assert.ok(planWithMetadata && planFromRegistry, 'OpenClaw startup planner API changed')
  const { plan, metadataSnapshot } = planWithMetadata({ config: cfg, env: process.env })
  assert.ok(plan.pluginIds.includes('phi-plugin-openclaw'), 'Gateway startup skips Phigros: missing activation metadata')
  // Reproduce the original failure: enabled + individually loadable is not
  // sufficient when the startup activation hints are missing.
  const withoutActivation = planFromRegistry({ config: cfg, env: process.env, index: metadataSnapshot.index,
    manifestRegistry: { ...metadataSnapshot.manifestRegistry, plugins: metadataSnapshot.manifestRegistry.plugins.map(
      entry => entry.id === 'phi-plugin-openclaw' ? { ...entry, activation: undefined } : entry) } })
  assert.ok(!withoutActivation.pluginIds.includes('phi-plugin-openclaw'))
  const { loadAndActivateRootPluginRegistry } = await hostImport('plugins/loader.js')
  registry = loadAndActivateRootPluginRegistry({ config: cfg, pluginIds: plan.pluginIds, cache: false, logger: console })
  assert.equal(registry.plugins.find(entry => entry.id === 'phi-plugin-openclaw')?.status, 'loaded')
  assert.ok(registry.typedHooks.some(entry => entry.hookName === 'reply_dispatch'))
  const { dispatchReplyWithBufferedBlockDispatcher } = await hostImport('plugin-sdk/reply-runtime.js')
  let modelCalls = 0
  let sequence = 0
  async function dispatch(body, { group = false, authorized = false, channel = 'qqbot' } = {}) {
    const replies = [], deliveryErrors = []
    const result = await dispatchReplyWithBufferedBlockDispatcher({
      cfg,
      ctx: { Body: body, BodyForAgent: body, RawBody: body, CommandBody: body,
        CommandAuthorized: authorized, CommandSource: 'text', Provider: channel, Surface: channel,
        SenderId: 'synthetic-user', AccountId: 'default', ChatType: group ? 'group' : 'direct',
        From: `${channel}:${group ? 'group:synthetic-group' : 'direct:synthetic-user'}`,
        To: `${channel}:${group ? 'group:synthetic-group' : 'direct:synthetic-user'}`, SessionKey: `agent:main:${channel}:phi-smoke-${++sequence}`,
        MessageSid: `phi-smoke-${sequence}`, WasMentioned: group },
      dispatcherOptions: { deliver: async payload => { replies.push(payload) }, onError: error => { deliveryErrors.push(error) } },
      replyResolver: async () => { modelCalls++; return { text: 'synthetic-model-reply' } },
    })
    assert.deepEqual(deliveryErrors, [])
    return { result, replies, text: replies.map(reply => reply.text || '').join('\n') }
  }
  for (const authorized of [false, true]) {
    assert.match((await dispatch('/phi', { authorized })).text, /phi-plugin-openclaw · Phigros/)
  }
  assert.equal(server.requests.length, 0, 'Text help must not fetch game resources')
  for (const name of ['gbbind', 'cnbind']) {
    assert.match((await dispatch(`/${name} qrcode`, { group: true, authorized: true })).text, /私聊/)
  }
  assert.equal(server.requests.length, 0, 'Private binding guard must work before runtime initialization')
  assert.match((await dispatch('/b30')).text, /绑定/)
  assert.match((await dispatch('/phi unknown-command')).text, /未识别.*\/phi help/)
  assert.match((await dispatch('<@123> /b30', { group: true })).text, /绑定/)
  // QQ marks a slash-prefixed command as authorized. Unauthorized slash turns
  // in groups are host-suppressed; the plugin must respect that delivery policy.
  const groupBind = await dispatch('/bind synthetic-secret', { group: true, authorized: true })
  assert.match(groupBind.text, /私聊/, JSON.stringify({ groupBind, modelCalls }))
  assert.match((await dispatch('/phi set', { authorized: true })).text, /仅限插件管理员/)
  // Exercise the real host queue with an image followed by the quick menu.
  // Stub only rendering: no browser, network art request or QQ delivery here.
  const { default: pictures } = await import(pathToFileURL(path.join(pluginRoot, 'model/render/picmodle.js')).href)
  const { default: Config } = await import(pathToFileURL(path.join(pluginRoot, 'components/Config.js')).href)
  const { default: platform } = await import(pathToFileURL(path.join(pluginRoot, 'components/platform/index.js')).href)
  const renderHelp = pictures.help, markdownSetting = Config.runtimeOverrides.LetterMarkdown
  pictures.help = async () => platform.segment.image('https://example.invalid/help.png')
  Config.runtimeOverrides.LetterMarkdown = true
  try {
    const help = await dispatch('/phi help')
    assert.deepEqual(help.replies[0].mediaUrls, ['https://example.invalid/help.png'])
    assert.match(help.replies.at(-1).text, /帮助页常用操作/)
    assert.doesNotMatch(help.replies.at(-1).text, /^\*\*\*$/m)
    assert.equal(help.replies.length, 2)
  } finally { pictures.help = renderHelp; Config.runtimeOverrides.LetterMarkdown = markdownSetting }
  // Use real app handlers, with only the account/network boundary stubbed.
  // No real tokens are accessed and no TapTap login is performed.
  const { UserCredentials } = await import(pathToFileURL(path.join(pluginRoot, 'model/user/userCredentials.js')).href)
  const { default: qr } = await import(pathToFileURL(path.join(pluginRoot, 'lib/getQRcode.js')).href)
  const bind = UserCredentials.prototype.bindLocallyWithSessionToken
  const qrOriginal = Object.fromEntries(['getRequest', 'checkQRCodeResult', 'getSessionToken'].map(name => [name, qr[name]]))
  const bindings = [], qrSteps = []
  const token = 'SyntheticPhiToken12345678'
  assert.equal(token.length, 25)
  UserCredentials.prototype.bindLocallyWithSessionToken = async function (value, global) {
    bindings.push({ value, global }); return null
  }
  qr.getRequest = async global => { qrSteps.push(['create', global]); return {
    deviceId: 'synthetic-device', data: { device_code: 'synthetic-code',
      qrcode_url: 'https://example.invalid/synthetic-login', expires_in: 60 },
  } }
  qr.checkQRCodeResult = async (request, global) => { qrSteps.push(['poll', global]); return { success: true, data: {} } }
  qr.getSessionToken = async (result, global) => { qrSteps.push(['token', global]); return token }
  try {
    for (const prefix of ['', 'phi ']) for (const [region, global] of [['gb', true], ['cn', false]]) {
      for (const credential of [token, 'qrcode']) {
        assert.match((await dispatch(`/${prefix}${region}bind ${credential}`)).text, /正在绑定/)
        assert.deepEqual(bindings.at(-1), { value: token, global })
        if (credential === 'qrcode') assert.deepEqual(qrSteps.slice(-3), [['create', global], ['poll', global], ['token', global]])
      }
    }
    assert.equal(bindings.length, 8)
  } finally {
    UserCredentials.prototype.bindLocallyWithSessionToken = bind
    Object.assign(qr, qrOriginal)
  }
  assert.equal(modelCalls, 0, 'Phigros commands must not fall through to the model')
  assert.equal((await dispatch('普通聊天')).text, 'synthetic-model-reply')
  assert.equal((await dispatch('/phi', { channel: 'telegram' })).text, 'synthetic-model-reply')
  assert.equal(modelCalls, 2, 'Other conversations must continue through the host')
  console.log(JSON.stringify({ ok: true, pluginRoot, startupLoaded: true, phigrosModelCalls: 0, capturedCases: sequence, stateDir: root }, null, 2))
} finally {
  for (const entry of registry?.services || []) await entry.service.stop?.()
  await server.close()
}
// Host dispatch starts process-lifetime background timers. This standalone
// smoke process has finished all assertions and awaited plugin/server cleanup.
process.exit(0)
