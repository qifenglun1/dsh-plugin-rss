/**
 * Regression tests for defects found during the QA pass.
 *
 * Each block names the defect it locks down so a future refactor cannot
 * silently reintroduce it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RssStore } from '../src/store.js'
import { normalizeConfig } from '../src/config.js'
import { FeedEngine } from '../src/engine.js'
import { createApi } from '../src/api.js'
import { registerRssTools } from '../src/tools.js'
import { RssAi } from '../src/ai.js'
import { fetchResource, isPrivateHost } from '../src/http.js'
import { parseFeed } from '../src/feed.js'
import { isSafeRegexSource } from '../src/rank.js'
import { apply } from '../index.js'

const quiet = { info() {}, warn() {}, error() {} }
const baseConfig = normalizeConfig({ seedFeeds: false, maxArticles: 100, allowPrivateHosts: true })

async function withStore(t, setup = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-reg-'))
  const store = new RssStore({ filePath: join(dir, 'data.json'), config: { ...baseConfig, ...setup }, logger: quiet })
  await store.open()
  t.after(async () => {
    await store.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  return { store, dir }
}

function article(guid, extra = {}) {
  return {
    id: `art-${guid}`,
    guid,
    title: `Article ${guid}`,
    url: `https://example.com/${guid}`,
    summaryHtml: `<p>Summary ${guid}</p>`,
    contentHtml: `<p>Body ${guid} with enough text to be a real article.</p>`,
    author: 'Ada',
    publishedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tags: ['tech'],
    image: '',
    language: 'en',
    ...extra,
  }
}

/* ------------------------------------------------------------------ *
 * P0-1: markAll must respect the visible view
 * ------------------------------------------------------------------ */

test('markAll only marks the selected category', async (t) => {
  const { store } = await withStore(t)
  const tech = store.categoryIdFor('Technology', true)
  const ai = store.categoryIdFor('AI', true)
  const first = store.upsertFeed({ url: 'https://a.example/feed', title: 'A', categoryId: tech })
  const second = store.upsertFeed({ url: 'https://b.example/feed', title: 'B', categoryId: ai })
  store.ingest(first.id, [article('a1')])
  store.ingest(second.id, [article('b1')])
  const updated = store.markAll({ categoryId: tech }).updated
  assert.equal(updated, 1)
  assert.equal(store.counts().unread, 1)
  assert.equal(store.state.articles.find(row => row.guid === 'b1').read, false)
})

test('markAll only marks the selected tag', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://t.example/feed', title: 'T' })
  store.ingest(feed.id, [article('t1', { tags: ['tech'] }), article('t2', { tags: ['design'] })])
  assert.equal(store.markAll({ tag: 'design' }).updated, 1)
  assert.equal(store.state.articles.find(row => row.guid === 't1').read, false)
})

test('markAll respects the active search query', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://q.example/feed', title: 'Q' })
  store.ingest(feed.id, [article('q1', { title: 'Kubernetes release' }), article('q2', { title: 'Gardening tips' })])
  assert.equal(store.markAll({ text: 'kubernetes' }).updated, 1)
  assert.equal(store.state.articles.find(row => row.guid === 'q2').read, false)
})

test('markAll rejects an unknown view instead of marking the whole library', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://v.example/feed', title: 'V' })
  store.ingest(feed.id, [article('v1')])
  assert.throws(() => store.markAll({ view: 'nonsense' }), (error) => error.code === 'invalid_view' && error.status === 400)
  assert.equal(store.counts().unread, 1)
})

test('markAll returns the changed ids and markMany undoes exactly those', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://u.example/feed', title: 'U' })
  store.ingest(feed.id, [article('u1'), article('u2')])
  const result = store.markAll({ feedId: feed.id })
  assert.equal(result.updated, 2)
  const expected = store.state.articles.map(row => row.id).sort()
  assert.deepEqual([...result.ids].sort(), expected)
  assert.equal(store.counts().unread, 0)

  assert.equal(store.markMany(result.ids, { read: false }), 2)
  assert.equal(store.counts().unread, 2)

  // A repeat or an unknown id must not inflate the count.
  assert.equal(store.markMany(result.ids, { read: false }), 0)
  assert.equal(store.markMany(['art-missing'], { read: true }), 0)
  assert.equal(store.markMany(result.ids, { read: 'yes' }), 0)
})

test('markAll and listArticles respect hidden muted articles', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://mute.example/feed', title: 'Mute' })
  store.ingest(feed.id, [
    article('m1', { title: 'Sponsored: buy now' }),
    article('m2', { title: 'A real story' }),
  ])
  store.saveFilter({ name: 'sponsors', field: 'title', op: 'contains', value: 'sponsored', type: 'mute' })

  const hidden = store.listArticles({ feedId: feed.id })
  assert.equal(hidden.total, 1)
  assert.equal(hidden.mutedHidden, 1)
  const visible = store.listArticles({ feedId: feed.id, hideMuted: false })
  assert.equal(visible.total, 2)
  assert.equal(visible.mutedHidden, 0)

  const first = store.markAll({ feedId: feed.id })
  assert.equal(first.updated, 1)
  assert.deepEqual(first.ids, [store.state.articles.find(row => row.guid === 'm2').id])
  assert.equal(store.markMany(first.ids, { read: false }), 1)

  const every = store.markAll({ feedId: feed.id, hideMuted: false })
  assert.equal(every.updated, 2)
})

/* ------------------------------------------------------------------ *
 * P0-2 / P0-3: persistence safety
 * ------------------------------------------------------------------ */

test('a read-later article survives removing its feed and reopening the store', async (t) => {
  const { store, dir } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://later.example/feed', title: 'Later' })
  store.ingest(feed.id, [article('l1')])
  const row = store.state.articles[0]
  store.mark(row.id, { readLater: true })
  store.removeFeed(feed.id)
  await store.close()
  const reopened = new RssStore({ filePath: join(dir, 'data.json'), config: baseConfig, logger: quiet })
  await reopened.open()
  t.after(() => reopened.close().catch(() => {}))
  assert.equal(reopened.state.articles.length, 1)
  assert.equal(reopened.state.articles[0].readLater, true)
})

test('a failed open never overwrites the existing data file', { skip: process.getuid?.() === 0 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-open-'))
  const file = join(dir, 'data.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const seed = new RssStore({ filePath: file, config: baseConfig, logger: quiet })
  await seed.open()
  seed.upsertFeed({ url: 'https://keep.example/feed', title: 'Keep' })
  await seed.close()

  await chmod(file, 0o000)
  const broken = new RssStore({ filePath: file, config: baseConfig, logger: quiet })
  await assert.rejects(() => broken.open(), (error) => error.code === 'EACCES')
  broken.saveSettings({ pageSize: 55 })
  await broken.flush() // loaded=false: must be a no-op, never a write
  await broken.close()
  await chmod(file, 0o600)

  const disk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(disk.feeds.length, 1)
  assert.equal(disk.feeds[0].url, 'https://keep.example/feed')
  assert.equal(broken.closed, true)
})

test('one failed write does not poison later flushes', async (t) => {
  const { store, dir } = await withStore(t)
  const realWrite = store.writeNow.bind(store)
  let failOnce = true
  store.writeNow = async () => {
    if (failOnce) { failOnce = false; throw new Error('disk full') }
    return realWrite()
  }
  await assert.rejects(() => store.flush(), /disk full/)
  store.upsertFeed({ url: 'https://after.example/feed', title: 'After' })
  await store.flush()
  const disk = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
  assert.equal(disk.feeds.some(feed => feed.url === 'https://after.example/feed'), true)
})

test('a mutation made while close is writing is still persisted', async (t) => {
  const { store, dir } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://race.example/feed', title: 'Race' })
  store.ingest(feed.id, [article('r1')])
  const id = store.state.articles[0].id
  const realWrite = store.writeNow.bind(store)
  let delayed = true
  store.writeNow = async () => {
    if (delayed) { delayed = false; await new Promise(resolve => setTimeout(resolve, 40)) }
    return realWrite()
  }
  const closing = store.close()
  await new Promise(resolve => setTimeout(resolve, 10))
  store.mark(id, { starred: true })
  await closing
  const reopened = new RssStore({ filePath: join(dir, 'data.json'), config: baseConfig, logger: quiet })
  await reopened.open()
  t.after(() => reopened.close().catch(() => {}))
  assert.equal(reopened.state.articles[0].starred, true)
  assert.equal(reopened.lastSaveError, null)
})

/* ------------------------------------------------------------------ *
 * P1: parsing / host freezes / field caps
 * ------------------------------------------------------------------ */

test('catastrophic regular expressions are rejected before they can block the host', async (t) => {
  const { store } = await withStore(t)
  for (const value of ['(a+)+$', '(a|aa)+$', '(?=x)', '(a)\\1', 'a*a*a*a*b']) {
    assert.throws(() => store.saveFilter({ field: 'title', op: 'regex', value }), /freeze the reader/)
  }
  for (const value of ['\\bAI\\b', 'foo|bar', '[0-9]{4}', '^news:']) {
    assert.equal(isSafeRegexSource(value), true)
    store.saveFilter({ field: 'title', op: 'regex', value })
  }
  store.ingest(store.upsertFeed({ url: 'https://re.example/feed', title: 'RE' }).id, [article('re1')])
  const started = Date.now()
  store.listArticles({ view: 'all' })
  assert.equal(Date.now() - started < 500, true)
})

test('descendants() stays linear on a huge item', () => {
  const spans = '<span>x</span>'.repeat(200_000)
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
    <item><title>Item</title><link>https://d.example/1</link><guid>1</guid><description>x</description>${spans}</item>
  </channel></rss>`
  const started = Date.now()
  const parsed = parseFeed(feed, 'https://d.example/feed.xml')
  assert.equal(parsed.items.length, 1)
  assert.equal(Date.now() - started < 2000, true)
})

test('oversized feed fields are clamped before they are persisted', async (t) => {
  const { store, dir } = await withStore(t)
  const hugeLanguage = 'x'.repeat(100_000)
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${hugeLanguage}">
    <title>Big</title><link href="https://big.example/"/>
    ${Array.from({ length: 5 }, (_, index) => `<entry><id>e${index}</id><title>Entry ${index}</title><updated>2026-01-01T00:00:00Z</updated><content type="html">&lt;p&gt;hello&lt;/p&gt;</content></entry>`).join('')}
  </feed>`
  const parsed = parseFeed(atom, 'https://big.example/feed.xml')
  assert.equal(parsed.items[0].language.length, 40)
  const feed = store.upsertFeed({ url: 'https://big.example/feed.xml', title: 'Big' })
  store.ingest(feed.id, parsed.items)
  await store.flush()
  assert.equal(store.state.articles[0].language.length, 40)
  assert.equal((await stat(join(dir, 'data.json'))).size < 100_000, true)
})

test('JSON Feed items that are not objects are skipped', () => {
  const parsed = parseFeed(JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'J',
    items: [null, 42, { id: 'ok', title: 'Valid', content_html: '<p>body</p>' }],
  }), 'https://j.example/feed.json')
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].guid, 'ok')
})

test('Atom article links prefer alternate and never use self or enclosure', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
    <link rel="self" href="https://a.example/feed.xml"/><link rel="alternate" href="https://a.example/"/>
    <entry><id>a1</id><title>One</title>
      <link rel="self" href="https://a.example/feed.xml#1"/>
      <link rel="enclosure" href="https://a.example/audio.mp3"/>
      <link rel="alternate" href="https://a.example/post/1"/>
      <updated>2026-01-01T00:00:00Z</updated><content type="html">&lt;p&gt;x&lt;/p&gt;</content>
    </entry></feed>`
  const parsed = parseFeed(atom, 'https://a.example/feed.xml')
  assert.equal(parsed.items[0].url, 'https://a.example/post/1')
})

test('javascript: and other schemes never become article URLs', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://s.example/</link>
    <item><title>Evil</title><link>javascript:alert(1)</link><guid>e1</guid><description>x</description></item>
  </channel></rss>`
  assert.equal(parseFeed(rss, 'https://s.example/feed.xml').items[0].url, '')
})

test('items without guid, link, or title are not silently merged', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://m.example/</link>
    <item><description>alpha</description></item>
    <item><description>beta</description></item>
    <item><description>gamma</description></item>
  </channel></rss>`
  assert.equal(parseFeed(rss, 'https://m.example/feed.xml').items.length, 3)
})

test('articles without dates do not jump to "now" on every refresh', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://nodate.example/feed', title: 'NoDate' })
  const item = { guid: 'n1', title: 'No date', url: 'https://nodate.example/1', summaryHtml: 'x', contentHtml: 'x' }
  store.ingest(feed.id, [item])
  const first = store.state.articles[0].publishedAt
  await new Promise(resolve => setTimeout(resolve, 5))
  store.ingest(feed.id, [{ ...item }])
  assert.equal(store.state.articles[0].publishedAt, first)
})

/* ------------------------------------------------------------------ *
 * P2: store / api hardening
 * ------------------------------------------------------------------ */

test('updateArticle sanitizes raw HTML before it reaches the reader', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://x.example/feed', title: 'X' })
  store.ingest(feed.id, [article('x1')])
  const id = store.state.articles[0].id
  store.updateArticle(id, { contentHtml: '<p>ok</p><img src=x onerror=alert(1)>' })
  const stored = store.getArticle(id).contentHtml
  assert.equal(/onerror/i.test(stored), false)
  assert.match(stored, /<p>ok<\/p>/)
})

test('repeated read:true does not inflate interest weights', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://i.example/feed', title: 'I' })
  store.ingest(feed.id, [article('i1')])
  const id = store.state.articles[0].id
  store.mark(id, { read: true })
  store.mark(id, { read: true })
  store.mark(id, { read: true })
  assert.equal(store.state.interests.feeds[feed.id], 0.25)
})

test('settings never coerce null or empty strings into valid numbers', async (t) => {
  const { store } = await withStore(t)
  const before = store.settings()
  store.saveSettings({ pageSize: null, refreshMinutes: '' })
  const after = store.settings()
  assert.equal(after.pageSize, before.pageSize)
  assert.equal(after.refreshMinutes, before.refreshMinutes)
})

test('tag counts are safe for prototype-looking tag names', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://p.example/feed', title: 'P' })
  store.ingest(feed.id, [article('p1', { tags: ['constructor', 'prototype', '__proto__'] })])
  assert.equal(store.counts().byTag.constructor, 1)
  assert.equal(store.counts().byTag.prototype, 1)
  assert.equal(typeof Object.prototype.polluted, 'undefined')
})

test('saving two filters with the same value keeps both', async (t) => {
  const { store } = await withStore(t)
  const first = store.saveFilter({ field: 'title', op: 'contains', value: 'same', name: 'one' })
  const second = store.saveFilter({ field: 'title', op: 'contains', value: 'same', name: 'two' })
  assert.notEqual(first.id, second.id)
  assert.equal(store.state.filters.length, 2)
})

test('config never rounds a positive value down to zero', () => {
  const config = normalizeConfig({ maxArticles: 0.4, requestTimeoutMs: 0.4, refreshMinutes: 0.4 })
  assert.equal(config.maxArticles, 1)
  assert.equal(config.requestTimeoutMs, 1)
  assert.equal(config.refreshMinutes, 1)
  assert.equal(normalizeConfig({ timeoutMs: 15_000 }).requestTimeoutMs, 15_000)
})

test('API dispatch uses own methods and preserves failure status codes', async (t) => {
  const { store } = await withStore(t)
  const api = createApi({
    store,
    engine: { validate: async () => { throw new Error('unreachable') }, refreshAll: async () => ({ results: [], added: 0, failed: 0, at: '' }) },
    ai: { describe: () => ({ available: false }), targetLanguage: () => 'English' },
    config: baseConfig,
    logger: quiet,
  })
  await assert.rejects(() => api.call('constructor', {}), (error) => error.code === 'unknown_method' && error.status === 404)
  await assert.rejects(() => api.call('fullText', { id: 'missing' }), (error) => error.code === 'article_not_found' && error.status === 404)
  await assert.rejects(() => api.call('feedAdd', { url: 'not a url' }), (error) => error.code === 'invalid_url' && error.status === 400)
  await assert.rejects(() => api.call('markAll', { view: 'nonsense' }), (error) => error.status === 400)
})

/* ------------------------------------------------------------------ *
 * P1: engine single-flight and per-feed failures
 * ------------------------------------------------------------------ */

test('refreshAll tolerates one failing subscription and still records the pass', async (t) => {
  const { store } = await withStore(t)
  store.upsertFeed({ url: 'https://a.example/feed', title: 'A' })
  store.upsertFeed({ url: 'https://b.example/feed', title: 'B' })
  const engine = new FeedEngine({ store, config: baseConfig, logger: quiet })
  let calls = 0
  engine.refreshFeed = async () => { calls += 1; throw new Error('boom') }
  const result = await engine.refreshAll()
  assert.equal(calls, 2)
  assert.equal(result.failed, 2)
  assert.notEqual(store.state.settings.lastRefreshAt, null)
})

test('concurrent refreshAll calls share one pass', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://s.example/feed', title: 'S' })
  const engine = new FeedEngine({ store, config: baseConfig, logger: quiet })
  let calls = 0
  engine.refreshFeed = async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 20))
    return { feedId: feed.id, added: 0, updated: 0 }
  }
  const [first, second] = await Promise.all([engine.refreshAll(), engine.refreshAll()])
  assert.equal(calls, 1)
  assert.equal(first, second)
})

/* ------------------------------------------------------------------ *
 * P1: HTTP safety and cancellation
 * ------------------------------------------------------------------ */

test('private and loopback hosts are blocked unless explicitly allowed', async (t) => {
  assert.equal(isPrivateHost('127.0.0.1'), true)
  assert.equal(isPrivateHost('127.0.0.1.'), true)
  assert.equal(isPrivateHost('localhost'), true)
  assert.equal(isPrivateHost('localhost.'), true)
  assert.equal(isPrivateHost('169.254.169.254'), true)
  assert.equal(isPrivateHost('10.0.0.7'), true)
  assert.equal(isPrivateHost('example.com'), false)

  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/rss+xml' })
    response.end('<rss version="2.0"><channel><title>x</title></channel></rss>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/feed`
  await assert.rejects(() => fetchResource(base), (error) => error.code === 'blocked_host' && error.status === 400)
  const allowed = await fetchResource(base, { allowPrivateHosts: true })
  assert.equal(allowed.status, 200)
})

test('fetchResource honors a caller AbortSignal and its timeout', async (t) => {
  const server = createServer(() => { /* never respond */ })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/hang`

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(
    () => fetchResource(base, { allowPrivateHosts: true, signal: controller.signal, timeoutMs: 5000 }),
    (error) => error.name === 'AbortError',
  )
  await assert.rejects(
    () => fetchResource(base, { allowPrivateHosts: true, timeoutMs: 60 }),
    (error) => error.code === 'timeout' && error.status === 504,
  )
})

test('fetchResource follows redirects and reports the final URL', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/feed' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/rss+xml' })
    response.end('<rss version="2.0"><channel><title>x</title></channel></rss>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const response = await fetchResource(`${base}/redirect`, { allowPrivateHosts: true })
  assert.equal(response.status, 200)
  assert.equal(response.finalUrl, `${base}/feed`)
})

/* ------------------------------------------------------------------ *
 * P1: tools honor cancellation and unregister cleanly
 * ------------------------------------------------------------------ */

test('tools forward exec.signal and clean up every registration', async () => {
  const seen = []
  const disposed = []
  const ctx = {
    tools: {
      register(definition) {
        disposed.push(definition.name)
        return () => { seen.push(`disposed:${definition.name}`) }
      },
    },
  }
  const methods = new Proxy({}, {
    get: (_, name) => async (params) => {
      seen.push({ method: String(name), params })
      return { ok: true }
    },
  })
  const cleanup = registerRssTools(ctx, { methods })
  assert.equal(typeof cleanup, 'function')
  const signal = new AbortController().signal
  const tool = ctx.tools.register
  assert.equal(typeof tool, 'function')

  // Drive the registered definitions through a fresh registry so we can call execute.
  const definitions = []
  const fakeCtx = { tools: { register(definition) { definitions.push(definition); return () => {} } } }
  registerRssTools(fakeCtx, { methods })
  const feeds = definitions.find(item => item.name === 'rss_feeds')
  await feeds.execute({ action: 'add', url: 'https://f.example/feed', enabled: false }, { signal })
  const addCall = seen.find(entry => entry.method === 'feedAdd')
  assert.equal(addCall.params.signal, signal)
  assert.equal(addCall.params.enabled, false)

  const articleTool = definitions.find(item => item.name === 'rss_article')
  assert.equal(articleTool.isConcurrencySafe({ markRead: false }), true)
  assert.equal(articleTool.isConcurrencySafe({ markRead: true }), false)

  const discover = definitions.find(item => item.name === 'rss_discover')
  await discover.execute({ action: 'feeds', topics: ['ai'] }, { signal })
  const discoverCall = seen.find(entry => entry.method === 'discoverFeeds')
  assert.equal(discoverCall.params.signal, signal)
  assert.deepEqual(discoverCall.params.topics, ['ai'])
  await discover.execute({ action: 'add', urls: ['https://d.example/feed'] }, { signal })
  const batchCall = seen.find(entry => entry.method === 'feedsAddBatch')
  assert.equal(batchCall.params.signal, signal)
  assert.deepEqual(batchCall.params.urls, ['https://d.example/feed'])
  const noUrls = await discover.execute({ action: 'add' }, { signal })
  assert.equal(noUrls.error.code, 'bad_request')
  assert.equal(discover.isConcurrencySafe({ action: 'add' }), false)
  assert.equal(discover.isConcurrencySafe({ action: 'feeds' }), true)

  cleanup()
  assert.equal(seen.filter(value => typeof value === 'string' && value.startsWith('disposed:')).length, 8)
})

/* ------------------------------------------------------------------ *
 * P2: AI timeout, cancellation, and cache hashes
 * ------------------------------------------------------------------ */

test('a provider stream that ignores abort cannot leak an AI slot', async () => {
  const llm = {
    async prepareCall() {
      return {
        config: {},
        async *stream() { await new Promise(() => {}) },
      }
    },
  }
  const ai = new RssAi({ ctx: { get: name => name === 'llm' ? llm : undefined }, store: { settings: () => ({}), stateForClient: () => ({ feeds: [] }) }, config: {} })
  const started = Date.now()
  await assert.rejects(() => ai.complete({ system: 's', prompt: 'p', timeoutMs: 60 }), (error) => error.code === 'ai_timeout' && error.status === 504)
  assert.equal(Date.now() - started < 1000, true)
  assert.equal(ai.inflight, 0)
})

test('cached summaries record a content hash so edits invalidate them', async () => {
  const rows = new Map()
  const store = {
    settings: () => ({ aiProvider: '', aiModel: '', translateTo: '', preferredLanguage: '' }),
    stateForClient: () => ({ feeds: [] }),
    updateArticle(id, patch) {
      const current = rows.get(id) ?? { id, ai: {} }
      rows.set(id, { ...current, ...patch, ai: { ...current.ai, ...(patch.ai ?? {}) } })
      return rows.get(id)
    },
  }
  const llm = {
    async prepareCall() {
      return {
        config: {},
        async *stream() { yield { type: 'text-delta', text: 'One line' }; yield { type: 'finish', reason: { kind: 'stop' } } },
      }
    },
  }
  const ai = new RssAi({ ctx: { get: name => name === 'llm' ? llm : undefined }, store, config: {} })
  const target = article('a1')
  await ai.summarize(target)
  assert.equal(typeof rows.get(target.id).ai.contentHash, 'string')
  await ai.translate(target, { to: 'English' })
  assert.equal(typeof rows.get(target.id).ai.translationHash, 'string')
})

test('a content change invalidates the cached summary', async (t) => {
  const { store } = await withStore(t)
  const feed = store.upsertFeed({ url: 'https://cache.example/feed', title: 'Cache' })
  store.ingest(feed.id, [article('c1')])
  const id = store.state.articles[0].id
  let calls = 0
  const llm = {
    async prepareCall() {
      calls += 1
      return {
        config: {},
        async *stream() { yield { type: 'text-delta', text: 'A fresh summary' }; yield { type: 'finish', reason: { kind: 'stop' } } },
      }
    },
  }
  const ai = new RssAi({ ctx: { get: name => name === 'llm' ? llm : undefined }, store, config: baseConfig })
  const api = createApi({ store, engine: {}, ai, config: baseConfig, logger: quiet })
  assert.equal((await api.methods.aiSummarize({ id })).cached, false)
  assert.equal(calls, 1)
  assert.equal((await api.methods.aiSummarize({ id })).cached, true)
  assert.equal(calls, 1)
  store.updateArticle(id, { contentHtml: '<p>A completely different body after the fact.</p>' })
  assert.equal((await api.methods.aiSummarize({ id })).cached, false)
  assert.equal(calls, 2)
})

test('the first-refresh timer is cancelled on dispose', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-timer-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => { fetches += 1; throw new Error('blocked in test') }
  const cleanups = []
  const services = {
    connection: { fetch: { register() { return () => {} } }, rpc: { handle() { return () => {} } } },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
  }
  const ctx = {
    ...services,
    logger: quiet,
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return () => {} },
    inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(ctx) },
    get(name) { return services[name] },
    on() { return () => {} },
  }
  try {
    apply(ctx, { seedFeeds: true, refreshOnStart: true, refreshMinutes: 30, dataDir: 'reg', requestTimeoutMs: 1000 })
    await new Promise(resolve => setTimeout(resolve, 30))
    for (const cleanup of cleanups.reverse()) { await cleanup() }
    await new Promise(resolve => setTimeout(resolve, 4300))
    assert.equal(fetches, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * Client guards that the render-only harness cannot execute
 * ------------------------------------------------------------------ */

test('host RPC routes forward the request abort signal to operations', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /params\.signal = request\.signal/)
  assert.match(source, /api\.call\(payload\.method, params\)/)
  assert.match(source, /api\.call\(body\.method, params\)/)
})

test('client source keeps the UX-2 interaction guards', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /rss-reading/)
  assert.match(source, /rss-reader-back/)
  assert.match(source, /rss-nav-backdrop/)
  assert.match(source, /const keyboardHandler = useCallback/)
  assert.match(source, /event\.target !== event\.currentTarget/)
  assert.match(source, /scrollTop = 0/)
  assert.match(source, /hostCall\('markMany'/)
  assert.match(source, /hostCall\('feedUpdate'/)
  assert.match(source, /hostCall\('feedRefresh'/)
  assert.match(source, /hostCall\('categoryRename'/)
  assert.match(source, /aria-live/)
  assert.match(source, /aria-current/)
  assert.match(source, /prefers-reduced-motion/)
  assert.match(source, /mutedHidden/)
  assert.match(source, /toast\.undo/)
  assert.match(source, /settings\.invalidRefresh/)
  assert.match(source, /const reloadCurrent = useCallback/)
  assert.match(source, /isComposingEvent/)
  assert.match(source, /lastReaderAction/)
  assert.match(source, /silent: true/)
  assert.match(source, /visibility: hidden/)
  assert.match(source, /rss-filebtn:focus-within/)
  assert.match(source, /onDiscover: openDiscover/)
})

test('client source keeps the markAll, async-id, and retry guards', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /params\.categoryId = view\.id/)
  assert.match(source, /params\.tag = view\.id/)
  assert.match(source, /params\.text = query\.trim\(\)/)
  assert.match(source, /const listSeq = useRef\(0\)/)
  assert.match(source, /previous\.id === targetId/)
  assert.match(source, /const retryable = signal === undefined/)
  assert.match(source, /if \(current\?\.url && \/\^https\?:\\\/\\\/\/i\.test\(current\.url\)\)/)
  assert.match(source, /aliveRef\.current = true/)
})

test('client source auto-summarizes opened articles when the setting is on', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /const autoSummaryTried = useRef\(new Set\(\)\)/)
  assert.match(source, /state\.settings\?\.autoSummarize !== true/)
  assert.match(source, /autoSummaryTried\.current\.delete\(id\)/)
  assert.match(source, /autoSummaryTried\.current\.has\(current\.id\)/)
  assert.match(source, /void summarize\(false\)/)
})

test('client source wires article question suggestions into the ask composer', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /hostCall\('aiQuestions', \{ id, history \}\)/)
  assert.match(source, /const assistantTurns = history\.reduce/)
  assert.match(source, /onQuestions\(id, history\)/)
  assert.match(source, /const chooseQuestion = \(text\) =>/)
  assert.match(source, /setQuestion\(text\)/)
  assert.match(source, /questionInputRef\.current/)
  assert.match(source, /className: 'rss-qa-suggestion'/)
  assert.match(source, /setSelectionRange\?\.\(end, end\)/)
})
