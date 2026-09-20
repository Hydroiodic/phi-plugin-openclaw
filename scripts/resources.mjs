#!/usr/bin/env node
import path from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { ensureResources, listResourceVersions } from '../src/resources.mjs'

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'base-url': { type: 'string' }, version: { type: 'string' }, 'data-dir': { type: 'string' }, illustrations: { type: 'boolean', default: false } } })
  if (positionals.length !== 1 || !['list', 'install'].includes(positionals[0])) throw new Error('用法：node scripts/resources.mjs list|install [--base-url HTTPS地址] [--version 3.20.0] [--data-dir 目录] [--illustrations]')
  const config = { resourceBaseUrl: values['base-url'], resourceVersion: values.version, downloadIllustrations: values.illustrations }
  // Explicit CLI flags override the environment; runtime environment overrides plugin config.
  const env = { ...process.env }
  if (values['base-url']) delete env.PHI_RESOURCE_BASE_URL
  if (values.version) delete env.PHI_RESOURCE_VERSION
  if (positionals[0] === 'list') {
    console.log('VERSION\tPHIGROS\tPACKAGES')
    for (const entry of await listResourceVersions(config, env)) console.log(`${entry.version}\t${entry.game?.version || '-'}\t${entry.packages?.join(',') || '-'}`)
  } else if (positionals[0] === 'install') {
    const dataRoot = path.resolve(values['data-dir'] || path.join(process.env.OPENCLAW_STATE_DIR || path.join(homedir(), '.openclaw'), 'phi-plugin-openclaw'))
    const result = await ensureResources({ dataRoot, config, env, refresh: true })
    console.log(`资源版本：${result.manifest.version}\n数据目录：${result.infoPath}\n共享曲绘：${config.downloadIllustrations ? result.illustrationPath : '由插件按需下载并校验缓存'}\n请在相同 dataDir/镜像/版本配置下重启 Gateway 生效。此脚本不读取 openclaw.json。`)
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
