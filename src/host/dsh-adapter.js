// Host capability adapter for dsh-next-message-predictor.
//
// Every DSH-specific host coupling lives here so the predictor service stays
// business logic. Each method is defensive: a missing capability returns a
// reason string instead of throwing, and the service degrades explicitly.
//
// Verified P0 facts (DSH Desktop/Web 0.2.2-rc.1):
// - `ctx.connection.fetch.register({ path, methods, requestBody, fetch })`
//   is the plugin HTTP surface; the host enforces the /api auth, Host/Origin
//   and owner chain before a plugin handler runs.
// - `ctx.sessions.get(id)` / `ctx.sessions.list()` exist on the host session
//   store (`dsh-session`), and `ctx.agents.get(id)` on the agent registry.
// - `ctx.fiber.entry` + `ctx.get('configEditor').edit(entry, change)` is the
//   documented way for a plugin to persist its own row config.
// - The `settings/document-updated` host event fires after a profile entry's
//   form values change.

import { ENTRY_ID, ROUTE } from '../shared/config.js'

const ROUTE_REGISTERED = Symbol('nmp.route')

/**
 * Resolve a host service without assuming it is composed.
 * @param {object} ctx - Cordis plugin context.
 * @param {string} name - service key.
 */
function tryGetService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** Create the host adapter bound to one plugin fiber. */
export function createHostAdapter(ctx) {
  /** @type {(() => void) | undefined} */
  let disposeRoute

  const connection = tryGetService(ctx, 'connection')
  const configEditor = tryGetService(ctx, 'configEditor')
  const sessions = tryGetService(ctx, 'sessions')
  const agents = tryGetService(ctx, 'agents')

  /**
   * Whether the host can prove the session exists and is live.
   *
   * `ctx.sessions.get(id)` is the authoritative live session store. A cold
   * session that no agent holds open is not resolvable through it; the P2
   * authoritative read (`ctx.sessionQuery.readSurface`) will cover that case.
   * @returns {true | false | undefined} undefined = no session store composed.
   */
  function sessionKnown(sessionId) {
    try {
      if (sessions !== undefined && typeof sessions.get === 'function') {
        return sessions.get(sessionId) !== undefined
      }
    } catch {
      return undefined
    }
    return undefined
  }

  /** Read the resolved row config plus the live entry id, best effort. */
  function currentEntryConfig() {
    try {
      const fiber = ctx.fiber
      const entry = fiber !== undefined ? fiber.entry : undefined
      if (entry === undefined) return undefined
      const options = entry.options ?? {}
      return { id: options.id, config: options.config }
    } catch {
      return undefined
    }
  }

  /**
   * Persist a partial config patch through the profile config editor.
   *
   * The editor validates the complete candidate, serializes the write with
   * other profile changes, and (for ordinary fields) restarts this plugin so
   * `apply` rebuilds state from the new config.
   * @returns {Promise<{ok: true, config: object, restarted: boolean} | {ok: false, error: string}>}
   */
  async function persistConfig(patch) {
    const entry = (() => {
      try {
        return ctx.fiber !== undefined ? ctx.fiber.entry : undefined
      } catch {
        return undefined
      }
    })()
    if (entry === undefined) return { ok: false, error: 'plugin entry is unavailable' }
    if (configEditor === undefined || typeof configEditor.edit !== 'function') {
      return { ok: false, error: 'config editor is unavailable in this composition' }
    }
    let next
    try {
      await configEditor.edit(entry, (current) => {
        next = { ...current, ...patch }
        return next
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, config: next ?? {}, restarted: true }
  }

  /**
   * Register the single POST route and return its disposer.
   *
   * `requestBody: 'streaming'` is deliberate: the buffered mode lets the
   * framework read up to its global cap (hundreds of MiB) before the plugin
   * sees the request, so the 8 KiB protocol cap would only limit later
   * processing. Streaming mode lets this handler bound its own read.
   *
   * @param {(body: unknown, request: Request) => Promise<{status: number, body: unknown}>} handle
   * @param {{bodyLimitBytes?: number}} [options]
   */
  function registerRoute(handle, options) {
    if (connection === undefined || connection.fetch === undefined || typeof connection.fetch.register !== 'function') {
      return { ok: false, error: 'connection.fetch is unavailable' }
    }
    const bodyLimit = normalizeLimit(options === undefined ? undefined : options.bodyLimitBytes)
    disposeRoute = connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        const declaredLength = contentLengthOf(request)
        if (declaredLength !== undefined && declaredLength > bodyLimit) {
          return jsonResponse(413, {
            ok: false,
            error: { code: 'request-too-large', message: `request body exceeds ${bodyLimit} bytes` },
          })
        }
        let text
        try {
          text = await readBoundedText(request, bodyLimit)
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.code === 'too-large') {
            return jsonResponse(413, {
              ok: false,
              error: { code: 'request-too-large', message: `request body exceeds ${bodyLimit} bytes` },
            })
          }
          return jsonResponse(400, { ok: false, error: { code: 'bad-body', message: 'request body could not be read' } })
        }
        let body
        try {
          body = JSON.parse(text)
        } catch {
          return jsonResponse(400, { ok: false, error: { code: 'bad-json', message: 'request body must be JSON' } })
        }
        const response = await handle(body, request)
        return jsonResponse(response.status, response.body)
      },
    })
    return { ok: true, dispose: disposeRoute, route: ROUTE, bodyLimitBytes: bodyLimit }
  }

  return {
    ENTRY_ID,
    ROUTE,
    connectionAvailable: connection !== undefined && connection.fetch !== undefined,
    configEditorAvailable: configEditor !== undefined && typeof configEditor.edit === 'function',
    sessionKnown,
    currentEntryConfig,
    persistConfig,
    registerRoute,
    /** Capability report for status/diagnostics; never a permission proof. */
    capabilities() {
      return {
        connectionFetch: connection !== undefined && connection.fetch !== undefined,
        configEditor: configEditor !== undefined && typeof configEditor.edit === 'function',
        sessionStore: sessions !== undefined && typeof sessions.get === 'function',
        agentRegistry: agents !== undefined && typeof agents.get === 'function',
      }
    },
    /** Buffer limit is enforced by the HTTP framework; report the observed header for diagnostics. */
    contentLength(request) {
      try {
        const raw = request.headers.get('content-length')
        const value = raw === null ? undefined : Number(raw)
        return Number.isFinite(value) ? value : undefined
      } catch {
        return undefined
      }
    },
  }
}

/** Build a JSON Response (Node 24 / browser-compatible global). */
export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** Clamp the protocol body limit into a safe plugin-side range. */
function normalizeLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 8192
  return Math.min(1024 * 1024, Math.max(1024, Math.round(n)))
}

/** Read `content-length` without trusting it as the only bound. */
function contentLengthOf(request) {
  try {
    const raw = request.headers.get('content-length')
    const value = raw === null ? undefined : Number(raw)
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Read the request stream up to `limit` bytes; reject the rest. */
async function readBoundedText(request, limit) {
  if (request.body === null || request.body === undefined) return ''
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      size += value.byteLength
      if (size > limit) {
        const error = new Error('request body too large')
        error.code = 'too-large'
        await reader.cancel().catch(() => {})
        throw error
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already cancelled */
    }
  }
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}
