// B07: request registry keeps production concurrency honest.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRequestRegistry } from '../src/host/request-registry.js'

test('B07: aborted productions no longer count as active', async () => {
  const registry = createRequestRegistry()
  const gate = Promise.withResolvers()
  const production = registry.startProduction('k1', async (signal) => {
    await gate.promise
    return { kind: 'offer', text: 'x' }
  })
  const abort = new AbortController()
  const waiter = registry.attach(production, 'req-1', abort.signal)
  assert.equal(registry.activeCount(), 1)
  abort.abort()
  assert.deepEqual(await waiter, { kind: 'unavailable', reason: 'cancelled' })
  assert.equal(registry.activeCount(), 0)
  gate.resolve()
  await production.result
  registry.dispose()
})

test('B07: auto and manual credits are independent per turn', () => {
  const registry = createRequestRegistry()
  assert.equal(registry.hasCredit('t1', 'auto'), true)
  assert.equal(registry.hasCredit('t1', 'manual'), true)
  registry.consumeCredit('t1', 'auto')
  assert.equal(registry.hasCredit('t1', 'auto'), false)
  assert.equal(registry.hasCredit('t1', 'manual'), true)
  // 手动每回合 3 次（第一次 + 两次“换一条”）。
  registry.consumeCredit('t1', 'manual')
  registry.consumeCredit('t1', 'manual')
  assert.equal(registry.hasCredit('t1', 'manual'), true)
  registry.consumeCredit('t1', 'manual')
  assert.equal(registry.hasCredit('t1', 'manual'), false)
})

test('B07: release aborts the shared production only when the last waiter leaves', async () => {
  const registry = createRequestRegistry()
  const gate = Promise.withResolvers()
  const production = registry.startProduction('k2', async (signal) => {
    await gate.promise
    return { kind: 'offer', text: 'x' }
  })
  const first = new AbortController()
  const second = new AbortController()
  const a = registry.attach(production, 'req-a', first.signal)
  const b = registry.attach(production, 'req-b', second.signal)
  first.abort()
  assert.deepEqual(await a, { kind: 'unavailable', reason: 'cancelled' })
  assert.equal(production.abort.signal.aborted, false)
  second.abort()
  assert.deepEqual(await b, { kind: 'unavailable', reason: 'cancelled' })
  assert.equal(production.abort.signal.aborted, true)
  assert.equal(registry.activeCount(), 0)
  registry.dispose()
})
