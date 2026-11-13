import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RssStore, createInitialState } from '../src/store.js'
import { normalizeConfig, SEED_FEEDS } from '../src/config.js'
import { normalizeUrl } from '../src/util.js'

const config = normalizeConfig({ seedFeeds: false, maxArticles: 5 })

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-store-'))
  const store = new RssStore({ filePath: join(dir, 'data.json'), config, logger: { warn() {}, info() {} } })
  await store.open()
  return { store, dir, cleanup: async () => { await store.close(); await rm(dir, { recursive: true, force: true }) } }
}

function article(guid, title, publishedAt, extra = {}) {
  return {
    guid, title, url: `https://example.com/${guid}`, summaryHtml: `<p>${title} summary</p>`,
    contentHtml: `<p>${title} body with enough content for tests.</p>`,
    author: 'Ada', publishedAt, updatedAt: publishedAt, tags: ['tech'], image: '', language: 'en',
    ...extra,
  }
}

test('auto-summarization is off by default and persists per-user overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-store-'))
  const filePath = join(dir, 'data.json')
  try {
    assert.equal(normalizeConfig({}).autoSummarize, false)
    assert.equal(normalizeConfig({ autoSummarize: 'on' }).autoSummarize, true)
    const store = new RssStore({ filePath, config, logger: { warn() {}, info() {} } })
    await store.open()
    assert.equal(store.settings().autoSummarize, false)
    store.saveSettings({ autoSummarize: true })
    await store.close()
    const reopened = new RssStore({ filePath, config, logger: { warn() {}, info() {} } })
    await reopened.open()
    assert.equal(reopened.settings().autoSummarize, true)
    await reopened.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('starts with categories and no feeds when seeds are disabled', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const state = createInitialState(config)
    assert.equal(state.feeds.length, 0)
    assert.equal(store.state.categories.length > 0, true)
    const view = store.stateForClient({ available: true, provider: 'p', model: 'm' })
    assert.equal(view.feeds.length, 0)
    assert.equal(view.stats.articles, 0)
  } finally { await cleanup() }
})

test('ingests feeds, dedupes by guid, and preserves reading state', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const feed = store.upsertFeed({ url: 'https://example.com/feed.xml', title: 'Example' })
    const first = store.ingest(feed.id, [article('a', 'Alpha', '2024-01-01T00:00:00Z'), article('b', 'Beta', '2024-01-02T00:00:00Z')])
    assert.equal(first.added, 2)
    const rows = store.listArticles({ view: 'all' }).items
    assert.equal(rows.length, 2)
    assert.equal(rows[0].title, 'Beta')

    const alpha = store.listArticles({ view: 'all' }).items.find(row => row.title === 'Alpha')
    store.mark(alpha.id, { read: true, starred: true })
    const second = store.ingest(feed.id, [article('a', 'Alpha updated', '2024-01-01T00:00:00Z')])
    assert.equal(second.added, 0)
    assert.equal(second.updated, 1)
    const updated = store.getArticle(alpha.id)
    assert.equal(updated.title, 'Alpha updated')
    assert.equal(updated.read, true)
    assert.equal(updated.starred, true)
  } finally { await cleanup() }
})

test('lists unread, starred, later, and per-feed views', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const feedA = store.upsertFeed({ url: 'https://a.example/feed', title: 'A' })
    const feedB = store.upsertFeed({ url: 'https://b.example/feed', title: 'B' })
    store.ingest(feedA.id, [article('a1', 'A one', '2024-03-01T00:00:00Z'), article('a2', 'A two', '2024-03-02T00:00:00Z')])
    store.ingest(feedB.id, [article('b1', 'B one', '2024-03-03T00:00:00Z')])
    const all = store.listArticles({ view: 'all' }).items
    store.mark(all.find(row => row.title === 'A one').id, { read: true })
    store.mark(all.find(row => row.title === 'A two').id, { starred: true })
    store.mark(all.find(row => row.title === 'B one').id, { readLater: true })

    assert.equal(store.listArticles({ view: 'unread' }).total, 2)
    assert.equal(store.listArticles({ view: 'starred' }).total, 1)
    assert.equal(store.listArticles({ view: 'later' }).total, 1)
    assert.equal(store.listArticles({ feedId: feedA.id }).total, 2)
    assert.equal(store.listArticles({ feedId: feedA.id }).items[0].feedTitle, 'A')
    assert.equal(store.counts().unread, 2)
    const page = store.listArticles({ view: 'all', limit: 2 })
    assert.equal(page.items.length, 2)
    assert.equal(page.hasMore, true)
    assert.equal(page.total, 3)
  } finally { await cleanup() }
})

test('search matches title, tags, and content with scoring', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const feed = store.upsertFeed({ url: 'https://s.example/feed', title: 'Search' })
    store.ingest(feed.id, [
      article('x', 'Quantum computing breakthrough', '2024-04-01T00:00:00Z', { tags: ['physics'] }),
      article('y', 'Cooking with cast iron', '2024-04-02T00:00:00Z', { tags: ['food'] }),
    ])
    assert.equal(store.listArticles({ text: 'quantum' }).total, 1)
    assert.equal(store.listArticles({ text: 'physics' }).total, 1)
    assert.equal(store.listArticles({ text: 'cast iron' }).total, 1)
    assert.equal(store.listArticles({ text: 'nonexistent' }).total, 0)
  } finally { await cleanup() }
})

test('content filters mute and highlight matching articles', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const feed = store.upsertFeed({ url: 'https://f.example/feed', title: 'Filters' })
    store.ingest(feed.id, [article('sp', 'Sponsored: buy now', '2024-05-01T00:00:00Z'), article('ok', 'A real story', '2024-05-02T00:00:00Z')])
    store.saveFilter({ name: 'ads', field: 'title', op: 'contains', value: 'sponsored', type: 'mute' })
    store.saveFilter({ name: 'stars', field: 'title', op: 'contains', value: 'real', type: 'highlight' })
    const visible = store.listArticles({ view: 'all', hideMuted: true })
    assert.equal(visible.total, 1)
    assert.equal(visible.items[0].highlighted, true)
    const all = store.listArticles({ view: 'all', hideMuted: false })
    assert.equal(all.total, 2)
    assert.equal(all.items.some(row => row.muted), true)
    assert.throws(() => store.saveFilter({ value: '(', op: 'regex', field: 'title' }), /not valid/)
  } finally { await cleanup() }
})

test('prunes old articles above the cap but keeps starred rows', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const feed = store.upsertFeed({ url: 'https://p.example/feed', title: 'Prune' })
    const items = Array.from({ length: 8 }, (_, index) => article(`p${index}`, `Post ${index}`, `2024-06-0${index + 1}T00:00:00Z`))
    store.ingest(feed.id, items)
    const all = store.listArticles({ view: 'all', limit: 50 }).items
    assert.equal(all.length, 5)
    const survivor = all[all.length - 1]
    store.mark(survivor.id, { starred: true })
    store.ingest(feed.id, [article('new', 'Newest', '2024-07-01T00:00:00Z')])
    assert.equal(store.state.articles.length, 5)
    assert.equal(store.state.articles.some(row => row.starred), true)
  } finally { await cleanup() }
})

test('persists and reloads from the data file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-persist-'))
  const filePath = join(dir, 'data.json')
  const logger = { warn() {}, info() {} }
  const store = new RssStore({ filePath, config, logger })
  await store.open()
  const feed = store.upsertFeed({ url: 'https://persist.example/feed', title: 'Persist' })
  store.ingest(feed.id, [article('z', 'Persisted', '2024-08-01T00:00:00Z')])
  const id = store.listArticles({ view: 'all' }).items[0].id
  store.mark(id, { starred: true })
  await store.close()

  const raw = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.articles.length, 1)

  const reloaded = new RssStore({ filePath, config, logger })
  await reloaded.open()
  assert.equal(reloaded.state.feeds.length, 1)
  assert.equal(reloaded.getArticle(id).starred, true)
  await reloaded.close()
  await rm(dir, { recursive: true, force: true })
})

test('recovers from an unreadable data file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-corrupt-'))
  const filePath = join(dir, 'data.json')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(filePath, '{not json', 'utf8')
  const store = new RssStore({ filePath, config, logger: { warn() {}, info() {} } })
  await store.open()
  assert.equal(store.state.feeds.length, 0)
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test('markAll marks a feed and category read', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const category = store.addCategory('Research')
    const feed = store.upsertFeed({ url: 'https://m.example/feed', title: 'Mark', categoryId: category.id })
    store.ingest(feed.id, [article('m1', 'One', '2024-09-01T00:00:00Z'), article('m2', 'Two', '2024-09-02T00:00:00Z')])
    assert.equal(store.counts().unread, 2)
    assert.equal(store.markAll({ feedId: feed.id }).updated, 2)
    assert.equal(store.counts().unread, 0)
    assert.equal(store.counts().byCategory[category.id], undefined)
  } finally { await cleanup() }
})

test('tracks consecutive failures and marks a feed invalid only at the threshold', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const feed = store.upsertFeed({ url: 'https://bad.example/feed', title: 'Bad' })
    store.recordFetch(feed.id, { error: 'The address was not found.', errorCode: 'upstream_error' })
    assert.equal(store.state.feeds[0].failureCount, 1)
    assert.equal(store.invalidFeeds().length, 0)
    store.recordFetch(feed.id, { error: 'The address was not found.', errorCode: 'upstream_error' })
    const view = store.stateForClient({ available: false })
    assert.equal(view.feeds[0].failureCount, 2)
    assert.equal(view.stats.invalidFeeds, 0)
    assert.equal(view.stats.failingFeeds, 1)
    assert.equal(view.invalidFailureThreshold, 3)
    store.recordFetch(feed.id, { error: 'The address was not found.', errorCode: 'upstream_error' })
    assert.equal(store.invalidFeeds().length, 1)
    assert.equal(store.stateForClient({ available: false }).stats.invalidFeeds, 1)
    store.recordFetch(feed.id, { feed: { title: 'Bad', items: [] } })
    assert.equal(store.state.feeds[0].failureCount, 0)
    assert.equal(store.state.feeds[0].error, null)
    assert.equal(store.state.feeds[0].lastSuccessAt !== null, true)
    assert.equal(store.invalidFeeds().length, 0)
  } finally { await cleanup() }
})

test('restoring default feeds merges missing seeds without touching existing rows', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const existing = store.upsertFeed({ url: 'https://hnrss.org/frontpage', title: 'My HN', tags: ['custom'], customTitle: true })
    store.updateFeed(existing.id, { enabled: false })
    const added = store.restoreDefaultFeeds()
    assert.equal(added.length, SEED_FEEDS.length - 1)
    const hn = store.state.feeds.find(feed => feed.id === existing.id)
    assert.equal(hn.title, 'My HN')
    assert.equal(hn.enabled, false)
    assert.deepEqual(hn.tags, ['custom'])
    assert.equal(store.state.feeds.length, SEED_FEEDS.length)
    assert.equal(store.state.categories.some(category => category.name === 'Technology'), true)
    assert.equal(store.restoreDefaultFeeds().length, 0)
    assert.equal(store.state.feeds.length, SEED_FEEDS.length)
  } finally { await cleanup() }
})

test('a fresh library files every default feed under an existing category', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-store-'))
  const fresh = new RssStore({ filePath: join(dir, 'data.json'), config: normalizeConfig({ seedFeeds: true }), logger: { warn() {}, info() {} } })
  await fresh.open()
  try {
    assert.equal(fresh.state.feeds.length, SEED_FEEDS.length)
    for (const seed of SEED_FEEDS) {
      const feed = fresh.state.feeds.find(item => item.url === normalizeUrl(seed.url))
      assert.ok(feed !== undefined, `${seed.title} is seeded`)
      assert.ok(feed.categoryId !== null, `${seed.title} has a category`)
    }
    for (const name of ['Technology', 'AI', 'Science', 'Recommended']) {
      assert.ok(fresh.state.categories.some(category => category.name === name), `${name} exists`)
    }
  } finally { await fresh.close(); await rm(dir, { recursive: true, force: true }) }
})

test('bulk removal keeps saved articles and drops feed affinity', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const first = store.upsertFeed({ url: 'https://bulk-a.example/feed', title: 'A' })
    const second = store.upsertFeed({ url: 'https://bulk-b.example/feed', title: 'B' })
    store.ingest(first.id, [article('ba1', 'Saved', '2024-10-01T00:00:00Z'), article('ba2', 'Gone', '2024-10-02T00:00:00Z')])
    store.ingest(second.id, [article('bb1', 'Also gone', '2024-10-03T00:00:00Z')])
    const saved = store.state.articles.find(row => row.title === 'Saved')
    store.mark(saved.id, { starred: true })
    const { removed, keptArticles } = store.removeFeeds([first.id, second.id])
    assert.equal(removed.length, 2)
    assert.equal(keptArticles, 1)
    assert.equal(store.state.feeds.length, 0)
    assert.equal(store.state.articles.length, 1)
    assert.equal(store.state.articles[0].starred, true)
    assert.deepEqual(store.state.interests.feeds, {})
    assert.equal(store.counts().saved, 1)
  } finally { await cleanup() }
})

test('an older data file with only an error message starts at one failure', async () => {
  const { mkdtemp, readFile: read } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rss-migrate-'))
  const filePath = join(dir, 'data.json')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(filePath, JSON.stringify({
    version: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    settings: {},
    categories: [],
    feeds: [{ id: 'f-old', url: 'https://old.example/feed', title: 'Old', error: 'The feed could not be reached.' }],
    articles: [],
    filters: [],
    interests: { feeds: {}, tags: {}, keywords: {} },
  }), 'utf8')
  const store = new RssStore({ filePath, config, logger: { warn() {}, info() {} } })
  await store.open()
  assert.equal(store.state.feeds[0].failureCount, 1)
  assert.equal(store.state.feeds[0].errorCode, null)
  assert.equal(store.invalidFeeds().length, 0)
  await store.close()
  const disk = JSON.parse(await read(filePath, 'utf8'))
  assert.equal(disk.feeds[0].failureCount, 1)
  await rm(dir, { recursive: true, force: true })
})
