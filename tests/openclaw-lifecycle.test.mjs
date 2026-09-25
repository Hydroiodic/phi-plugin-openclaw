import test from 'node:test'
import assert from 'node:assert/strict'
import { PhigrosPlugin } from '../src/plugin.mjs'
import { PhigrosRuntime } from '../src/runtime.mjs'
import { TaskScheduler } from '../src/task-scheduler.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}
const api = () => ({
  pluginConfig: {},
  logger: { warn() {}, info() {}, error() {} },
  runtime: { state: { resolveStateDir: () => '/tmp/phi-lifecycle' } },
})
const context = { channel: 'qqbot', senderId: 'test', commandBody: '/b30' }

test('lazy runtime is shared, retries initialization failure, and is closed once', async () => {
  let calls = 0,
    closed = 0
  const gate = deferred()
  const plugin = new PhigrosPlugin(api(), {
    createRuntime: async () => {
      if (++calls === 1) throw new Error('synthetic startup failure')
      await gate.promise
      return {
        dispatch: async () => true,
        close: async () => {
          closed++
        },
      }
    },
  })
  const output = []
  assert.equal(await plugin.handle(context, payload => output.push(payload)), true)
  assert.match(output[0].text, /处理失败/)
  const first = plugin.handle(context, () => true),
    second = plugin.handle(context, () => true)
  await Promise.resolve()
  assert.equal(calls, 2)
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  await Promise.all([plugin.close(), plugin.close()])
  assert.equal(closed, 1)
  assert.equal(await plugin.handle(context, () => true), false)
})

test('stop during initialization closes the new runtime without dispatching a reply', async () => {
  const gate = deferred()
  let dispatched = 0,
    closed = 0
  const plugin = new PhigrosPlugin(api(), { createRuntime: () => gate.promise })
  const work = plugin.handle(context, () => {
    throw new Error('Must not deliver')
  })
  const stopping = plugin.close()
  gate.resolve({
    dispatch() {
      dispatched++
    },
    close() {
      closed++
    },
  })
  await Promise.all([work, stopping])
  assert.equal(dispatched, 0)
  assert.equal(closed, 1)
})

test('cancelled commands and resource-independent replies do not start the runtime', async () => {
  const plugin = new PhigrosPlugin(api(), {
    createRuntime: () => {
      throw new Error('Must not initialize')
    },
  })
  const output = []
  for (const commandBody of ['/phi', '/phi identity', '/phi openclawhelp', '/gbbind qrcode']) {
    await plugin.handle({ ...context, commandBody, isGroup: true }, payload => output.push(payload))
  }
  assert.equal(output.length, 4)
  assert.match(output.at(-1).text, /私聊/)
  await plugin.handle({ ...context, signal: AbortSignal.abort() }, () => assert.fail('cancelled reply'))
  assert.equal(plugin.pending, undefined)
  await plugin.close()
})

test('runtime drains active dispatch before closing resources and attempts every disposer', async () => {
  const gate = deferred(),
    events = []
  const adapter = {
    logger: api().logger,
    fromContext: () => ({}),
    flush: async () => events.push('flush'),
    close: () => events.push('database'),
  }
  const runtime = new PhigrosRuntime(
    adapter,
    {
      dispatch: async () => {
        await gate.promise
        events.push('dispatch')
        return true
      },
    },
    {
      apiMonitor: { close: () => events.push('api-stop') },
      pictures: {
        close: () => {
          events.push('pictures')
          throw new Error('browser close failed')
        },
      },
      config: { close: () => events.push('config') },
      watchers: { closeAll: () => events.push('watchers') },
    },
  )
  const work = runtime.dispatch({}, () => true)
  const stopping = runtime.close()
  const rejected = assert.rejects(stopping, AggregateError)
  assert.equal(runtime.close(), stopping)
  await assert.rejects(
    runtime.dispatch({}, () => true),
    /closed/,
  )
  assert.deepEqual(events, ['api-stop'])
  gate.resolve()
  await work
  await rejected
  assert.deepEqual(events, ['api-stop', 'dispatch', 'flush', 'pictures', 'config', 'watchers', 'database'])
})

test('runtime cleanup survives a synchronous maintenance shutdown failure', async () => {
  let closed = 0
  const failure = new Error('monitor close failed')
  const runtime = new PhigrosRuntime(
    {
      logger: api().logger,
      close() {
        closed++
      },
    },
    {},
    {
      apiMonitor: {
        close() {
          throw failure
        },
      },
    },
  )
  await assert.rejects(runtime.close(), error => error instanceof AggregateError && error.errors.includes(failure))
  assert.equal(closed, 1)
})

test('runtime shutdown cancels active command signals before waiting for completion', async () => {
  let signal,
    disposed = false
  const runtime = new PhigrosRuntime(
    {
      logger: api().logger,
      fromContext: context => context,
      flush() {},
      close() {
        disposed = true
      },
    },
    {
      dispatch: context => {
        signal = context.signal
        return new Promise(resolve => signal.addEventListener('abort', () => resolve(true), { once: true }))
      },
    },
  )
  const command = runtime.dispatch({}, () => true)
  assert.equal(signal.aborted, false)
  await runtime.close()
  assert.equal(signal.aborted, true)
  assert.equal(await command, true)
  assert.equal(disposed, true)
})

test('background jobs do not overlap and shutdown waits for running work', async () => {
  const scheduler = new TaskScheduler(api().logger),
    gate = deferred(),
    instance = {}
  let count = 0
  const callback = async () => {
    count++
    await gate.promise
  }
  const first = scheduler.run(instance, callback)
  assert.equal(scheduler.run(instance, callback), undefined)
  await Promise.resolve()
  assert.equal(count, 1)
  let closed = false
  const closing = scheduler.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  assert.equal(scheduler.run({}, callback), undefined)
  gate.resolve()
  await first
  await closing
  assert.equal(closed, true)
})

test('task interval overflow and missing methods fail early', () => {
  const scheduler = new TaskScheduler(api().logger)
  for (const interval of [-1, Infinity, 0.5, 2 ** 31]) assert.throws(() => scheduler.schedule({ task: { interval, fnc() {} } }), RangeError)
  assert.throws(() => scheduler.schedule({ task: { interval: 100, fnc: 'absent' } }), TypeError)
})
