import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientRuntime } from '../src/client/controller.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'

const previous = 'a'.repeat(64)
const target = 'b'.repeat(64)
const state = (runningId, installedId, canApply = runningId !== installedId) => ({
  runningId, installedId, canApply, state: runningId === installedId ? 'current' : 'update-available',
})

function fixture(clientBuildId) {
  const calls = []
  const shared = { request: null }
  let build = state(previous, target)
  let result = async () => ({ ok: true, value: { accepted: true } })
  const create = (id = clientBuildId) => createClientRuntime({
    clientBuildId: id,
    updateHandoff: shared,
    rpc: async (operation, body) => {
      calls.push({ operation, body })
      if (operation === 'update.apply') return result()
      if (operation === 'send.claim') return { ok: true, value: { granted: true, sessionVersion: body.sessionVersion } }
      return {
        ok: true, value: {
          version: '0.7.0', config: { ...DEFAULT_CONFIG, enabled: true, sendOnTab: true },
          capabilities: { connectionFetch: true, sendClaim: true }, localBuild: build,
        },
      }
    },
  })
  return { create, calls, shared, setBuild: (value) => { build = value }, setResult: (run) => { result = run } }
}

test('an accepted request is not success until Host and this page load the target', async (t) => {
  const f = fixture(previous)
  const old = f.create()
  t.after(old.dispose)
  await old.loadStatus()
  await old.applyLocalUpdate(target)
  await old.loadStatus()
  assert.equal(old.updateStore.getSnapshot().phase, 'checking')
  await old.applyLocalUpdate(target)
  assert.equal(f.calls.filter((call) => call.operation === 'update.apply').length, 1)
  f.setBuild(state(target, target))
  await old.loadStatus()
  assert.equal(old.updateStore.getSnapshot().phase, 'checking', 'the same old renderer cannot claim completion')
  old.dispose()
  const current = f.create(target)
  t.after(current.dispose)
  await current.loadStatus()
  assert.equal(current.updateStore.getSnapshot().phase, 'applied')
  assert.equal(f.shared.request, null)
})

test('a lost response only triggers reads and the new renderer can confirm the installed target', async (t) => {
  const f = fixture(target)
  const runtime = f.create()
  t.after(runtime.dispose)
  await runtime.loadStatus()
  f.setResult(async () => { f.setBuild(state(target, target)); throw Error('route interrupted') })
  await runtime.applyLocalUpdate(target)
  await runtime.loadStatus()
  assert.equal(runtime.updateStore.getSnapshot().phase, 'verified')
  assert.deepEqual(f.calls.filter((call) => call.operation === 'update.apply'), [{
    operation: 'update.apply', body: { targetBuildId: target },
  }])
})

test('mixed and legacy builds hold prediction and one-click send without falsely offering updates', async (t) => {
  const f = fixture(target)
  const runtime = f.create()
  t.after(runtime.dispose)
  await runtime.loadStatus()
  assert.equal(runtime.eligibility({}).reason, 'build-mismatch')
  const painted = { suggestionId: 'valid-offer', sessionId: 'test-session',
    sessionVersion: { hostId: 'test-host', pauseRevision: 0, turnRevision: 0 } }
  const signal = new AbortController().signal
  assert.equal(await runtime.claimSend(painted, signal), 'session-state-changed')
  assert.equal(f.calls.some((call) => call.operation === 'send.claim'), false)
  f.setBuild(state(target, target))
  await runtime.loadStatus()
  assert.equal(await runtime.claimSend(painted, signal), '', 'the same valid request can reach the gate on matched builds')
  assert.equal(f.calls.filter((call) => call.operation === 'send.claim').length, 1)
  f.setBuild(undefined)
  await runtime.loadStatus()
  assert.equal(runtime.configStore.getSnapshot().localBuild.state, 'legacy')
  assert.equal(runtime.eligibility({}).reason, 'build-mismatch')
  assert.equal(await runtime.applyLocalUpdate(target), false)
  f.setBuild({ ...state(previous, target), installedId: 'invalid-target' })
  await runtime.loadStatus()
  assert.equal(runtime.configStore.getSnapshot().localBuild.state, 'unknown')
  assert.equal(await runtime.applyLocalUpdate(target), false)
  assert.equal(f.calls.some((call) => call.operation === 'update.apply'), false)
})

test('pending verification is bounded and does not replay the mutation', async (t) => {
  const f = fixture(target)
  f.shared.request = { targetBuildId: target, expiresAt: Date.now() - 1 }
  const runtime = f.create()
  t.after(runtime.dispose)
  await runtime.loadStatus()
  assert.deepEqual(runtime.updateStore.getSnapshot(), { phase: 'failed', failure: 'unconfirmed' })
  assert.equal(f.shared.request, null)
  assert.equal(f.calls.some((call) => call.operation === 'update.apply'), false)
})

test('a known HMR failure still appears when the new renderer sees its build loaded first', async (t) => {
  const f = fixture(previous)
  const old = f.create()
  t.after(old.dispose)
  let resolve
  f.setResult(() => new Promise((accepted) => { resolve = accepted }))
  await old.loadStatus()
  const pending = old.applyLocalUpdate(target)
  old.dispose()
  f.setBuild(state(target, target))
  const fresh = f.create(target)
  t.after(fresh.dispose)
  await fresh.loadStatus()
  assert.equal(fresh.updateStore.getSnapshot().phase, 'checking', 'a late profile failure cannot be hidden by the build probe')
  resolve({ ok: false, error: { code: 'restart-required' } })
  await pending
  await fresh.loadStatus()
  assert.deepEqual(fresh.updateStore.getSnapshot(), { phase: 'failed', failure: 'restart-required' })
  assert.equal(f.calls.filter((call) => call.operation === 'update.apply').length, 1)
})

test('a status begun before a configuration save cannot replace or clear the new status request', async (t) => {
  const snapshots = []
  const response = (enabled, configRevision) => ({
    ok: true, value: { config: { ...DEFAULT_CONFIG, enabled }, configRevision,
      capabilities: { connectionFetch: true }, localBuild: state(target, target) },
  })
  const runtime = createClientRuntime({
    clientBuildId: target,
    rpc: async (operation) => {
      if (operation === 'config.set') return response(true, 2)
      return new Promise((resolve) => { snapshots.push(resolve) })
    },
  })
  t.after(runtime.dispose)
  const stale = runtime.loadStatus()
  assert.equal(runtime.loadStatus(), stale, 'unrelated status reads are coalesced')
  assert.equal((await runtime.saveConfig({ enabled: true })).ok, true)
  assert.equal(snapshots.length, 2, 'a save forces a fresh status read')
  const fresh = runtime.loadStatus()
  assert.notEqual(fresh, stale)
  snapshots[0](response(false, 1))
  await stale
  assert.equal(runtime.configStore.getSnapshot().config.enabled, true, 'the late old status cannot restore old config')
  assert.equal(runtime.loadStatus(), fresh, 'finally for the old request cannot erase the live request')
  snapshots[1](response(true, 2))
  await fresh
  assert.equal(runtime.configStore.getSnapshot().revision, 2)
})
