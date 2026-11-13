import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Plugin Feed</title><link>https://plugin.example</link><description>d</description>
  <item><title>Plugin item</title><link>https://plugin.example/1</link><guid>p1</guid>
    <description>Body</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
</channel></rss>`

function createContext(options = {}) {
  const cleanups = []
  const routes = new Map()
  const rpcHandlers = new Map()
  const tools = []
  const services = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => Promise.resolve()
        },
      },
      rpc: {
        handle(channel, handler) {
          rpcHandlers.set(channel, handler)
          return () => Promise.resolve()
        },
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section() { return () => {} },
    },
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  }
  const ctx = {
    ...services,
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    inject(names, callback) {
      if (names.every(name => services[name] !== undefined)) callback(ctx)
    },
    get(name) { return services[name] },
    on() { return () => {} },
  }
  return { ctx, routes, rpcHandlers, tools, cleanups, services }
}

async function callRoute(route, request) {
  const response = await route.fetch(request)
  const body = await response.json()
  return { status: response.status, body }
}

test('apply wires authenticated routes and agent tools over one operation layer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-plugin-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('plugin.example')) {
      return new Response(FEED, { status: 200, headers: { 'content-type': 'application/xml' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const { ctx, routes, rpcHandlers, tools, cleanups } = createContext()
  try {
    const { apply } = await import('../index.js')
    apply(ctx, { seedFeeds: false, refreshOnStart: false, dataDir: 'rss-test' })

    assert.equal(routes.has('/api/rss.state'), true)
    assert.equal(routes.has('/api/rss.call'), true)
    assert.equal(routes.has('/api/rss.rpc'), true)
    assert.equal(tools.length, 8)
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      'rss_ai', 'rss_article', 'rss_articles', 'rss_discover', 'rss_feeds', 'rss_filters', 'rss_mark', 'rss_refresh',
    ])
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
    }

    const stateRoute = routes.get('/api/rss.state')
    const empty = await callRoute(stateRoute, new Request('http://127.0.0.1/api/rss.state'))
    assert.equal(empty.body.ok, true)
    assert.equal(empty.body.value.feeds.length, 0)

    const rpcRoute = routes.get('/api/rss.rpc')
    const rpcCall = async (payload) => {
      const response = await rpcRoute.fetch(new Request('http://127.0.0.1/api/rss.rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: 'rss.rpc', payload }),
      }))
      const body = await response.json()
      assert.equal(body.type, 'server-response')
      assert.equal(body.rpcId, 'test-rpc')
      return body.result
    }
    const rpcState = await rpcCall({ endpoint: 'state' })
    assert.equal(rpcState.ok, true)
    assert.equal(rpcState.value.feeds.length, 0)

    const callRouteItem = routes.get('/api/rss.call')
    const added = await callRoute(callRouteItem, new Request('http://127.0.0.1/api/rss.call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'feedAdd', params: { url: 'https://plugin.example/feed.xml' } }),
    }))
    assert.equal(added.body.ok, true, JSON.stringify(added.body))
    assert.equal(added.body.value.feed.title, 'Plugin Feed')

    const state = await callRoute(stateRoute, new Request('http://127.0.0.1/api/rss.state'))
    assert.equal(state.body.value.feeds.length, 1)
    assert.equal(state.body.value.stats.articles, 1)

    const rpcList = await rpcCall({ endpoint: 'call', method: 'articles', params: { view: 'all' } })
    assert.equal(rpcList.ok, true)
    assert.equal(rpcList.value.items.length, 1)

    const rpcFailure = await rpcCall({ endpoint: 'call', method: 'doesNotExist' })
    assert.equal(rpcFailure.ok, false)
    assert.equal(rpcFailure.error.code, 'unknown_method')

    const listTool = tools.find(tool => tool.name === 'rss_articles')
    const listed = await listTool.execute({ view: 'all' }, { signal: new AbortController().signal })
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].title, 'Plugin item')

    const feedsTool = tools.find(tool => tool.name === 'rss_feeds')
    const listedFeeds = await feedsTool.execute({ action: 'list' }, { signal: new AbortController().signal })
    assert.equal(listedFeeds.feeds.length, 1)
    const pruned = await feedsTool.execute({ action: 'pruneInvalid' }, { signal: new AbortController().signal })
    assert.equal(pruned.count, 0)
    const unconfirmed = await feedsTool.execute({ action: 'clear' }, { signal: new AbortController().signal })
    assert.equal(unconfirmed.error.code, 'confirmation_required')

    const discoverTool = tools.find(tool => tool.name === 'rss_discover')
    const inferred = await discoverTool.execute({ action: 'topics' }, { signal: new AbortController().signal })
    assert.equal(Array.isArray(inferred.topics), true)
    assert.equal(inferred.topics.length > 0, true)
    const unmatched = await discoverTool.execute({ action: 'feeds', topics: ['zzz-unmatched-topic-zzz'] }, { signal: new AbortController().signal })
    assert.equal(Array.isArray(unmatched.candidates), true)
    assert.equal(unmatched.candidates.length, 0)
    assert.equal(unmatched.ai.used, false)
    const missingUrls = await discoverTool.execute({ action: 'add' }, { signal: new AbortController().signal })
    assert.equal(missingUrls.error.code, 'bad_request')
    const discovered = await discoverTool.execute({
      action: 'add',
      urls: ['https://sub.plugin.example/feed.xml'],
      category: 'Discovered',
    }, { signal: new AbortController().signal })
    assert.equal(discovered.addedCount, 1, JSON.stringify(discovered))
    assert.equal(discovered.failedCount, 0, JSON.stringify(discovered))
    assert.equal(discovered.state, undefined)

    const unknown = await callRoute(callRouteItem, new Request('http://127.0.0.1/api/rss.call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'doesNotExist' }),
    }))
    assert.equal(unknown.body.ok, false)
    assert.equal(unknown.status, 404)
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch { /* ignore */ }
    }
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto-summarization writes summaries for new articles when enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-plugin-summary-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    FEED.replace('<description>Body</description>', `<description>${'A longer article body that is easy to summarize. '.repeat(4)}</description>`),
    { status: 200, headers: { 'content-type': 'application/xml' } },
  )
  const llm = {
    async prepareCall() {
      return {
        config: {},
        async *stream() {
          yield { type: 'text-delta', text: 'A concise automatic summary.' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const { ctx, routes, cleanups } = createContext({ llm })
  try {
    const { apply } = await import('../index.js')
    apply(ctx, { seedFeeds: false, refreshOnStart: false, dataDir: 'rss-summary-test', autoSummarize: true })
    const call = async (method, params = {}) => {
      const response = await routes.get('/api/rss.call').fetch(new Request('http://127.0.0.1/api/rss.call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
      }))
      return (await response.json()).value
    }
    const added = await call('feedAdd', { url: 'https://plugin.example/feed.xml' })
    assert.equal(added.added, 1)
    let article = null
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const page = await call('articles', { view: 'all' })
      if (page.items[0]?.hasSummary === true) {
        article = await call('article', { id: page.items[0].id, markRead: false })
        break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.notEqual(article, null, 'the automatic summary was not written')
    assert.equal(article.ai.summary, 'A concise automatic summary.')
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch { /* ignore */ }
    }
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})
