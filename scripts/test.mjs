#!/usr/bin/env node
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveTestInfo } from './test-resources.mjs'

try {
  const info = await resolveTestInfo()
  const root = fileURLToPath(new URL('../', import.meta.url))
  const files = fs
    .readdirSync(new URL('../tests/', import.meta.url))
    .filter(file => /\.test\.(?:js|mjs)$/.test(file) && (!process.argv.includes('--openclaw') || file.startsWith('openclaw')))
    .map(file => `tests/${file}`)
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PHI_TEST_INFO_PATH: info, PHI_RESOURCE_SOURCE_DIR: info },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} catch (error) {
  console.error(`测试资源未就绪：${error.message}\n请配置 PHI_RESOURCE_BASE_URL，或用 PHI_RESOURCE_SOURCE_DIR 指向外部 song-data 源目录。`)
  process.exitCode = 1
}
