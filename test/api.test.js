import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RssStore } from '../src/store.js'
import { FeedEngine } from '../src/engine.js'
import { createApi } from '../src/api.js'
import { normalizeConfig, SEED_FEEDS } from '../src/config.js'
import { AiFailureError, AiUnavailableError } from '../src/ai.js'

const FEED_V1 = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Integration Feed</title><link>https://integration.example</link><description>d</description>
  <item><title>First</title><link>https://integration.example/1</link><guid>1</guid>
    <description><![CDATA[<p>First body</p><script>alert(1)</script>]]></description>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><category>ai</category></item>
</channel></rss>`

const FEED_V2 = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Integration Feed</title><link>https://integration.example</link><description>d</description>
  <item><title>Second</title><link>https://integration.example/2</link><guid>2</guid>
    <description>Second body</description><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item>
</channel></rss>`

const OPML = `<?xml version="1.0"?><opml version="2.0"><body>
  <outline text="Imported"><outline text="Other" xmlUrl="https://other.example/rss"/></outline>
</body></opml>`

function installFetch() {
  const original = globalThis.fetch
  const requests = []
  let integrationCalls = 0
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, headers: init.headers ?? {} })
    if (url.includes('other.example')) {
      return new Response(FEED_V1.replace('Integration Feed', 'Other Feed'), { status: 200, headers: { 'content-type': 'application/xml' } })
    }
    if (url.includes('openai.com/news/rss.xml')) {
      return new Response(FEED_V1.replace('Integration Feed', 'OpenAI News'), { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    }
    if (url.includes('redirect.example')) {
      return new Response(null, { status: 302, headers: { location: 'https://canon.example/feed' } })
    }
    if (url.includes('canon.example/feed')) {
      return new Response(FEED_V1.replace('Integration Feed', 'Canonical Feed'), { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    }
    if (init.headers && (init.headers['if-none-match'] !== undefined)) {
      return new Response(null, { status: 304, headers: { etag: 'x' } })
    }
    integrationCalls += 1
    return integrationCalls === 1
      ? new Response(FEED_V2, { status: 200, headers: { 'content-type': 'application/xml', etag: '"v2"' } })
      : new Response(FEED_V1, { status: 200, headers: { 'content-type': 'application/xml' } })
  }
  return { restore: () => { globalThis.fetch = original }, requests }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-api-'))
  const config = normalizeConfig({ seedFeeds: false, refreshOnStart: false, requestTimeoutMs: 5000 })
  const store = new RssStore({ filePath: join(dir, 'data.json'), config, logger: { warn() {}, info() {} } })
  await store.open()
  const ai = {
    describe: () => ({ available: false, provider: 'deepseek-official', model: 'deepseek-flash', source: 'fallback' }),
    targetLanguage: () => 'English',
    available: () => false,
    async summarize() { throw new AiUnavailableError() },
    async recommend(articles) {
      return {
        picks: articles.slice(0, 2).map((article, index) => ({ id: article.id, score: 90 - index * 10, reason: `pick ${index + 1}` })),
        route: { provider: 'deepseek-official', model: 'deepseek-flash', available: true },
      }
    },
  }
  const engine = new FeedEngine({ store, config, logger: { warn() {}, info() {} } })
  const api = createApi({ store, engine, ai, config, logger: { warn() {}, info() {} } })
  return {
    api, store, engine, ai, dir,
    cleanup: async () => { await store.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

test('adds a feed, sanitizes content, and lists articles', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    const result = await api.methods.feedAdd({ url: 'https://integration.example/feed.xml', categoryName: 'AI' })
    assert.equal(result.feed.title, 'Integration Feed')
    assert.equal(result.added, 1)
    assert.equal(store.state.feeds.length, 1)
    assert.equal(store.state.categories.some(category => category.name === 'AI'), true)

    const page = await api.methods.articles({ view: 'all' })
    assert.equal(page.total, 1)
    assert.equal(page.items[0].title, 'Second')
    const full = await api.methods.article({ id: page.items[0].id, markRead: true })
    assert.equal(full.read, true)
    assert.match(full.contentHtml, /Second body/)
    assert.equal(full.contentHtml.includes('<script'), false)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('refreshes a feed and deduplicates rows', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    await api.methods.feedAdd({ url: 'https://integration.example/feed.xml' })
    const feedId = store.state.feeds[0].id
    store.state.feeds[0].etag = null
    const refreshed = await api.methods.feedRefresh({ id: feedId })
    assert.equal(refreshed.added, 1)
    assert.equal((await api.methods.articles({ view: 'all' })).total, 2)
    const again = await api.methods.feedRefresh({ id: feedId })
    assert.equal(again.notModified ?? false, false)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('marks, searches, filters, and marks all read', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    await api.methods.feedAdd({ url: 'https://integration.example/feed.xml' })
    const page = await api.methods.articles({ view: 'all' })
    const id = page.items[0].id
    const marked = await api.methods.mark({ id, starred: true, readLater: true })
    assert.equal(marked.starred, true)
    assert.equal(marked.readLater, true)
    assert.equal((await api.methods.articles({ view: 'starred' })).total, 1)
    assert.equal((await api.methods.articles({ view: 'later' })).total, 1)
    assert.equal((await api.methods.articles({ text: 'second body' })).total, 1)
    await api.methods.filterSave({ name: 'no second', field: 'title', op: 'contains', value: 'second', type: 'mute' })
    assert.equal((await api.methods.articles({ view: 'all' })).total, 0)
    const hidden = await api.methods.markAll({ feedId: store.state.feeds[0].id })
    assert.equal(hidden.updated, 0)
    const all = await api.methods.markAll({ feedId: store.state.feeds[0].id, hideMuted: false })
    assert.equal(all.updated, 1)
    assert.equal(Array.isArray(all.ids), true)
    assert.equal(all.ids.length, 1)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('markMany undoes a bulk mark through the shared operation layer', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    await api.methods.feedAdd({ url: 'https://integration.example/feed.xml' })
    const marked = await api.methods.markAll({ feedId: store.state.feeds[0].id })
    assert.equal(marked.updated, 1)
    assert.equal(marked.ids.length, 1)
    assert.equal((await api.methods.articles({ view: 'unread' })).total, 0)
    const undone = await api.methods.markMany({ ids: marked.ids, read: false })
    assert.equal(undone.updated, 1)
    assert.equal((await api.methods.articles({ view: 'unread' })).total, 1)
    await assert.rejects(() => api.methods.markMany({ ids: [] }), (error) => error.code === 'invalid_ids' && error.status === 400)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('feed updates rename, recategorize, tag, and pause a subscription', async () => {
  const fetchMock = installFetch()
  const { api, cleanup } = await setup()
  try {
    const added = await api.methods.feedAdd({ url: 'https://integration.example/feed.xml' })
    const updated = await api.methods.feedUpdate({
      id: added.feed.id,
      title: 'Renamed feed',
      categoryName: 'Reading',
      tags: ['ai', 'news'],
      enabled: false,
    })
    assert.equal(updated.feed.title, 'Renamed feed')
    assert.equal(updated.feed.tags.join(','), 'ai,news')
    assert.equal(updated.feed.enabled, false)
    const state = await api.methods.state()
    assert.equal(state.categories.some(category => category.name === 'Reading'), true)
    assert.equal(state.feeds[0].enabled, false)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('exports and imports OPML through the shared layer', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    await api.methods.feedAdd({ url: 'https://integration.example/feed.xml' })
    const exported = await api.methods.opmlExport()
    assert.match(exported.opml, /integration\.example/)
    const imported = await api.methods.opmlImport({ opml: OPML })
    assert.equal(imported.added, 1)
    assert.equal(store.state.feeds.length, 2)
    assert.equal(store.state.categories.some(category => category.name === 'Imported'), true)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('settings, categories, and AI unavailability surface as errors', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    const saved = await api.methods.settingsSave({ aiProvider: 'deepseek-official', aiModel: 'deepseek-chat', pageSize: 50 })
    assert.equal(saved.settings.aiModel, 'deepseek-chat')
    const category = await api.methods.categoryAdd({ name: 'Podcast' })
    assert.equal(category.category.name, 'Podcast')
    await api.methods.categoryRename({ id: category.category.id, name: 'Product' })
    assert.equal(store.state.categories.some(item => item.name === 'Product'), true)
    await api.methods.categoryRemove({ id: category.category.id })
    assert.equal(store.state.categories.some(item => item.name === 'Product'), false)
    await api.methods.feedAdd({ url: 'https://integration.example/feed.xml' })
    const article = (await api.methods.articles({ view: 'all' })).items[0]
    await assert.rejects(() => api.call('aiSummarize', { id: article.id }), (error) => error instanceof AiUnavailableError)
    await assert.rejects(() => api.call('nope', {}), /Unknown operation/)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('AI recommendation maps picks onto stored articles', async () => {
  const fetchMock = installFetch()
  const { api, cleanup } = await setup()
  try {
    await api.methods.feedAdd({ url: 'https://integration.example/feed.xml' })
    const result = await api.methods.aiRecommend({ limit: 10 })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].title, 'Second')
    assert.equal(result.items[0].score, 90)
    assert.equal(result.items[0].reason, 'pick 1')
    assert.equal(result.items[0].feedTitle, 'Integration Feed')
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

function savedArticle(guid, title = 'Saved seed') {
  return {
    guid,
    title,
    url: `https://saved.example/${guid}`,
    summaryHtml: '',
    contentHtml: '<p>Saved body with enough text.</p>',
    publishedAt: '2024-11-01T00:00:00Z',
  }
}

test('restore, recheck, prune, and clear subscriptions share one operation layer', async () => {
  const fetchMock = installFetch()
  const { api, store, engine, cleanup } = await setup()
  try {
    // Restoring the seeds queues background fetches; this test only covers the merge.
    engine.refreshImported = () => {}
    const restored = await api.methods.feedsRestore()
    assert.equal(restored.addedCount, SEED_FEEDS.length)
    assert.equal(restored.existingCount, 0)
    assert.equal(store.state.feeds.length, SEED_FEEDS.length)
    assert.equal((await api.methods.feedsRestore()).addedCount, 0)

    const first = store.state.feeds[0]
    store.recordFetch(first.id, { error: 'The address was not found.', errorCode: 'upstream_error' })
    const rechecked = await api.methods.feedsRecheck({ ids: [first.id] })
    assert.equal(rechecked.checked, 1)
    assert.equal(rechecked.failed, 0)
    assert.equal(store.state.feeds.find(feed => feed.id === first.id).error, null)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      store.recordFetch(first.id, { error: 'The address was not found.', errorCode: 'upstream_error' })
    }
    assert.equal(store.invalidFeeds().length, 1)
    store.ingest(first.id, [savedArticle('saved-1')])
    const saved = store.state.articles.find(article => article.title === 'Saved seed')
    store.mark(saved.id, { starred: true })

    const pruned = await api.methods.feedsPrune({})
    assert.equal(pruned.count, 1)
    assert.equal(pruned.removed[0].id, first.id)
    assert.equal(pruned.keptArticles, 1)
    assert.equal(store.state.feeds.length, SEED_FEEDS.length - 1)
    assert.equal(store.state.articles.length, 1)
    assert.equal(pruned.state.stats.feeds, SEED_FEEDS.length - 1)

    const cleared = await api.methods.feedsClear()
    assert.equal(cleared.count, SEED_FEEDS.length - 1)
    assert.equal(cleared.keptArticles, 1)
    assert.equal(store.state.feeds.length, 0)
    assert.equal(store.state.articles.length, 1)
    assert.equal(store.state.articles[0].starred, true)
    assert.equal(cleared.state.stats.savedArticles, 1)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('prune removes suspects only when asked to include them', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    const feed = store.upsertFeed({ url: 'https://suspect.example/feed', title: 'Suspect' })
    store.recordFetch(feed.id, { error: 'The address was not found.', errorCode: 'upstream_error' })
    assert.equal((await api.methods.feedsPrune({})).count, 0)
    assert.equal(store.state.feeds.length, 1)
    const result = await api.methods.feedsPrune({ includeSuspect: true })
    assert.equal(result.count, 1)
    assert.equal(result.removed[0].failureCount, 1)
    assert.equal(store.state.feeds.length, 0)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('discovery infers topics, verifies candidates, and hides existing sources', async () => {
  const fetchMock = installFetch()
  const { api, store, ai, cleanup } = await setup()
  try {
    store.state.interests.tags = { ai: 5 }
    const topics = await api.methods.discoverTopics()
    assert.equal(topics.topics.includes('ai'), true)

    store.upsertFeed({ url: 'https://existing.example/feed', title: 'Existing' })
    ai.available = () => true
    ai.suggestFeeds = async ({ topics: used, existing, categories }) => {
      assert.deepEqual(used, ['ai'])
      assert.equal(existing.some(feed => feed.title === 'Existing'), true)
      assert.equal(categories.includes('AI'), true)
      return { feeds: [
        { url: 'https://other.example/feed', title: 'AI Feed', description: 'suggested', category: 'AI', tags: ['ai'], reason: 'relevant' },
        { url: 'https://existing.example/feed', title: 'Existing', description: '', category: '', tags: [], reason: '' },
        { url: 'https://127.0.0.1/feed', title: 'Broken', description: '', category: '', tags: [], reason: '' },
      ] }
    }
    const result = await api.methods.discoverFeeds({ topics: ['ai'], limit: 8 })
    assert.equal(result.ai.used, true)
    assert.equal(result.topics.includes('ai'), true)
    assert.equal(result.existingCount >= 1, true)
    const other = result.candidates.find(candidate => candidate.finalUrl.includes('other.example'))
    assert.equal(other.title, 'Other Feed')
    assert.equal(other.source, 'ai')
    assert.equal(result.skipped.some(item => item.url.includes('127.0.0.1')), true)
    assert.equal(result.candidates.some(candidate => candidate.url.includes('existing.example')), false)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('discovery falls back to the curated catalog when the model fails', async () => {
  const fetchMock = installFetch()
  const { api, ai, store, cleanup } = await setup()
  try {
    const catalogOnly = await api.methods.discoverFeeds({ topics: ['ai'], limit: 8 })
    assert.equal(catalogOnly.ai.available, false)
    assert.equal(catalogOnly.ai.requested, false)
    assert.equal(catalogOnly.candidates.some(candidate => candidate.title === 'OpenAI News' && candidate.source === 'catalog'), true)

    const inferred = await api.methods.discoverFeeds({ limit: 6 })
    assert.equal(inferred.topics.length > 0, true)

    ai.available = () => true
    ai.suggestFeeds = async () => { throw new AiFailureError('model exploded') }
    const failed = await api.methods.discoverFeeds({ topics: ['ai'], limit: 8 })
    assert.equal(failed.ai.error, 'model exploded')
    assert.equal(failed.candidates.some(candidate => candidate.title === 'OpenAI News'), true)

    store.state.categories = []
    store.state.interests = { feeds: {}, tags: {}, keywords: {} }
    await assert.rejects(() => api.methods.discoverFeeds({}), /Choose at least one topic/)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('batch adds selected feeds, skips existing ones, and reports invalid URLs', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    store.upsertFeed({ url: 'https://existing.example/feed', title: 'Existing' })
    const result = await api.methods.feedsAddBatch({
      urls: ['https://other.example/feed', 'https://existing.example/feed', 'javascript:alert(1)'],
      categoryName: 'Discovered',
      tags: ['ai', 'news'],
    })
    assert.equal(result.addedCount, 1)
    assert.equal(result.failedCount, 1)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.added[0].title, 'Other Feed')
    const category = store.state.categories.find(item => item.name === 'Discovered')
    const added = store.state.feeds.find(feed => feed.url.includes('other.example'))
    assert.equal(added.categoryId, category.id)
    assert.deepEqual(added.tags, ['ai', 'news'])
    assert.equal(result.state.stats.articles > 0, true)
    await assert.rejects(() => api.methods.feedsAddBatch({ urls: [] }), /Select at least one feed/)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('discovery excludes a candidate whose redirect lands on an existing feed', async () => {
  const fetchMock = installFetch()
  const { api, store, ai, cleanup } = await setup()
  try {
    store.upsertFeed({ url: 'https://canon.example/feed', title: 'Canonical' })
    ai.available = () => true
    ai.suggestFeeds = async () => ({ feeds: [
      { url: 'https://redirect.example/go', title: 'Redirected', description: '', category: '', tags: [], reason: '' },
    ] })
    const result = await api.methods.discoverFeeds({ topics: ['zzz-unmatched-topic-zzz'], limit: 6 })
    assert.equal(result.existingCount >= 1, true)
    assert.equal(result.candidates.some(candidate => candidate.finalUrl === 'https://canon.example/feed'), false)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})

test('batch add reports existing-only and cancelled requests without adding feeds', async () => {
  const fetchMock = installFetch()
  const { api, store, cleanup } = await setup()
  try {
    store.upsertFeed({ url: 'https://existing.example/feed', title: 'Existing' })
    const skippedOnly = await api.methods.feedsAddBatch({ urls: ['https://existing.example/feed'] })
    assert.equal(skippedOnly.addedCount, 0)
    assert.equal(skippedOnly.failedCount, 0)
    assert.equal(skippedOnly.skipped[0].reason, 'existing')

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => api.methods.feedsAddBatch({ urls: ['https://other.example/feed'], signal: controller.signal }),
      (error) => error?.name === 'AbortError' || error?.code === 'aborted',
    )
    assert.equal(store.state.feeds.length, 1)
  } finally {
    fetchMock.restore()
    await cleanup()
  }
})
