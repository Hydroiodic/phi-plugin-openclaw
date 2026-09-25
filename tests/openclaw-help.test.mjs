import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import template from 'art-template'
import { HELP } from '../src/commands.mjs'

const resources = fileURLToPath(new URL('../resources/', import.meta.url))
const file = path.join(resources, 'html/help/help.art')
const helpGroup = [
  {
    group: '绑定与查询',
    list: [
      { title: '/bind<br>/绑定', eg: '/bind <sessionToken|qrcode>', desc: '第一行<br>第二行 <曲名>' },
      { title: '/b30', desc: 'Best30' },
    ],
  },
  { group: '管理员命令', auth: 'master', list: [{ title: '/backup', desc: '备份' }] },
]
function render(isMaster) {
  return template.render(
    fs.readFileSync(file, 'utf8'),
    {
      defaultLayout: path.join(resources, 'html/common/layout/default.art'),
      _res_path: resources + '/',
      helpGroup,
      isMaster,
      cmdHead: 'phi',
      theme: 'default',
      themeInfo: null,
      Version: { ver: '0.1.0' },
      _plugin: 'Phigros',
      sys: { scale: '' },
    },
    { filename: file },
  )
}

test('text help is a three-column table with no trailing explanation', () => {
  assert.match(HELP, /\| 分类 \| 命令示例 \| 说明 \|\n\| --- \| --- \| --- \|/)
  const rows = HELP.split('\n').filter(line => line.startsWith('|'))
  assert.ok(rows.length >= 20)
  assert.ok(rows.every(row => row.split('|').length === 5))
  for (const command of ['/gbbind', '/cnbind', '/b30', '/score', '/phi help', '/phi reply']) assert.ok(HELP.includes(command))
  assert.equal(HELP.split('\n').at(-1), rows.at(-1))
})

test('image help preserves rows, line breaks, literal parameters and administrator visibility', () => {
  const normal = render(false),
    admin = render(true)
  assert.equal((normal.match(/<table class="help-table">/g) || []).length, 1)
  assert.equal((admin.match(/<table class="help-table">/g) || []).length, 2)
  for (const label of ['命令', '用法示例', '说明']) assert.ok(normal.includes(`>${label}</th>`))
  assert.ok(normal.includes('/phi bind') && normal.includes('/phi 绑定') && normal.includes('/phi b30'))
  assert.match(normal, /(?:&lt;|&#60;)sessionToken\|qrcode(?:&gt;|&#62;)/)
  assert.match(normal, /第一行<\/div><div>第二行 (?:&lt;|&#60;)曲名(?:&gt;|&#62;)/)
  assert.ok(!normal.includes('管理员命令') && admin.includes('/phi backup'))
  const visible = normal.replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(!visible.includes('不存在授权') && !visible.includes('class="copyright"'))
})
