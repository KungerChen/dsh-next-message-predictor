// P2 服务编排测试：注入 fake contextReader / modelProvider / ledger。
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../src/shared/config.js'
import { createPredictorService } from '../src/host/predictor-service.js'

function baseConfig(overrides) {
  return { ...DEFAULT_CONFIG, enabled: true, ...(overrides ?? {}) }
}

function fakeAdapter() {
  return {
    connectionAvailable: true,
    configEditorAvailable: true,
    capabilities: () => ({ connectionFetch: true, configEditor: true, sessionStore: true, agentRegistry: true }),
    sessionKnown: () => true,
    async persistConfig(patch) {
      return { ok: true, config: { ...baseConfig(), ...patch }, restarted: true }
    },
  }
}

function fakeContext(overrides) {
  return {
    calls: 0,
    async verifyAnchor() {
      return { ok: true, isCurrent: () => true }
    },
    async read() {
      this.calls += 1
      return {
        ok: true,
        messages: [
          { role: 'user', text: '请检查原因' },
          { role: 'assistant', text: '原因是配置缺失' },
        ],
        input: '[用户] 请检查原因\n\n[助手] 原因是配置缺失',
        modelSelection: { provider: 'p', model: 'm' },
        truncated: false,
        codePoints: 30,
        estimatedTokens: 120,
        redactions: 0,
        source: 'sessionQuery.readSurface',
        ...(overrides ?? {}),
      }
    },
  }
}

function fakeModel(outcomeFactory) {
  const resolveRoute = () => ({ ok: true, provider: 'p', model: 'm', source: 'session' })
  return {
    calls: [],
    resolveRoute,
    previewRoute: resolveRoute,
    async produce(call) {
      this.calls.push(call)
      return outcomeFactory(call)
    },
  }
}

function fakeLedger(overrides) {
  const dispatches = new Set()
  return {
    dispatches,
    reserveCalls: 0,
    reserveKeys: [],
    settleCalls: [],
    markShownCalls: [],
    hasDispatch: (key) => dispatches.has(key),
    async ensureLoaded() {},
    async reserve(input) {
      this.reserveCalls += 1
      this.reserveKeys.push(input.dispatchKey)
      if (overrides?.reserveError) return { ok: false, reason: overrides.reserveError }
      if (dispatches.has(input.dispatchKey)) return { ok: false, reason: 'already-dispatched' }
      dispatches.add(input.dispatchKey)
      return { ok: true, reservedTokens: 100 }
    },
    async settle(input) {
      this.settleCalls.push(input)
      return true
    },
    async markShown(key) {
      this.markShownCalls.push(key)
      return true
    },
    snapshot: () => ({ day: '2026-11-09', requests: 1 }),
  }
}

function request(overrides) {
  return {
    schemaVersion: 1,
    operation: 'predict',
    requestId: 'req-1',
    viewId: 'view-1',
    anchor: { sessionId: 's1', branchEpoch: 'v1', turnId: 'a17', completedEventSeq: 20, contextRevision: '6:17' },
    trigger: 'auto',
    ...(overrides ?? {}),
  }
}

function create(options) {
  const adapter = fakeAdapter()
  const contextReader = options?.contextReader ?? fakeContext()
  const modelProvider = options?.modelProvider ?? fakeModel(() => ({ kind: 'raw', text: '{"suggestion":"继续第二项"}', usage: { inputTokens: 40, outputTokens: 6 }, finishKind: 'stop', route: { provider: 'p', model: 'm' }, effort: 'off', elapsedMs: 10 }))
  const ledger = options?.ledger ?? fakeLedger()
  const service = createPredictorService({
    config: baseConfig(options?.config),
    configErrors: [],
    adapter,
    contextReader,
    modelProvider,
    ledger,
    results: options?.results,
    now: () => Date.now(),
    randomId: () => 'sug-1',
  })
  return { service, adapter, contextReader, modelProvider, ledger }
}

function fakeResults() {
  return {
    requests: [],
    outcomes: [],
    async recordRequest(input) {
      this.requests.push(input)
      return Promise.resolve()
    },
    async recordOutcome(suggestionId, event) {
      this.outcomes.push({ suggestionId, event })
      return Promise.resolve()
    },
    async summary() {
      return { requests: this.requests.length, offers: 0 }
    },
  }
}

test('P2 happy path: context -> ledger reserve -> model -> strict JSON -> offer', async () => {
  const { service, modelProvider, ledger } = create()
  const response = await service.handle(request())
  assert.equal(response.status, 200)
  assert.equal(response.body.result.kind, 'offer')
  assert.equal(response.body.result.text, '继续第二项')
  assert.equal(ledger.reserveCalls, 1)
  assert.ok(ledger.settleCalls.length >= 1)
  assert.equal(modelProvider.calls.length, 1)
  const call = modelProvider.calls[0]
  assert.ok(call.system.includes('下一条用户消息预测器'))
  assert.ok(call.input.includes('请检查原因'))
  assert.ok(call.signal !== undefined && call.signal !== null)
  const status = await service.handle({ schemaVersion: 1, operation: 'status' })
  const counters = status.body.value.diagnostics.counters
  assert.equal(counters.offers, 1)
  assert.equal(counters.providerCalls, 1)
  assert.equal(counters.inputTokens, 40)
  assert.equal(counters.outputTokens, 6)
})

test('two concurrent views share one production and receive identical valid offers', async () => {
  const gate = Promise.withResolvers()
  const modelProvider = fakeModel(() => gate.promise)
  const { service, ledger } = create({ modelProvider })
  const first = service.handle(request())
  const second = service.handle(request({ requestId: 'req-2', viewId: 'view-2' }))
  gate.resolve({ kind: 'raw', text: '{"suggestion":"继续"}', route: { provider: 'p', model: 'm' }, finishKind: 'stop' })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.body.result.kind, 'offer')
  assert.equal(b.body.requestId, 'req-2')
  assert.deepEqual(a.body.result, b.body.result)
  assert.equal(modelProvider.calls.length, 1)
  assert.equal(ledger.reserveCalls, 1)
})

test('disconnecting one waiter preserves the shared production for the remaining view', async () => {
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  const modelProvider = fakeModel((call) => {
    started.resolve(call.signal)
    return gate.promise
  })
  const { service } = create({ modelProvider })
  const abort = new AbortController()
  const first = service.handle(request(), abort.signal)
  const second = service.handle(request({ requestId: 'req-2', viewId: 'view-2' }))
  const signal = await started.promise
  abort.abort()
  assert.deepEqual((await first).body.result, { kind: 'unavailable', reason: 'cancelled' })
  assert.equal(signal.aborted, false)
  gate.resolve({ kind: 'raw', text: '{"suggestion":"继续"}', route: { provider: 'p', model: 'm' }, finishKind: 'stop' })
  assert.equal((await second).body.result.kind, 'offer')
  assert.equal(modelProvider.calls.length, 1)
})

test('an overlapping retry survives loss of the original HTTP connection', async () => {
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  const modelProvider = fakeModel((call) => {
    started.resolve(call.signal)
    return gate.promise
  })
  const { service } = create({ modelProvider })
  const abort = new AbortController()
  const first = service.handle(request(), abort.signal)
  const retry = service.handle(request())
  const signal = await started.promise
  abort.abort()
  assert.equal((await first).body.result.reason, 'cancelled')
  assert.equal(signal.aborted, false)
  gate.resolve({ kind: 'raw', text: '{"suggestion":"继续"}', route: { provider: 'p', model: 'm' }, finishKind: 'stop' })
  const response = await retry
  assert.equal(response.body.result.kind, 'offer')
  assert.deepEqual(await service.handle(request()), response)
  assert.equal(modelProvider.calls.length, 1)
})

test('a turn that changes during the ledger write releases its reservation before model IO', async () => {
  let current = true
  const contextReader = fakeContext()
  contextReader.verifyAnchor = async () => ({ ok: true, isCurrent: () => current })
  const ledger = fakeLedger()
  const reserve = ledger.reserve.bind(ledger)
  ledger.reserve = async (input) => {
    const result = await reserve(input)
    current = false
    return result
  }
  const { service, modelProvider } = create({ contextReader, ledger })
  const response = await service.handle(request())
  assert.deepEqual(response.body.result, { kind: 'stale', reason: 'stale-context' })
  assert.equal(modelProvider.calls.length, 0)
  assert.equal(ledger.settleCalls[0].notDispatched, true)
})

test('model suggestion null is a legal abstain', async () => {
  const { service } = create({
    modelProvider: fakeModel(() => ({ kind: 'raw', text: '{"suggestion":null}', usage: { inputTokens: 10, outputTokens: 2 }, finishKind: 'stop', route: { provider: 'p', model: 'm' } })),
  })
  const response = await service.handle(request())
  assert.equal(response.body.result.kind, 'abstain')
  assert.equal(response.body.result.reason, 'model-abstained')
})

test('invalid / multiline / oversized output is rejected, never repaired', async () => {
  for (const [text, expected] of [
    ['not json', 'output-invalid-json'],
    ['{"suggestion":"第一行\\n第二行"}', 'output-multiline'],
    ['```json\n{"suggestion":"x"}\n```', 'output-invalid-json'],
    [`{"suggestion":"${'好'.repeat(200)}"}`, 'output-too-long'],
    ['{"suggestion":"x","extra":1}', 'output-unexpected-fields'],
    ['{"suggestion":42}', 'output-suggestion-not-string'],
  ]) {
    const { service } = create({
      modelProvider: fakeModel(() => ({ kind: 'raw', text, usage: { inputTokens: 1, outputTokens: 1 }, finishKind: 'stop', route: { provider: 'p', model: 'm' } })),
    })
    const response = await service.handle(request())
    assert.equal(response.body.result.kind, 'abstain', text)
    assert.equal(response.body.result.reason, expected, text)
  }
})

test('context failure abstains without calling the model or the ledger', async () => {
  const modelProvider = fakeModel(() => ({ kind: 'raw', text: '{"suggestion":"x"}', finishKind: 'stop', route: { provider: 'p', model: 'm' } }))
  const ledger = fakeLedger()
  const { service } = create({ contextReader: fakeContext({ ok: false, reason: 'stale-context' }), modelProvider, ledger })
  const response = await service.handle(request())
  assert.equal(response.body.result.kind, 'abstain')
  assert.equal(response.body.result.reason, 'stale-context')
  assert.equal(modelProvider.calls.length, 0)
  assert.equal(ledger.reserveCalls, 0)
})

test('ledger write failure refuses dispatch before the model call', async () => {
  const modelProvider = fakeModel(() => ({ kind: 'raw', text: '{"suggestion":"x"}', finishKind: 'stop', route: { provider: 'p', model: 'm' } }))
  const { service } = create({ modelProvider, ledger: fakeLedger({ reserveError: 'ledger-write-failed' }) })
  const response = await service.handle(request())
  assert.equal(response.body.result.kind, 'unavailable')
  assert.equal(response.body.result.reason, 'ledger-write-failed')
  assert.equal(modelProvider.calls.length, 0)
})

test('daily budget exhaustion is unavailable without model call', async () => {
  const modelProvider = fakeModel(() => ({ kind: 'raw', text: '{"suggestion":"x"}', finishKind: 'stop', route: { provider: 'p', model: 'm' } }))
  const { service } = create({ modelProvider, ledger: fakeLedger({ reserveError: 'daily-token-budget' }) })
  const response = await service.handle(request())
  assert.equal(response.body.result.kind, 'unavailable')
  assert.equal(response.body.result.reason, 'daily-token-budget')
  assert.equal(response.body.result.retryAfterMs, 60000)
  assert.equal(modelProvider.calls.length, 0)
})

test('non-stop finishes abstain and are recorded as unknown usage', async () => {
  for (const reason of ['finish-max-tokens', 'finish-aborted', 'finish-error']) {
    const ledger = fakeLedger()
    const { service } = create({ modelProvider: fakeModel(() => ({ kind: 'abstain', reason })), ledger })
    const response = await service.handle(request())
    assert.equal(response.body.result.kind, 'abstain')
    assert.equal(response.body.result.reason, reason)
    const unknownSettles = ledger.settleCalls.filter((call) => call.markUnknown === true)
    assert.ok(unknownSettles.length >= 1, reason)
  }
})

test('durable dispatch ledger prevents re-dispatch after a restart', async () => {
  const ledger = fakeLedger()
  const first = create({ ledger })
  const firstResponse = await first.service.handle(request())
  assert.equal(firstResponse.body.result.kind, 'offer')
  // 新实例（模拟重启）：内存缓存为空，durable 账本已有该回合派发记录。
  const modelProvider = fakeModel(() => ({ kind: 'raw', text: '{"suggestion":"x"}', finishKind: 'stop', route: { provider: 'p', model: 'm' } }))
  const restarted = create({ ledger, modelProvider })
  const response = await restarted.service.handle(request({ requestId: 'req-after-restart' }))
  assert.equal(response.body.result.kind, 'abstain')
  assert.equal(response.body.result.reason, 'already-dispatched')
  assert.equal(modelProvider.calls.length, 0)
})

test('provider transport failure becomes unavailable without a second attempt', async () => {
  const modelProvider = fakeModel(() => ({ kind: 'unavailable', reason: 'stream-failed:network' }))
  const { service } = create({ modelProvider })
  const response = await service.handle(request())
  assert.equal(response.body.result.kind, 'unavailable')
  assert.equal(modelProvider.calls.length, 1)
})

test('status reports P2 route, prompt version and budget', async () => {
  const { service } = create()
  const response = await service.handle({ schemaVersion: 1, operation: 'status' })
  const value = response.body.value
  assert.equal(value.mode, 'model')
  assert.equal(value.promptVersion, 'nmp-p2-v3')
  assert.equal(value.route.provider, 'p')
  assert.equal(value.modelMode, 'fixed')
  assert.ok(value.budget.requests >= 0)
})

test('fixed-test mode still works without model provider (P1 regression)', async () => {
  const service = createPredictorService({
    config: { ...baseConfig(), modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: '固定测试建议' },
    configErrors: [],
    adapter: fakeAdapter(),
    contextReader: fakeContext(),
    now: () => Date.now(),
    randomId: () => 'sug-fixed',
  })
  const response = await service.handle(request())
  assert.equal(response.body.result.kind, 'offer')
  assert.equal(response.body.result.text, '固定测试建议')
})

test('B05: manual retry is dispatched even after an automatic dispatch', async () => {
  const { service, modelProvider, ledger } = create()
  const auto = await service.handle(request())
  assert.equal(auto.body.result.kind, 'offer')
  const manual = await service.handle(request({ requestId: 'req-manual', trigger: 'manual' }))
  assert.equal(manual.body.result.kind, 'offer')
  // 自动与手动使用不同派发键（都含触发方式），各一次。
  assert.equal(ledger.reserveKeys.length, 2)
  assert.ok(ledger.reserveKeys[0].endsWith('\u0000auto'))
  assert.ok(ledger.reserveKeys[1].endsWith('\u0000manual'))
  assert.equal(modelProvider.calls.length, 2)
  // 第二次手动（同一回合）最多命中缓存/额度，不会再次调用模型或再次派发。
  const third = await service.handle(request({ requestId: 'req-manual-2', trigger: 'manual' }))
  assert.ok(third.body.result.kind === 'offer' || third.body.result.kind === 'stale')
  assert.equal(modelProvider.calls.length, 2)
  assert.equal(ledger.reserveKeys.length, 2)
})

test('O01: requests, shown/accepted outcomes and 7-day summary are recorded', async () => {
  const results = fakeResults()
  const { service, ledger, modelProvider } = create({ results })
  const response = await service.handle(request())
  const suggestionId = response.body.result.suggestionId
  assert.equal(results.requests.length, 1)
  const recorded = results.requests[0]
  assert.equal(recorded.outcome, 'offer')
  assert.equal(recorded.text, '继续第二项')
  assert.equal(recorded.trigger, 'auto')
  assert.equal(recorded.suggestionGraphemes, 5)
  assert.equal(recorded.usage.inputTokens, 40)
  assert.equal(recorded.route.provider, 'p')
  assert.ok(recorded.latencyMs >= 0)
  // shown 上报：结果记录 + 账本标记 shown。
  const shown = await service.handle({ schemaVersion: 1, operation: 'outcome', suggestionId, event: 'shown' })
  assert.equal(shown.body.ok, true)
  assert.deepEqual(results.outcomes.at(-1), { suggestionId, event: 'shown' })
  assert.ok(ledger.markShownCalls.length >= 1)
  // 采纳：Host 记录 accepted。
  await service.handle({ schemaVersion: 1, operation: 'accepted', suggestionId })
  assert.deepEqual(results.outcomes.at(-1), { suggestionId, event: 'accepted' })
  // 汇总操作返回 summary。
  const summary = await service.handle({ schemaVersion: 1, operation: 'results.summary' })
  assert.equal(summary.body.ok, true)
  assert.equal(summary.body.value.available, true)
  assert.equal(summary.body.value.summary.requests, 1)
  assert.equal(modelProvider.calls.length, 1)
})

test('O01: invalid outcome events are rejected', async () => {
  const results = fakeResults()
  const { service } = create({ results })
  const response = await service.handle({ schemaVersion: 1, operation: 'outcome', suggestionId: 'x', event: 'publish' })
  assert.equal(response.status, 400)
  assert.equal(results.outcomes.length, 0)
})

test('B01: completions older than 30 minutes are rejected before any model call', async () => {
  const base = fakeContext();
  const contextReader = {
    ...base,
    async verifyAnchor() {
      return { ok: true, isCurrent: () => true, completedAt: Date.now() - 31 * 60 * 1000 }
    },
  };
  const { service, modelProvider } = create({ contextReader });
  const response = await service.handle(request());
  assert.equal(response.body.result.kind, 'stale');
  assert.equal(response.body.result.reason, 'completion-too-old');
  assert.equal(modelProvider.calls.length, 0);
});

test('O03: semantic filter turns assistant-voice suggestions into abstains', async () => {
  const modelProvider = fakeModel(() => ({
    kind: 'raw',
    text: '{"suggestion":"我来帮你检查一下"}',
    usage: { inputTokens: 20, outputTokens: 8 },
    finishKind: 'stop',
    route: { provider: 'p', model: 'm' },
    effort: 'off',
    elapsedMs: 10,
  }));
  const { service } = create({ modelProvider });
  const response = await service.handle(request());
  assert.equal(response.body.result.kind, 'abstain');
  assert.equal(response.body.result.reason, 'semantic-assistant-voice');
  const status = await service.handle({ schemaVersion: 1, operation: 'status' });
  assert.equal(status.body.value.diagnostics.counters.offers, 0);
  assert.equal(status.body.value.diagnostics.counters.outputRejects, 1);
});

test('manual trigger is not limited by the 30 minute completion window', async () => {
  const base = fakeContext();
  const contextReader = {
    ...base,
    async verifyAnchor() {
      return { ok: true, isCurrent: () => true, completedAt: Date.now() - 3 * 60 * 60 * 1000 }
    },
  };
  const { service, modelProvider } = create({ contextReader });
  const response = await service.handle(request({ trigger: 'manual' }));
  assert.notEqual(response.body.result.reason, 'completion-too-old');
  assert.equal(modelProvider.calls.length, 1);
});

test('another one: earlier suggestions are passed to the model and a repeat is not shown again', async () => {
  const texts = ['先跑测试', '看下 diff', '看下 diff'];
  const modelProvider = fakeModel(() => ({
    kind: 'raw',
    text: JSON.stringify({ suggestion: texts.shift() }),
    usage: { inputTokens: 20, outputTokens: 8 },
    finishKind: 'stop',
    route: { provider: 'p', model: 'm' },
    effort: 'off',
    elapsedMs: 10,
  }));
  const { service, ledger } = create({ modelProvider });
  const first = await service.handle(request({ requestId: 'm0', trigger: 'manual' }));
  assert.equal(first.body.result.text, '先跑测试');
  assert.ok(!modelProvider.calls[0].input.includes('要求换一条'));
  const second = await service.handle(request({ requestId: 'm1', trigger: 'manual', attempt: 1 }));
  assert.equal(second.body.result.kind, 'offer');
  assert.equal(second.body.result.text, '看下 diff');
  assert.ok(modelProvider.calls[1].input.includes('要求换一条'));
  assert.ok(modelProvider.calls[1].input.includes('- 先跑测试'));
  const third = await service.handle(request({ requestId: 'm2', trigger: 'manual', attempt: 2 }));
  assert.equal(third.body.result.kind, 'abstain');
  assert.equal(third.body.result.reason, 'repeated-suggestion');
  // Each attempt has its own ledger key.
  assert.equal(new Set(ledger.reserveKeys).size, 3);
});

test('manual trigger still works on a turn the user dismissed with Esc', async () => {
  const { service } = create();
  const auto = await service.handle(request());
  assert.equal(auto.body.result.kind, 'offer');
  await service.handle({ schemaVersion: 1, operation: 'dismiss', suggestionId: auto.body.result.suggestionId, anchor: request().anchor });
  const manual = await service.handle(request({ requestId: 'after-esc', trigger: 'manual' }));
  assert.notEqual(manual.body.result.reason, 'turn-dismissed');
});

test('manual suffix is added to manual requests only', async () => {
  const { service, modelProvider } = create();
  await service.handle(request());
  assert.ok(!modelProvider.calls[0].input.includes('主动按快捷键'));
  const other = create();
  await other.service.handle(request({ requestId: 'm-first', trigger: 'manual' }));
  assert.ok(other.modelProvider.calls[0].input.includes('主动按快捷键'));
});

test('after a Host restart a manual press moves to the next unused attempt instead of "already dispatched"', async () => {
  const ledger = fakeLedger();
  // The persistent ledger remembers two earlier manual predictions for this turn; memory is empty.
  const base = 's1\u0000v1\u000020\u0000a17\u0000manual';
  ledger.dispatches.add(base);
  ledger.dispatches.add(`${base}\u0000r1`);
  const { service, modelProvider } = create({ ledger });
  const response = await service.handle(request({ requestId: 'after-restart', trigger: 'manual' }));
  assert.equal(response.body.result.kind, 'offer');
  assert.equal(modelProvider.calls.length, 1);
  assert.ok(ledger.reserveKeys[0].endsWith('\u0000r2'), ledger.reserveKeys[0]);
});

test('multiple candidates: one model call returns the first as text and the rest as alternatives', async () => {
  const modelProvider = fakeModel(() => ({
    kind: 'raw',
    text: '{"suggestions":["先跑测试","看下 diff","我来帮你检查一下"]}',
    usage: { inputTokens: 20, outputTokens: 30 },
    finishKind: 'stop',
    route: { provider: 'p', model: 'm' },
    effort: 'off',
    elapsedMs: 10,
  }));
  const results = fakeResults();
  const { service } = create({ modelProvider, results });
  const response = await service.handle(request({ trigger: 'manual' }));
  assert.equal(response.body.result.kind, 'offer');
  assert.equal(response.body.result.text, '先跑测试');
  // The assistant-voice candidate is filtered out on its own.
  assert.deepEqual(response.body.result.alternatives, ['看下 diff']);
  assert.equal(modelProvider.calls.length, 1);
  assert.ok(modelProvider.calls[0].system.includes('{"suggestions":['));
  assert.ok(modelProvider.calls[0].config.maxOutputTokens >= 200);
  assert.deepEqual(results.requests[0].alternatives, ['看下 diff']);
});

test('multiple candidates off: the single prompt and a single suggestion', async () => {
  const modelProvider = fakeModel(() => ({
    kind: 'raw',
    text: '{"suggestions":["先跑测试","看下 diff"]}',
    usage: { inputTokens: 20, outputTokens: 30 },
    finishKind: 'stop',
    route: { provider: 'p', model: 'm' },
    effort: 'off',
    elapsedMs: 10,
  }));
  const { service } = create({ modelProvider, config: { multiCandidates: false } });
  const response = await service.handle(request({ trigger: 'manual' }));
  assert.ok(!modelProvider.calls[0].system.includes('{"suggestions":['));
  assert.equal(response.body.result.text, '先跑测试');
  assert.equal(response.body.result.alternatives, undefined);
});

test('habit phrases: the model is still called first, the phrases follow its suggestion and are never sent to it', async () => {
  // Formerly a repeated short message replaced the model call. Now the first
  // suggestion always comes from the model and the habit phrases are local
  // entries behind it, reachable by switching.
  const contextReader = { ...fakeContext(), async habitPhrases() { return ['继续', '跑一下测试'] } };
  const { service, modelProvider, ledger } = create({ contextReader });
  const first = await service.handle(request());
  assert.equal(first.body.result.kind, 'offer');
  assert.equal(first.body.result.text, '继续第二项');
  assert.equal(first.body.result.alternatives, undefined);
  assert.deepEqual(first.body.result.local, [{ text: '继续', source: 'habit' }, { text: '跑一下测试', source: 'habit' }]);
  assert.equal(modelProvider.calls.length, 1);
  assert.equal(ledger.reserveCalls, 1);
  // "Another one" on the same reply is told the model's earlier suggestion, not the user's phrases.
  const more = await service.handle(request({ requestId: 'more', trigger: 'manual' }));
  assert.equal(modelProvider.calls.length, 2);
  assert.ok(modelProvider.calls[1].input.includes('- 继续第二项'));
  assert.ok(!modelProvider.calls[1].input.includes('- 跑一下测试'));
  assert.equal(more.body.result.kind, 'offer');
});

test('habit phrases off, or none found: the model is called as before', async () => {
  const withHabits = { ...fakeContext(), async habitPhrases() { return ['继续'] } };
  const off = create({ contextReader: withHabits, config: { habitSuggestions: false } });
  await off.service.handle(request());
  assert.equal(off.modelProvider.calls.length, 1);
  const none = create({ contextReader: { ...fakeContext(), async habitPhrases() { return [] } } });
  await none.service.handle(request());
  assert.equal(none.modelProvider.calls.length, 1);
});

test('multiple candidates are for manual predictions only: automatic stays single', async () => {
  const modelProvider = fakeModel(() => ({
    kind: 'raw',
    text: '{"suggestion":"先跑测试"}',
    usage: { inputTokens: 20, outputTokens: 8 },
    finishKind: 'stop',
    route: { provider: 'p', model: 'm' },
    effort: 'off',
    elapsedMs: 10,
  }));
  const { service } = create({ modelProvider });
  const response = await service.handle(request());
  assert.ok(!modelProvider.calls[0].system.includes('{"suggestions":['));
  assert.equal(response.body.result.text, '先跑测试');
  assert.equal(response.body.result.alternatives, undefined);
});

test('manualLimit and candidateCount come from the config', async () => {
  const modelProvider = fakeModel(() => ({
    kind: 'raw',
    text: '{"suggestions":["一","二二","三三三","四四四四","五五五五五"]}'.replace('"一"', '"第一条"'),
    usage: { inputTokens: 20, outputTokens: 30 },
    finishKind: 'stop',
    route: { provider: 'p', model: 'm' },
    effort: 'off',
    elapsedMs: 10,
  }));
  const { service } = create({ modelProvider, config: { manualLimit: 1, candidateCount: 4 } });
  const first = await service.handle(request({ requestId: 'm0', trigger: 'manual' }));
  assert.equal(first.body.result.kind, 'offer');
  assert.equal(1 + first.body.result.alternatives.length, 4);
  assert.ok(modelProvider.calls[0].system.includes('最多 4 条'));
  assert.ok(modelProvider.calls[0].config.maxOutputTokens >= 260);
  // One manual prediction per reply: the second is refused without a model call.
  const second = await service.handle(request({ requestId: 'm1', trigger: 'manual', attempt: 1 }));
  assert.equal(second.body.result.kind, 'stale');
  assert.equal(second.body.result.reason, 'already-requested');
  assert.equal(modelProvider.calls.length, 1);
});

test('autoWindowMinutes sets how old a finished reply may be for automatic prediction', async () => {
  const contextReader = { ...fakeContext(), async verifyAnchor() { return { ok: true, isCurrent: () => true, completedAt: Date.now() - 20 * 60 * 1000 } } };
  const strict = create({ contextReader, config: { autoWindowMinutes: 10 } });
  assert.equal((await strict.service.handle(request())).body.result.reason, 'completion-too-old');
  const loose = create({ contextReader, config: { autoWindowMinutes: 60 } });
  assert.equal((await loose.service.handle(request())).body.result.kind, 'offer');
});
