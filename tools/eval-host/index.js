// Evaluation host for dsh-next-message-predictor P3.
//
// This plugin is installed ONLY into the isolated `predictor-scratch` profile.
// It exposes one owner-only route that calls the configured DSH model layer with
// an explicit system/input pair, so the evaluation runner can score the frozen
// predictor prompt against a real provider without going through the predictor's
// authoritative-session path (evaluation fixtures are synthetic conversations).
//
// It does not write sessions, does not register tools, and returns raw output +
// usage. Never include this package in the published predictor bundle.

const ROUTE = '/api/nmp-eval/rpc'

/** Required host service: the browser HTTP carrier. */
export const inject = ['connection']

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function tryGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const connection = tryGet(ctx, 'connection')
  if (connection === undefined || connection.fetch === undefined) {
    console.warn('[nmp-eval] connection.fetch unavailable; eval host disabled')
    return
  }
  const dispose = connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { ok: false, error: { code: 'bad-json', message: 'body must be JSON' } })
      }
      try {
        const result = await handle(ctx, body)
        return json(result.status, result.body)
      } catch (error) {
        return json(500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  })
  ctx.effect(() => dispose, 'nmp-eval: route')
  console.info(`[nmp-eval] ready route=${ROUTE}`)
}

async function handle(ctx, body) {
  const operation = typeof body?.operation === 'string' ? body.operation : ''
  if (operation === 'providers') return providers(ctx)
  if (operation === 'run') return run(ctx, body)
  return { status: 400, body: { ok: false, error: { code: 'unknown-operation', message: operation } } }
}

async function providers(ctx) {
  const llm = tryGet(ctx, 'llm')
  const defaultModel = tryGet(ctx, 'agentDefaultModel')
  const selection = defaultModel !== undefined && defaultModel !== null && typeof defaultModel.currentSelection === 'function'
    ? (() => {
        try {
          return defaultModel.currentSelection()
        } catch {
          return undefined
        }
      })()
    : undefined
  const list = []
  if (llm !== undefined && llm !== null && typeof llm.listProviders === 'function') {
    for (const provider of llm.listProviders()) {
      let models = []
      try {
        const rows = await llm.listModels(provider.id)
        models = rows.map((row) => ({ id: row.id, name: row.name })).slice(0, 40)
      } catch (error) {
        models = [{ error: error instanceof Error ? error.message : String(error) }]
      }
      list.push({ provider: provider.id, name: provider.name, models })
    }
  }
  return { status: 200, body: { ok: true, value: { selection: selection ?? null, providers: list } } }
}

async function run(ctx, body) {
  const llm = tryGet(ctx, 'llm')
  if (llm === undefined || llm === null) return { status: 200, body: { ok: false, error: { code: 'no-llm', message: 'llm service unavailable' } } }
  const selection = (() => {
    const defaultModel = tryGet(ctx, 'agentDefaultModel')
    if (defaultModel === undefined || defaultModel === null || typeof defaultModel.currentSelection !== 'function') return undefined
    try {
      return defaultModel.currentSelection()
    } catch {
      return undefined
    }
  })()
  const provider = typeof body.provider === 'string' && body.provider !== '' ? body.provider : selection?.provider
  const model = typeof body.model === 'string' && body.model !== '' ? body.model : selection?.model
  if (typeof provider !== 'string' || typeof model !== 'string') {
    return { status: 200, body: { ok: false, error: { code: 'no-route', message: 'provider/model missing' } } }
  }
  if (typeof body.system !== 'string' || typeof body.input !== 'string') {
    return { status: 400, body: { ok: false, error: { code: 'bad-request', message: 'system/input required' } } }
  }
  const maxTokens = Math.min(2048, Math.max(1, Number(body.maxTokens) || 256))
  const started = Date.now()
  let prepared
  try {
    // 与生产路径一致：显式请求时用其 effort；否则用模型 advertised 的首个档位。
    prepared = await llm.prepareCall({ provider, model, maxTokens }, undefined, (controls, modelInfo) => {
      const efforts = modelInfo !== null && modelInfo !== undefined && modelInfo.reasoning !== undefined && Array.isArray(modelInfo.reasoning.efforts)
        ? modelInfo.reasoning.efforts
        : []
      const explicit = typeof body.reasoningEffort === 'string' && body.reasoningEffort !== '' ? body.reasoningEffort : undefined
      const chosen = explicit ?? (efforts.length > 0 && typeof efforts[0]?.id === 'string' ? efforts[0].id : undefined)
      return chosen === undefined ? controls : { ...controls, reasoningEffort: chosen }
    })
  } catch (error) {
    return { status: 200, body: { ok: false, error: { code: 'prepare-failed', message: error instanceof Error ? error.message : String(error) } } }
  }
  let text = ''
  let usage
  let finishKind = 'missing'
  try {
    for await (const chunk of prepared.stream({
      ...prepared.config,
      system: body.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: body.input }] }],
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'usage') usage = chunk.usage
      else if (chunk?.type === 'finish') {
        finishKind = typeof chunk.reason?.kind === 'string' ? chunk.reason.kind : 'unknown'
      }
    }
  } catch (error) {
    return {
      status: 200,
      body: {
        ok: false,
        error: { code: 'stream-failed', message: error instanceof Error ? error.message : String(error) },
        elapsedMs: Date.now() - started,
        provider,
        model,
      },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        text,
        usage: usage ?? null,
        finish: finishKind,
        elapsedMs: Date.now() - started,
        provider,
        model,
        effort: prepared.config.reasoningEffort ?? null,
        reasoningEfforts: undefined,
      },
    },
  }
}

export default { apply, inject }
