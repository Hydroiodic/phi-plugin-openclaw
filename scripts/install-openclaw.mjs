#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'
const args = ['plugins', 'install', '--link', root, ...process.argv.slice(2)]
const result = spawnSync(cli, args, { stdio: 'inherit', shell: process.platform === 'win32' })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
if (result.status) process.exit(result.status)
console.log('安装完成。运行 openclaw gateway restart 后，在 QQ 私聊发送 /phi；群聊发送 @机器人 /b30。')
