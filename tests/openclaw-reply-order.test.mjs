import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlatform } from '../src/platform.mjs'
import { getPlatformAdapter, setPlatformAdapter } from '../components/platform/index.js'
import Config from '../components/Config.js'
import {
  buildQuickCommandMarkdown,
  buildQuickCommandSectionsMarkdown,
  buildMarketQuickMarkdown,
  sendQuickCommands,
  sendQuickCommandSections,
  sendMarketQuickCommands,
} from '../model/game/markdown.js'

const commands = [{ command: '/b30', label: '成绩' }]
const sections = [
  { title: '成绩', commands },
  { title: '设置', commands },
]
const themes = [{ slug: 'test', name: 'Test', botDownloadAllowed: true }]
const event = (adapter, deliver, signal) => adapter.fromContext({ channel: 'qqbot', senderId: 'test', signal }, deliver)

test('all quick menus keep command tables without decorative horizontal rules', () => {
  for (const markdown of [
    buildQuickCommandMarkdown(commands),
    buildQuickCommandSectionsMarkdown(sections),
    buildMarketQuickMarkdown(themes, { page: 2, pageCount: 3 }),
  ]) {
    assert.doesNotMatch(markdown, /^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/m)
    assert.match(markdown, /\| :---: \| :---: \| :---: \|/)
    assert.match(markdown, /<qqbot-cmd-input /)
  }
})

test('all quick menu senders defer until image and subsequent text replies finish', async () => {
  const previous = getPlatformAdapter(),
    previousConfig = Config.getUserCfg
  const adapter = createPlatform()
  setPlatformAdapter(adapter)
  Config.getUserCfg = (_name, key) => (key === 'LetterMarkdown' ? true : 'phi')
  try {
    for (const send of [
      e => sendQuickCommands(e, commands),
      e => sendQuickCommandSections(e, sections),
      e => sendMarketQuickCommands(e, themes),
    ]) {
      const replies = []
      const e = event(adapter, async payload => {
        replies.push(payload)
      })
      // An array/image payload takes more async preparation than plain text.
      adapter.reply(e, [adapter.segment.image('https://example.invalid/score.png'), '成绩'])
      await send(e)
      adapter.reply(e, '补充说明')
      await adapter.flush(e)
      assert.equal(replies.length, 3)
      assert.deepEqual(replies[0].mediaUrls, ['https://example.invalid/score.png'])
      assert.equal(replies[1].text, '补充说明')
      assert.match(replies[2].text, /<qqbot-cmd-input /)
      assert.doesNotMatch(replies[2].text, /^\*\*\*$/m)
      await adapter.flush(e)
      assert.equal(replies.length, 3, 'Repeated flush must not resend menus')
    }
  } finally {
    Config.getUserCfg = previousConfig
    setPlatformAdapter(previous)
    adapter.close()
  }
})

test('clones share delivery order while unrelated requests remain independent', async () => {
  const adapter = createPlatform(),
    delivered = []
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  try {
    const e = event(adapter, async payload => {
      if (payload.text === 'first') await gate
      delivered.push(payload.text)
    })
    adapter.reply(e, 'first')
    const clone = adapter.cloneEvent(e)
    adapter.afterReplies(clone, () => adapter.reply(clone, 'menu'))
    adapter.reply(clone, 'second')
    const other = event(adapter, payload => {
      delivered.push(payload.text)
    })
    await adapter.reply(other, 'other')
    assert.deepEqual(delivered, ['other'])
    release()
    await adapter.flush(e)
    assert.deepEqual(delivered, ['other', 'first', 'second', 'menu'])
  } finally {
    release()
    adapter.close()
  }
})

test('cancelled replies do not send a queued image or footer', async () => {
  const adapter = createPlatform(),
    replies = [],
    controller = new AbortController()
  try {
    const e = event(adapter, payload => replies.push(payload), controller.signal)
    adapter.reply(e, [adapter.segment.image('https://example.invalid/score.png')])
    adapter.afterReplies(e, () => adapter.reply(e, 'menu'))
    controller.abort()
    await adapter.flush(e)
    assert.deepEqual(replies, [])
  } finally {
    adapter.close()
  }
})

test('a failed main reply clears deferred menus and does not poison the next delivery', async () => {
  const adapter = createPlatform(),
    replies = []
  try {
    const e = event(adapter, payload => {
      if (payload.text === 'fail') throw new Error('delivery failed')
      replies.push(payload.text)
    })
    adapter.reply(e, 'fail')
    adapter.afterReplies(e, () => adapter.reply(e, 'menu'))
    await assert.rejects(adapter.flush(e), /delivery failed/)
    await adapter.flush(e)
    await adapter.reply(e, 'error notice')
    await adapter.flush(e)
    assert.deepEqual(replies, ['error notice'])
  } finally {
    adapter.close()
  }
})

test('concurrent flush calls wait for the same drain and never advance menus early', async () => {
  const adapter = createPlatform(),
    replies = []
  const { promise: gate, resolve: release } = Promise.withResolvers()
  let menuStarted = false
  try {
    const e = event(adapter, async payload => {
      if (payload.text === 'image') await gate
      replies.push(payload.text)
    })
    adapter.reply(e, 'image')
    adapter.afterReplies(e, async () => {
      menuStarted = true
      await adapter.reply(e, 'menu')
    })
    const first = adapter.flush(e),
      second = adapter.flush(adapter.cloneEvent(e))
    assert.equal(first, second)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(menuStarted, false)
    release()
    await Promise.all([first, second])
    assert.deepEqual(replies, ['image', 'menu'])
  } finally {
    release()
    adapter.close()
  }
})

test('a failed footer drains its fire-and-forget work exactly once', async () => {
  const adapter = createPlatform(),
    replies = []
  try {
    const e = event(adapter, payload => {
      if (payload.text === 'failed menu') throw new Error('menu delivery failed')
      replies.push(payload.text)
    })
    adapter.afterReplies(e, async () => {
      await adapter.reply(e, 'failed menu')
    })
    adapter.afterReplies(e, async () => {
      await adapter.reply(e, 'must not run')
    })
    await assert.rejects(adapter.flush(e), /menu delivery failed/)
    await adapter.flush(e)
    await adapter.reply(e, 'retry notice')
    await adapter.flush(e)
    assert.deepEqual(replies, ['retry notice'])
  } finally {
    adapter.close()
  }
})

test('closing is idempotent, prevents new events and cancels queued delivery', async () => {
  const adapter = createPlatform(),
    replies = []
  const e = event(adapter, payload => replies.push(payload))
  adapter.reply(e, 'pending')
  adapter.afterReplies(e, async () => {
    await adapter.reply(e, 'menu')
  })
  adapter.close()
  assert.doesNotThrow(() => adapter.close())
  assert.throws(() => event(adapter, () => {}), { code: 'PHI_PLATFORM_CLOSED' })
  assert.equal(await adapter.reply(e, 'late'), false)
  await adapter.flush(e)
  assert.deepEqual(replies, [])
})
