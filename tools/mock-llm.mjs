#!/usr/bin/env node
/**
 * Minimal local OpenAI-compatible mock LLM for deterministic E2E runs.
 *
 * Used by the predictor-scratch profile through the `llm-pi-ai` provider route
 * `mock` (api: openai-completions, baseURL: http://127.0.0.1:3091/v1). It never
 * touches the user's DeepSeek account.
 *
 * Two behaviours:
 * - normal chat (the main conversation): fixed reply, default `收到（mock-1）`;
 * - next-message predictor requests (system prompt contains "下一条用户消息预测器"):
 *   a configurable JSON suggestion, so P2 can exercise the real
 *   context → ctx.llm.stream → strict JSON path deterministically and free.
 *
 * Runtime control (no restart needed):
 *   POST /control {"predictMode":"json"|"abstain"|"invalid"|"multiline"|"slow",
 *                  "predictReply":"...", "reply":"..."}
 *   GET  /state   current modes
 *
 * Endpoints:
 *   POST /v1/chat/completions   SSE stream (stream:true) or plain JSON
 *   GET  /v1/models             one model, `mock-1`
 *   GET  /health                liveness JSON
 *
 * Usage:
 *   node tools/mock-llm.mjs --port 3091 --reply 收到（mock-1）
 */
import http from 'node:http'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', '3091'))
const HOST = argOf('--host', '127.0.0.1')
const MODEL = argOf('--model', 'mock-1')
const CHUNK_DELAY_MS = Number(argOf('--chunk-delay-ms', '20'))

const state = {
  reply: argOf('--reply', '收到（mock-1）'),
  predictMode: argOf('--predict-mode', 'json'),
  predictReply: argOf('--predict-reply', '{"suggestion":"继续第二项"}'),
}

function log(line) {
  process.stdout.write(`[mock-llm] ${line}\n`)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function completionBody(model, content) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  }
}

function sseChunk(model, id, delta, finishReason) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`
}

function summarizeChatRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user')
  const text = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.map((p) => p?.text ?? '').join(' ')
      : ''
  return {
    model: body?.model ?? '(unset)',
    stream: Boolean(body?.stream),
    messageCount: messages.length,
    lastUserText: String(text).replace(/\s+/g, ' ').slice(0, 300),
  }
}

/** The DSH predictor system prompt marker; identifies auxiliary prediction calls. */
function isPredictorRequest(body) {
  try {
    const text = JSON.stringify(body ?? {})
    return text.includes('下一条用户消息预测器')
  } catch {
    return false
  }
}

/** Resolve the content for one completion (predictor or normal chat). */
async function resolveContent(body, summary) {
  if (!isPredictorRequest(body)) {
    log(`request path=/v1/chat/completions model=${summary.model} stream=${summary.stream} ` +
      `messages=${summary.messageCount} lastUser="${summary.lastUserText}"`)
    return { content: state.reply, kind: 'chat' }
  }
  const mode = state.predictMode
  log(`predictor-request mode=${mode} model=${summary.model} messages=${summary.messageCount}`)
  switch (mode) {
    case 'abstain':
      return { content: '{"suggestion":null}', kind: 'predictor' }
    case 'invalid':
      return { content: 'not-a-json-response', kind: 'predictor' }
    case 'multiline':
      return { content: '{"suggestion":"第一行\\n第二行"}', kind: 'predictor' }
    case 'slow':
      await new Promise((resolve) => setTimeout(resolve, 5000))
      return { content: state.predictReply, kind: 'predictor' }
    case 'json':
    default:
      return { content: state.predictReply, kind: 'predictor' }
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, model: MODEL, reply: state.reply, predictMode: state.predictMode, predictReply: state.predictReply })
    return
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    sendJson(res, 200, { ...state, model: MODEL })
    return
  }
  if (req.method === 'POST' && url.pathname === '/control') {
    const raw = await readBody(req)
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-json' })
      return
    }
    if (typeof body?.reply === 'string' && body.reply !== '') state.reply = body.reply
    if (typeof body?.predictReply === 'string' && body.predictReply !== '') state.predictReply = body.predictReply
    if (typeof body?.predictMode === 'string' && ['json', 'abstain', 'invalid', 'multiline', 'slow'].includes(body.predictMode)) {
      state.predictMode = body.predictMode
    }
    log(`control reply=${JSON.stringify(state.reply)} predictMode=${state.predictMode}`)
    sendJson(res, 200, { ok: true, ...state })
    return
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: [{
        id: MODEL,
        object: 'model',
        created: 0,
        owned_by: 'mock',
        context_window: 131072,
        max_tokens: 8192,
        input_modalities: ['text'],
      }],
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const raw = await readBody(req)
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      log('malformed chat request')
    }
    const summary = summarizeChatRequest(body ?? {})
    const model = String(body?.model ?? MODEL)
    const id = `chatcmpl-mock-${Date.now()}`
    const { content } = await resolveContent(body ?? {}, summary)
    if (body?.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(sseChunk(model, id, { role: 'assistant', content: '' }, null))
      // Split over a few chunks so the client proves streaming; keep the JSON intact.
      const parts = content.length > 8 ? [content.slice(0, 4), content.slice(4, 12), content.slice(12)] : [content]
      for (const part of parts.filter((part) => part !== '')) {
        await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS))
        res.write(sseChunk(model, id, { content: part }, null))
      }
      res.write(sseChunk(model, id, {}, 'stop'))
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    sendJson(res, 200, completionBody(model, content))
    return
  }
  sendJson(res, 404, { error: { message: `unknown path ${req.method} ${url.pathname}` } })
})

server.listen(PORT, HOST, () => {
  log(`listening host=${HOST} port=${PORT} model=${MODEL} reply=${JSON.stringify(state.reply)} predictMode=${state.predictMode}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`shutting down on ${signal}`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
