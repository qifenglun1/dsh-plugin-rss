/**
 * RSS reader and DeepSeek AI information hub for DeepSeek Harness.
 *
 * Host half: durable subscriptions and articles in `$DSH_HOME/rss/data.json`,
 * authenticated `/api/rss.*` fetch routes for the Web panel, and agent tools
 * that share the very same operation layer.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from './src/config.js'
import { RssStore } from './src/store.js'
import { RssAi } from './src/ai.js'
import { FeedEngine } from './src/engine.js'
import { createApi } from './src/api.js'
import { registerRssTools, RSS_TOOL_GUIDANCE } from './src/tools.js'

/** Resolve the durable data file without allowing traversal outside $DSH_HOME. */
export function dataFilePath(config) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const segments = String(config.dataDir ?? 'rss')
    .split(/[/\\]+/)
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
  return join(home, ...(segments.length === 0 ? ['rss'] : segments), 'data.json')
}

/** JSON response with no caching. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** Convert one failure into the client envelope's error arm. */
function failureResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500
  const code = typeof error?.code === 'string' ? error.code : 'internal_error'
  const message = error instanceof Error ? error.message : 'The operation failed.'
  return json({ ok: false, error: { code, message } }, status)
}

/** Read a bounded JSON request body. */
async function readJsonBody(request, maxBytes = 12 * 1024 * 1024) {
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const error = new Error('The request body is too large.')
    error.status = 413
    error.code = 'payload_too_large'
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('The request body is not valid JSON.')
    error.status = 400
    error.code = 'invalid_json'
    throw error
  }
}

/**
 * Install the RSS host plugin.
 * @param {object} ctx - Cordis host context.
 * @param {object} rawConfig - validated-by-default plugin configuration.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console
  if (rawConfig !== null && typeof rawConfig === 'object' && rawConfig.feedsYaml !== undefined) {
    logger.warn?.('rss: config.feedsYaml is not supported by this version; add subscriptions from the RSS panel or import an OPML file.')
  }
  const filePath = dataFilePath(config)
  const store = new RssStore({ filePath, config, logger })

  const ai = new RssAi({ ctx, store, config, logger })
  const engine = new FeedEngine({
    store,
    config,
    logger,
    onNewArticles: (feedId, ids) => queueNewArticles(feedId, ids),
  })
  const api = createApi({ store, engine, ai, config, logger, onNewArticles: queueNewArticles })

  let classificationQueue = []
  let classifying = false
  let summaryQueue = []
  let summarizing = false
  let disposed = false
  const classificationLimit = 24
  const summaryLimit = 16

  /** Queue background AI work for newly stored articles. */
  function queueNewArticles(feedId, ids) {
    queueClassification(feedId, ids)
    queueSummaries(ids)
  }

  /** Classify a bounded number of new articles in the background. */
  function queueClassification(feedId, ids) {
    if (disposed || store.openError) return
    if (!store.settings().autoClassify) return
    for (const id of ids.slice(0, 4)) {
      if (classificationQueue.length >= classificationLimit) break
      if (!classificationQueue.includes(id)) classificationQueue.push(id)
    }
    void drainClassification()
  }

  async function drainClassification() {
    if (classifying) return
    classifying = true
    try {
      while (!disposed && classificationQueue.length > 0) {
        const id = classificationQueue.shift()
        const article = store.getArticle(id)
        if (article === undefined || article.ai?.classifiedAt) continue
        try { await ai.classify(article) } catch (error) {
          logger.warn?.(`rss: auto-classification failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      classifying = false
    }
  }

  /** Summarize a bounded number of new articles in the background. */
  function queueSummaries(ids) {
    if (disposed || store.openError) return
    if (!store.settings().autoSummarize || !ai.available()) return
    for (const id of ids.slice(0, 4)) {
      if (summaryQueue.length >= summaryLimit) break
      if (!summaryQueue.includes(id)) summaryQueue.push(id)
    }
    void drainSummaries()
  }

  async function drainSummaries() {
    if (summarizing) return
    summarizing = true
    try {
      while (!disposed && summaryQueue.length > 0) {
        if (!store.settings().autoSummarize) { summaryQueue = []; break }
        const id = summaryQueue.shift()
        const article = store.getArticle(id)
        if (article === undefined || (typeof article.ai?.summary === 'string' && article.ai.summary !== '')) continue
        try { await ai.summarize(article) } catch (error) {
          logger.warn?.(`rss: auto-summary failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      summarizing = false
    }
  }

  // The data file may be created asynchronously; every operation waits for it.
  const ready = store.open().catch((error) => {
    logger.error?.(`rss: opening the data file failed: ${error instanceof Error ? error.message : String(error)}`)
    return store
  })

  /** Reject every operation when the data file could not be opened. */
  async function ensureReady() {
    await ready
    if (store.openError) {
      const error = new Error('The RSS data file could not be opened. Check its permissions and free disk space, then restart DeepSeek Harness. No changes were saved.')
      error.code = 'storage_unavailable'
      error.status = 503
      throw error
    }
  }

  // Wrap every operation so the API, tools, and HTTP routes share one ready gate.
  for (const [name, method] of Object.entries(api.methods)) {
    api.methods[name] = async (...args) => {
      await ensureReady()
      return method(...args)
    }
  }

  let refreshing = false

  /** Refresh when the configured interval has elapsed. */
  async function tick() {
    await ready
    if (disposed || store.openError || refreshing) return
    const settings = store.settings()
    const minutes = Number(settings.refreshMinutes) || 0
    if (minutes <= 0) return
    const last = Date.parse(store.state.settings.lastRefreshAt ?? '') || 0
    const delta = Date.now() - last
    // A future timestamp (clock skew, hand-edited data) must not stall refreshes.
    if (last !== 0 && delta >= -60_000 && delta < minutes * 60_000 - 5_000) return
    refreshing = true
    try {
      const result = await engine.refreshAll()
      logger.info?.(`rss: refreshed ${result.results.length} subscriptions, added ${result.added}, failed ${result.failed}`)
    } catch (error) {
      if (!disposed) logger.warn?.(`rss: scheduled refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      refreshing = false
    }
  }

  // Persist on unload and stop the background work.
  ctx.effect(() => async () => {
    disposed = true
    classificationQueue.length = 0
    engine.dispose()
    await engine.waitForIdle()
    await ready
    await store.close()
  }, 'rss: close the data file')

  // The model-facing tools and their safety guidance.
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => registerRssTools(toolsCtx, api), 'rss: agent tools')
    toolsCtx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(() => promptCtx.systemPrompt.section({
        name: 'tool:rss',
        order: 560,
        text: () => RSS_TOOL_GUIDANCE,
      }), 'rss: tool guidance')
    })
  })

  // Authenticated browser routes. Paths live under the `/api` bridge, so the
  // carrier admits the browser cookie before the handler reads the body.
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    // Transport-neutral client bridge. The client posts this route through
    // ctx.connection.rpc, so the page's installed carrier (HTTP in a browser,
    // the IPC bridge in Desktop) performs the request instead of raw fetch.
    connectionCtx.effect(() => connection.fetch.register({
      path: '/api/rss.rpc',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const reply = (rpcId, result) => Response.json(
          { type: 'server-response', rpcId, result },
          { headers: { 'cache-control': 'no-store' } },
        )
        let envelope
        try {
          envelope = await request.json()
        } catch {
          return reply('invalid-request', { ok: false, error: { code: 'bad_request', message: 'The request body is not JSON.', details: {} } })
        }
        const rpcId = typeof envelope?.rpcId === 'string' && envelope.rpcId !== '' ? envelope.rpcId : 'invalid-request'
        if (envelope?.type !== 'client-request' || envelope?.method !== 'rss.rpc') {
          return reply(rpcId, { ok: false, error: { code: 'bad_request', message: 'Invalid RSS RPC envelope.', details: {} } })
        }
        const payload = envelope.payload !== null && typeof envelope.payload === 'object' ? envelope.payload : {}
        try {
          if (payload.endpoint === 'state') return reply(rpcId, { ok: true, value: await api.methods.state() })
          if (payload.endpoint === 'call') {
            if (typeof payload.method !== 'string' || payload.method === '') {
              return reply(rpcId, { ok: false, error: { code: 'invalid_request', message: 'A method name is required.', details: {} } })
            }
            const params = payload.params !== null && typeof payload.params === 'object' ? { ...payload.params } : {}
            if (request?.signal !== undefined && request.signal !== null) params.signal = request.signal
            return reply(rpcId, { ok: true, value: await api.call(payload.method, params) })
          }
          return reply(rpcId, { ok: false, error: { code: 'not_found', message: `Unknown RSS endpoint: ${String(payload.endpoint)}`, details: {} } })
        } catch (error) {
          return reply(rpcId, {
            ok: false,
            error: {
              code: typeof error?.code === 'string' ? error.code : 'internal_error',
              message: error instanceof Error ? error.message : 'The operation failed.',
              details: {},
            },
          })
        }
      },
    }), 'rss: rpc envelope route')

    connectionCtx.effect(() => connection.fetch.register({
      path: '/api/rss.state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json({ ok: true, value: await api.methods.state() })
        } catch (error) {
          return failureResponse(error)
        }
      },
    }), 'rss: state route')

    connectionCtx.effect(() => connection.fetch.register({
      path: '/api/rss.call',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJsonBody(request)
          if (body === null || typeof body !== 'object' || typeof body.method !== 'string') {
            const error = new Error('A method name is required.')
            error.status = 400
            error.code = 'invalid_request'
            throw error
          }
          const params = body.params !== null && typeof body.params === 'object' ? { ...body.params } : {}
          if (request?.signal !== undefined && request.signal !== null) params.signal = request.signal
          const value = await api.call(body.method, params)
          return json({ ok: true, value })
        } catch (error) {
          return failureResponse(error)
        }
      },
    }), 'rss: operation route')

    // Keep the long-running background work alive only while the Web UI exists.
    connectionCtx.effect(() => {
      const timer = setInterval(() => { void tick() }, 60_000)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'rss: refresh timer')
  })

  // Start the first refresh after boot rather than blocking activation.
  if (config.refreshOnStart) {
    ctx.effect(() => {
      let timer = null
      let cancelled = false
      void ready.then(() => {
        if (cancelled || disposed || store.openError) return
        timer = setTimeout(() => { void tick() }, 4_000)
        timer.unref?.()
      })
      return () => {
        cancelled = true
        if (timer !== null) clearTimeout(timer)
      }
    }, 'rss: first refresh')
  }
}

export default apply
