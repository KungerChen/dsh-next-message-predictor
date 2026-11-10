// P2 辅助模型调用测试（fake llm，无网络）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createModelProvider, pickReasoningEffort } from '../src/host/model-provider.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'

function config(overrides) {
  return { ...DEFAULT_CONFIG, enabled: true, ...(overrides ?? {}) }
}

function fakeLlm(chunks, options) {
  const calls = { prepare: [], stream: [] }
  return {
    calls,
    async prepareCall(callConfig, signal, configure) {
      calls.prepare.push({ callConfig, hasSignal: signal !== undefined && signal !== null })
      const model = {
        reasoning: { efforts: options?.efforts ?? [{ id: 'off' }, { id: 'low' }] },
      }
      const controls = typeof configure === 'function' ? configure({ maxTokens: callConfig.maxTokens }, model) : {}
      return {
        config: { ...callConfig, ...controls },
        retryPolicy: { maxAttempts: 1 },
        stream(streamOptions) {
          calls.stream.push(streamOptions)
          return (async function* () {
            for (const chunk of chunks) yield chunk
          })()
        },
      }
    },
  }
}

const routeSelection = { provider: 'p', model: 'm' }

function produce(provider, call) {
  return provider.produce({ ...call, route: provider.resolveRoute(call.config, routeSelection) })
}

test('pickReasoningEffort uses explicit supported effort or first advertised', () => {
  const model = { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }
  // B09f: 优先低成本档位（off/none/minimal/low），而不是能力列表首项。
  assert.deepEqual(pickReasoningEffort(model, ''), { ok: true, effort: 'off', reason: 'preferred-low-cost' })
  assert.deepEqual(pickReasoningEffort(model, 'high'), { ok: true, effort: 'high', reason: 'explicit' })
  assert.equal(pickReasoningEffort(model, 'max').ok, false)
  assert.equal(pickReasoningEffort({}, '').effort, undefined)
  // 没有低成本档位时退回 advertised 首项。
  const highOnly = { reasoning: { efforts: [{ id: 'high' }, { id: 'medium' }] } }
  assert.deepEqual(pickReasoningEffort(highOnly, ''), { ok: true, effort: 'high', reason: 'lowest-advertised' })
  const low = { reasoning: { efforts: [{ id: 'medium' }, { id: 'low' }] } }
  assert.deepEqual(pickReasoningEffort(low, ''), { ok: true, effort: 'low', reason: 'preferred-low-cost' })
})

test('produce returns raw text only on finish stop and collects usage', async () => {
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '{"suggestion":' },
    { type: 'text-delta', index: 0, text: '"继续"}' },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const provider = createModelProvider({ getLlm: () => llm, getDefaultModel: () => routeSelection, onEvent: () => {} })
  const outcome = await produce(provider, { system: 'sys', input: 'in', config: config() })
  assert.equal(outcome.kind, 'raw')
  assert.equal(outcome.text, '{"suggestion":"继续"}')
  assert.deepEqual(outcome.usage, { inputTokens: 12, outputTokens: 4 })
  assert.equal(outcome.effort, 'off')
  // 辅助调用不得携带 sessionId/tools，也不得把 system 塞进 messages。
  const streamed = llm.calls.stream[0]
  assert.equal(streamed.sessionId, undefined)
  assert.equal(streamed.tools, undefined)
  assert.equal(streamed.system, 'sys')
})

for (const finish of ['max-tokens', 'aborted', 'error']) {
  test(`produce abstains on finish ${finish}`, async () => {
    const llm = fakeLlm([{ type: 'text-delta', index: 0, text: 'partial' }, { type: 'finish', reason: { kind: finish } }])
    const provider = createModelProvider({ getLlm: () => llm, getDefaultModel: () => routeSelection })
    const outcome = await produce(provider, { system: 's', input: 'i', config: config() })
    assert.equal(outcome.kind, 'abstain')
    assert.equal(outcome.reason, `finish-${finish}`)
  })
}

test('an aborted stream with only zero-valued usage leaves usage unknown', async () => {
  const llm = fakeLlm([
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'aborted' } },
  ])
  const provider = createModelProvider({ getLlm: () => llm })
  const outcome = await produce(provider, { system: 's', input: 'i', config: config() })
  assert.equal(outcome.kind, 'abstain')
  assert.equal(outcome.usage, undefined)
})

test('produce reports unavailable when the llm service is missing', async () => {
  const provider = createModelProvider({ getLlm: () => undefined, getDefaultModel: () => routeSelection })
  const outcome = await produce(provider, { system: 's', input: 'i', config: config() })
  assert.equal(outcome.kind, 'unavailable')
  assert.equal(outcome.reason, 'llm-service-unavailable')
})

test('fixed mode without a complete route is unavailable', async () => {
  const llm = fakeLlm([])
  const provider = createModelProvider({ getLlm: () => llm, getDefaultModel: () => routeSelection })
  const outcome = await produce(provider, {
    system: 's',
    input: 'i',
    config: config({ modelMode: 'fixed', provider: 'p', model: '' }),
  })
  assert.equal(outcome.kind, 'unavailable')
  assert.equal(outcome.reason, 'no-route:fixed-route-incomplete')
})

test('model-mode route resolution follows the session selection', () => {
  const provider = createModelProvider({
    getLlm: () => fakeLlm([]),
    getDefaultModel: () => ({ provider: 'default-provider', model: 'default-model' }),
  })
  const route = provider.resolveRoute(config({ modelMode: 'session', provider: '', model: '' }), { provider: 'turn-provider', model: 'turn-model' })
  assert.equal(route.ok, true)
  assert.equal(route.provider, 'turn-provider')
  assert.equal(route.model, 'turn-model')
  assert.equal(route.source, 'session')
  assert.equal(provider.previewRoute(config({ modelMode: 'session', provider: '', model: '' })).source, 'default')
  assert.equal(provider.resolveRoute(config({ modelMode: 'session', provider: '', model: '' })).ok, false)
})

test('unsupported explicit reasoning effort rejects before provider IO', async () => {
  const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
  const provider = createModelProvider({ getLlm: () => llm, getDefaultModel: () => routeSelection })
  const outcome = await produce(provider, {
    system: 's',
    input: 'i',
    config: config({ reasoningEffort: 'max' }),
  })
  assert.equal(outcome.kind, 'unavailable')
  assert.ok(outcome.reason.startsWith('prepare-failed:'))
  assert.equal(llm.calls.stream.length, 0)
})

test('stream exceptions become unavailable without retry', async () => {
  const counts = { prepare: 0, stream: 0 }
  const llm = {
    async prepareCall(callConfig) {
      counts.prepare += 1
      return {
        config: { ...callConfig },
        stream() {
          counts.stream += 1
          return (async function* () {
            throw new Error('network down')
          })()
        },
      }
    },
  }
  const provider = createModelProvider({ getLlm: () => llm, getDefaultModel: () => routeSelection })
  const outcome = await produce(provider, { system: 's', input: 'i', config: config() })
  assert.equal(outcome.kind, 'unavailable')
  assert.ok(outcome.reason.startsWith('stream-failed:'))
  assert.equal(counts.prepare, 1)
  assert.equal(counts.stream, 1)
})

test('O04: fixed route falls back to the session model when prepare fails', async () => {
  const prepared = [];
  const llm = {
    async prepareCall(callConfig, signal, configure) {
      prepared.push(callConfig);
      if (callConfig.provider === 'fixed-p') throw new Error('provider-not-configured');
      const model = { reasoning: { efforts: [{ id: 'off' }] } };
      const controls = configure({ maxTokens: callConfig.maxTokens }, model);
      return {
        config: { ...callConfig, ...controls },
        stream() {
          return (async function* () {
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      };
    },
  };
  const events = [];
  const provider = createModelProvider({
    getLlm: () => llm,
    getDefaultModel: () => ({ provider: 'session-p', model: 'session-m' }),
    onEvent: (event) => events.push(event),
  });
  const cfg = config({ modelMode: 'fixed', provider: 'fixed-p', model: 'fixed-m', reasoningEffort: 'off' });
  const outcome = await provider.produce({ system: 's', input: 'i', config: cfg, route: provider.resolveRoute(cfg) });
  assert.equal(outcome.kind, 'raw');
  assert.equal(outcome.route.provider, 'session-p');
  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].provider, 'fixed-p');
  assert.equal(prepared[1].provider, 'session-p');
  assert.ok(events.some((event) => event.kind === 'route-fallback'));
});
