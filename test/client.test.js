import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** A render-only React stand-in; effects and state updates stay inert. */
function createReactMock(queue = []) {
  return {
    createElement(type, props, ...children) {
      const normalized = { ...(props ?? {}) }
      if (children.length === 1) normalized.children = children[0]
      else if (children.length > 1) normalized.children = children
      return { type, props: normalized, children }
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const seeded = queue.length > 0 ? queue.shift() : (typeof initial === 'function' ? initial() : initial)
      return [seeded, () => {}]
    },
    useEffect() {},
    useLayoutEffect() {},
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
    useMemo(factory) { return factory() },
    useCallback(callback) { return callback },
    useRef(value) { return { current: value } },
  }
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function renderTree(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(renderTree)
  if (typeof node.type === 'function') return renderTree(node.type({ ...node.props }))
  return { ...node, children: (node.children ?? []).map(renderTree) }
}

function classesOf(tree) {
  const classes = new Set()
  walk(tree, (node) => {
    const value = node.props?.className
    if (typeof value === 'string') value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name))
  })
  return classes
}

test('the client bundle registers the RSS main panel and sidebar entry', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  let loaded
  const fakeWindow = { __ModuleLoader__: { load(options) { loaded = options } } }
  // The bundle is a script, not a module: evaluate it with a window shim.
  new Function('window', source)(fakeWindow)
  assert.equal(loaded.id, 'dsh-plugin-rss')

  const React = createReactMock()
  const plugin = loaded.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require ${name}`)
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'connection', 'remote', 'remote.pluginManager'])

  const registrations = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    locale: {
      register() { return () => {} },
      bind() { return key => key },
    },
    slots: {
      inject(key, callback) { return callback() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  const main = registrations.find(item => item.options.name === 'main')
  const panel = registrations.find(item => item.options.name === 'sidebar.panellist')
  assert.equal(main.options.key, 'rss')
  assert.equal(panel.options.id, 'rss')
  assert.equal(typeof panel.options.label(), 'string')

  const tree = main.component({ t: key => key, ...main.options.inject() })
  assert.equal(tree.type, 'div')
  const classes = classesOf(renderTree(tree))
  assert.equal(classes.has('rss-page'), true)
  assert.equal(classes.has('rss-nav'), true)
  assert.equal(classes.has('rss-list'), true)
  assert.equal(classes.has('rss-reader'), true)
  assert.equal(classes.has('rss-update-open'), false)

  const icon = panel.component({ size: 18, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 18)

  // A newer registry version puts the update notice at the top of the article list.
  const updateStore = {
    state: { status: 'done', version: '1.2.3', registry: 'https://registry.npmjs.org' },
    getSnapshot: () => updateStore.state,
    subscribe: () => () => {},
  }
  const updated = renderTree(main.component({ t: key => key, ...main.options.inject(), updateStore }))
  const updatedClasses = classesOf(updated)
  assert.equal(updatedClasses.has('rss-banner'), true)
  assert.equal(updatedClasses.has('rss-update-open'), true)
  assert.equal(updatedClasses.has('rss-sr-only'), true)
})

test('the client manifest declares the API Remote dependency used by the update notice', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'), true)
})

test('the update check keeps only installable versions and opens the native plugin page', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  let loaded
  new Function('window', source)({ __ModuleLoader__: { load(options) { loaded = options } } })

  const calls = []
  let opened = null
  const React = createReactMock()
  const plugin = loaded.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require ${name}`)
  })
  const registrations = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    locale: { register() { return () => {} }, bind() { return key => key } },
    slots: {
      inject(key, callback) { return callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
    reflect: {
      get(name) {
        return name === 'pluginNavigation'
          ? { openBundle(packageName) { opened = packageName } }
          : undefined
      },
    },
    remote: {
      get pluginManager() {
        if (!plugin.inject.includes('remote.pluginManager')) {
          throw new Error('cannot get property "remote.pluginManager" without inject')
        }
        return manager
      },
    },
  }
  const manager = {
    async listVersions(name) {
      calls.push(name)
      return {
        ok: true,
        value: {
          status: 'listed', installed: '1.0.0', registry: 'https://registry.npmjs.org',
          attempts: [], omitted: 0,
          versions: [
            { version: '1.2.0-beta.1', bundle: true, tags: ['next'], prerelease: true },
            { version: '1.2.0', bundle: false, tags: [], prerelease: false },
            { version: '1.1.0', bundle: true, tags: ['latest'], prerelease: false },
          ],
        },
      }
    },
  }
  plugin.apply(ctx)
  const main = registrations.find(item => item.options.name === 'main')
  const props = main.options.inject()
  await props.checkForUpdate()
  assert.deepEqual(calls, ['dsh-plugin-rss'])
  assert.equal(props.updateStore.getSnapshot().version, '1.1.0')
  assert.equal(props.updateStore.getSnapshot().registry, 'https://registry.npmjs.org')
  assert.equal(plugin.inject.includes('remote'), true)

  props.openUpdatePage()
  assert.equal(opened, 'dsh-plugin-rss')
  // Returning from Plugins asks again, so an installed update clears the notice.
  await props.checkForUpdate()
  assert.deepEqual(calls, ['dsh-plugin-rss', 'dsh-plugin-rss'])

  // A refused read (local link, Git, tarball or lost network) carries no notice.
  ctx.remote.pluginManager.listVersions = async () => ({ ok: true, value: { status: 'refused', problem: 'not-updatable', reason: 'x', attempts: [] } })
  plugin.apply(ctx)
  const second = registrations.filter(item => item.options.name === 'main').at(-1)
  const secondProps = second.options.inject()
  await secondProps.checkForUpdate()
  assert.equal(secondProps.updateStore.getSnapshot().version, null)

  Object.defineProperty(ctx.remote, 'pluginManager', {
    get() { throw new Error('cannot get required service "remote.pluginManager" in inactive context') },
  })
  await assert.doesNotReject(secondProps.checkForUpdate())
})

test('the loaded panel renders the feed rail, article cards, reader, and AI summary', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  let loaded
  new Function('window', source)({ __ModuleLoader__: { load(options) { loaded = options } } })

  const feed = {
    id: 'f1', url: 'https://example.com/feed', title: 'Example Feed', siteUrl: 'https://example.com',
    description: '', image: '', categoryId: 'c1', categoryName: 'AI', tags: ['ai'], enabled: true,
    error: null, lastFetchedAt: new Date().toISOString(), unread: 2, articleCount: 2,
  }
  const state = {
    settings: { pageSize: 40, aiProvider: '', aiModel: '' },
    feeds: [feed],
    categories: [{ id: 'c1', name: 'AI', order: 0, unread: 2, feedCount: 1 }],
    tags: [{ name: 'ai', count: 2 }],
    counts: { all: 2, unread: 2, starred: 1, later: 0, byFeed: { f1: 2 }, byCategory: { c1: 2 }, byTag: { ai: 2 } },
    filters: [],
    stats: { feeds: 1, articles: 2, unread: 2, starred: 1, later: 0 },
    ai: { available: true, provider: 'deepseek-official', model: 'deepseek-flash', source: 'default-model' },
  }
  const now = new Date().toISOString()
  const rows = {
    items: [
      { id: 'a1', feedId: 'f1', feedTitle: 'Example Feed', title: 'A deep dive', url: 'https://example.com/1', author: 'Ada', publishedAt: now, snippet: 'First snippet', tags: ['ai'], image: '', read: false, starred: true, readLater: false, hasSummary: true, hasTranslation: false, muted: false, highlighted: false, relevance: 80 },
      { id: 'a2', feedId: 'f1', feedTitle: 'Example Feed', title: 'Second story', url: 'https://example.com/2', author: 'Grace', publishedAt: now, snippet: 'Second snippet', tags: [], image: '', read: true, starred: false, readLater: false, hasSummary: false, hasTranslation: false, muted: false, highlighted: false, relevance: 40 },
    ],
    total: 2, hasMore: false, offset: 0, limit: 40, view: 'all',
  }
  const article = {
    id: 'a1', feedId: 'f1', feedTitle: 'Example Feed', feedSiteUrl: 'https://example.com',
    title: 'A deep dive', url: 'https://example.com/1', author: 'Ada', publishedAt: now, updatedAt: now,
    tags: ['ai'], image: '', language: 'en', read: false, starred: true, readLater: false,
    contentHtml: '<p>Body paragraph with enough words to read.</p>', summaryHtml: '<p>summary</p>', contentLength: 44,
    ai: { summary: '**TL;DR** the point.\n\n- first key point\n- second key point', translation: null, translationLang: null, summaryLanguage: 'English' },
  }
  const queue = [state, rows, { kind: 'all' }, '', 'a1', article, null, false, null, null, '', null, null, null, null, false, 'summary', '', [], false, '']
  const React = createReactMock(queue)
  const plugin = loaded.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require ${name}`)
  })
  const registrations = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    locale: { register() { return () => {} }, bind() { return key => key } },
    slots: {
      inject(key, callback) { return callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  const main = registrations.find(item => item.options.name === 'main')
  const tree = renderTree(main.component({ t: key => key, ...main.options.inject() }))
  const classes = classesOf(tree)
  for (const name of ['rss-page', 'rss-nav', 'rss-list', 'rss-reader', 'rss-card', 'rss-reader-title', 'rss-article', 'rss-ai', 'rss-richtext', 'rss-tagchip', 'rss-ai-actions', 'rss-ai-copy']) {
    assert.equal(classes.has(name), true, `missing ${name}`)
  }
  const aiActions = []
  walk(tree, (node) => {
    if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('rss-ai-copy')) aiActions.push(node)
  })
  assert.equal(aiActions.length, 1)
  assert.equal(aiActions[0].props['aria-label'], 'ai.copySummary')
  assert.equal(aiActions[0].props.title, 'ai.copySummary')
  assert.equal(aiActions[0].children.length, 1)
  assert.equal(aiActions[0].children[0].type, 'svg')
  assert.equal(aiActions[0].props.disabled, false)
  const aiTabs = []
  walk(tree, (node) => {
    if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('rss-aitab')) aiTabs.push(node)
  })
  assert.deepEqual(aiTabs.map(node => node.props.children), ['reader.summary', 'reader.ask', 'reader.translate'])
  assert.match(aiTabs[2].props.className, /rss-aitab-end/)
  const titles = []
  walk(tree, (node) => {
    if (node.type === 'h1' || node.type === 'h2') titles.push(node)
  })
  assert.equal(titles.some(node => node.props.children === 'A deep dive'), true)
})

test('every dialog surface renders without throwing', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const makeState = () => ({
    settings: { pageSize: 40, aiProvider: '', aiModel: '', translateTo: '', preferredLanguage: '', autoClassify: false, refreshMinutes: 30 },
    feeds: [{ id: 'f1', url: 'https://e/f', title: 'Example', siteUrl: '', description: '', image: '', categoryId: null, categoryName: '', tags: [], enabled: true, error: null, lastFetchedAt: null, unread: 1, articleCount: 1 }],
    categories: [{ id: 'c1', name: 'AI', order: 0, unread: 1, feedCount: 1 }],
    tags: [{ name: 'ai', count: 1 }],
    counts: { all: 1, unread: 1, starred: 0, later: 0, byFeed: { f1: 1 }, byCategory: { c1: 1 }, byTag: { ai: 1 } },
    filters: [{ id: 'x1', name: 'ads', field: 'title', op: 'contains', value: 'ad', type: 'mute', enabled: true }],
    stats: { feeds: 1, articles: 1, unread: 1 },
    ai: { available: true, provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  const rows = { items: [{ id: 'a1', feedId: 'f1', feedTitle: 'Example', title: 'Story', url: '', author: '', publishedAt: new Date().toISOString(), snippet: '', tags: [], image: '', read: false, starred: false, readLater: false, hasSummary: false, hasTranslation: false, muted: false, highlighted: false }], total: 1, hasMore: false }
  const article = { id: 'a1', feedId: 'f1', feedTitle: 'Example', title: 'Story', url: '', author: '', publishedAt: new Date().toISOString(), tags: [], image: '', read: false, starred: false, readLater: false, contentHtml: '<p>Body</p>', summaryHtml: '', ai: {} }
  const base = dialog => [makeState(), rows, { kind: 'all' }, '', 'a1', article, null, false, null, null, '', null, dialog, null, null, false, 'summary', '', [], false, '']

  const renderPage = (queue, asTree = false) => {
    let loaded
    new Function('window', source)({ __ModuleLoader__: { load(options) { loaded = options } } })
    const React = createReactMock(queue)
    const plugin = loaded.factory(name => { if (name === 'react') return React; throw new Error(name) })
    const registrations = []
    plugin.apply({
      effect(fn) { fn(); return () => {} },
      locale: { register() { return () => {} }, bind() { return key => key } },
      slots: { inject(key, cb) { return cb() }, register(options, component) { registrations.push({ options, component }); return () => {} } },
    })
    const main = registrations.find(item => item.options.name === 'main')
    const tree = renderTree(main.component({ t: key => key, ...main.options.inject() }))
    return asTree ? tree : classesOf(tree)
  }
  const renderDialog = dialog => renderPage(base(dialog))
  const renderSettings = tab => renderPage(base({ type: 'settings', tab }).slice(0, 16))
  const renderSettingsTree = tab => renderPage(base({ type: 'settings', tab }).slice(0, 16), true)

  for (const tab of ['manage', 'general', 'ai', 'filters', 'opml', 'categories', 'shortcuts']) {
    const classes = renderSettings(tab)
    assert.equal(classes.has('rss-settings-page'), true, `${tab}: page`)
    assert.equal(classes.has('rss-settings-nav'), true, `${tab}: nav`)
    assert.equal(classes.has('rss-settings-tab'), true, `${tab}: tab`)
    assert.equal(classes.has('rss-settings-section'), true, `${tab}: section`)
    assert.equal(classes.has('rss-settings-foot'), true, `${tab}: footer`)
  }
  assert.equal(renderSettings('ai').has('rss-settings-card'), true)
  const aiSwitches = []
  walk(renderSettingsTree('ai'), (node) => {
    if (node.props?.role === 'switch') aiSwitches.push(node)
  })
  assert.equal(aiSwitches.length, 2)
  assert.deepEqual(aiSwitches.map(node => node.props['aria-checked']), [false, false])
  assert.equal(renderSettings('filters').has('rss-filter-form'), true)
  assert.equal(renderSettings('filters').has('rss-filter-row'), true)
  const opml = renderSettings('opml')
  assert.equal(opml.has('rss-textarea'), true)
  assert.equal(opml.has('rss-filebtn'), true)
  assert.equal(opml.has('rss-opml-tools'), true)
  assert.equal(opml.has('rss-btn-primary'), true)
  const categories = renderSettings('categories')
  assert.equal(categories.has('rss-category-list'), true)
  assert.equal(categories.has('rss-category-row'), true)
  const manage = renderSettings('manage')
  assert.equal(manage.has('rss-manage-stats'), true)
  assert.equal(manage.has('rss-manage-card'), true)
  assert.equal(manage.has('rss-btn-danger'), true)
  const shortcutsTab = renderSettings('shortcuts')
  assert.equal(shortcutsTab.has('rss-shortcut-group'), true)
  assert.equal(shortcutsTab.has('rss-shortcut-row'), true)
  assert.equal(shortcutsTab.has('rss-settings-foot'), true)

  const askQueue = base(null).slice(0, 16).concat(['ask', '', [], false, '', ['One?', 'Two?', 'Three?'], false])
  const askTree = renderPage(askQueue, true)
  const askSuggestions = []
  walk(askTree, (node) => {
    if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('rss-qa-suggestion')) askSuggestions.push(node)
  })
  assert.deepEqual(askSuggestions.map(node => node.props.children), ['One?', 'Two?', 'Three?'])
  const askInputs = []
  walk(askTree, (node) => { if (node.props?.className === 'rss-input') askInputs.push(node) })
  assert.equal(askInputs[0].props.placeholder, undefined)
  assert.equal(askInputs[0].props['aria-label'], 'reader.ask')
  const askSend = []
  walk(askTree, (node) => { if (node.props?.className === 'rss-qa-send') askSend.push(node) })
  assert.equal(askSend.length, 1)
  assert.equal(askSend[0].props['aria-label'], 'ai.send')
  assert.equal(askSend[0].children.length, 1)
  assert.equal(askSend[0].children[0].type, 'svg')
  const askLoadingTree = renderPage(base(null).slice(0, 16).concat(['ask', '', [], false, '', [], true]), true)
  const askLoadingClasses = classesOf(askLoadingTree)
  assert.equal(askLoadingClasses.has('rss-qa-suggestions'), true)
  assert.equal(askLoadingClasses.has('rss-qa-suggestions-loading'), true)

  const add = renderDialog({ type: 'addFeed' })
  assert.equal(add.has('rss-field'), true)
  const remove = renderDialog({ type: 'removeFeed', feed: { id: 'f1', title: 'Example' } })
  assert.equal(remove.has('rss-btn-danger'), true)
  const recommend = renderDialog({ type: 'recommend', picks: [{ id: 'a1', title: 'Story', score: 92, reason: 'deep', feedTitle: 'Example', publishedAt: new Date().toISOString() }] })
  assert.equal(recommend.has('rss-pick'), true)
  assert.equal(recommend.has('rss-pick-score'), true)
  const markAll = renderDialog({ type: 'confirmMarkAll' })
  assert.equal(markAll.has('rss-modal'), true)
  assert.equal(markAll.has('rss-btn-primary'), true)
})

test('filled controls use a theme-contrast text token instead of hardcoded white', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /\.rss-btn-primary \{[^}]*color: var\(--dsw-alias-bg-base\)/)
  assert.match(source, /\.rss-btn-danger \{[^}]*color: var\(--dsw-alias-bg-base\)/)
  assert.match(source, /\.rss-brand-mark \{[^}]*color: var\(--dsw-alias-bg-base\)/)
  assert.doesNotMatch(source, /\.rss-btn-primary \{[^}]*color: #fff/)
})

test('the AI card width follows the article content column', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /\.rss-ai \{ width: calc\(min\(100%, 820px\) - 68px\);/)
  assert.match(source, /\.rss-ai \{ width: calc\(min\(100%, 820px\) - 48px\); \}/)
  assert.match(source, /\.rss-ai \{ width: calc\(min\(100%, 820px\) - 36px\); \}/)
  assert.doesNotMatch(source, /\.rss-reader-title, \.rss-reader-top, \.rss-reader-meta, \.rss-reader-tags, \.rss-article, \.rss-ai \{ padding-left/)
})

test('the management section lists invalid feeds and the prune and clear dialogs render', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const feed = {
    id: 'f1', url: 'https://broken.example/feed', title: 'Broken Feed', siteUrl: '', description: '', image: '',
    categoryId: null, categoryName: '', tags: [], enabled: true, error: 'The address was not found.',
    errorCode: 'upstream_error', failureCount: 3, lastErrorAt: new Date().toISOString(), lastSuccessAt: null,
    lastFetchedAt: new Date().toISOString(), unread: 0, articleCount: 0,
  }
  const suspect = { ...feed, id: 'f2', url: 'https://flaky.example/feed', title: 'Flaky Feed', failureCount: 1 }
  const state = {
    settings: { pageSize: 40, aiProvider: '', aiModel: '', translateTo: '', preferredLanguage: '', autoClassify: false, refreshMinutes: 30 },
    feeds: [feed, suspect],
    categories: [], tags: [], filters: [],
    counts: { all: 0, unread: 0, starred: 2, later: 1, saved: 3, byFeed: {}, byCategory: {}, byTag: {} },
    stats: { feeds: 2, articles: 0, unread: 0, starred: 2, later: 1, savedArticles: 3, invalidFeeds: 1, failingFeeds: 2 },
    invalidFailureThreshold: 3,
    ai: { available: false, provider: 'deepseek-official', model: 'deepseek-flash' },
  }
  const rows = { items: [], total: 0, hasMore: false }
  const render = (manageDialog, dialog = null) => {
    let loaded
    new Function('window', source)({ __ModuleLoader__: { load(options) { loaded = options } } })
    const queue = [state, rows, { kind: 'all' }, '', null, null, null, false, null, null, '', null, dialog, manageDialog, null, false]
    const React = createReactMock(queue)
    const plugin = loaded.factory(name => { if (name === 'react') return React; throw new Error(name) })
    const registrations = []
    plugin.apply({
      effect(fn) { fn(); return () => {} },
      locale: { register() { return () => {} }, bind() { return key => key } },
      slots: { inject(key, cb) { return cb() }, register(options, component) { registrations.push({ options, component }); return () => {} } },
    })
    const main = registrations.find(item => item.options.name === 'main')
    return classesOf(renderTree(main.component({ t: key => key, ...main.options.inject() })))
  }

  const manage = render(null, { type: 'settings', tab: 'manage' })
  assert.equal(manage.has('rss-manage-stats'), true)
  assert.equal(manage.has('rss-manage-card'), true)
  assert.equal(manage.has('rss-pill'), true)
  assert.equal(manage.has('rss-btn-danger'), true)

  const prune = render({ type: 'pruneFeeds', includeSuspect: false })
  assert.equal(prune.has('rss-manage-list'), true)
  assert.equal(prune.has('rss-manage-item'), true)
  assert.equal(prune.has('rss-manage-item-error'), true)
  assert.equal(prune.has('rss-btn-danger'), true)

  // The prune dialog opens over the settings page instead of replacing it.
  const stacked = render({ type: 'pruneFeeds', includeSuspect: false }, { type: 'settings', tab: 'manage' })
  assert.equal(stacked.has('rss-settings-page'), true)
  assert.equal(stacked.has('rss-manage-item'), true)

  const clear = render({ type: 'clearFeeds', confirmed: false })
  assert.equal(clear.has('rss-manage-check'), true)
  assert.equal(clear.has('rss-btn-danger'), true)
})

test('the discovery page renders topic chips, verified candidates, and the add controls', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const state = {
    settings: { pageSize: 40, aiProvider: '', aiModel: '', translateTo: '', preferredLanguage: '', autoClassify: false, refreshMinutes: 30 },
    feeds: [], categories: [{ id: 'c1', name: 'AI', order: 0, unread: 0, feedCount: 0 }], tags: [], filters: [],
    counts: { all: 0, unread: 0, starred: 0, later: 0, byFeed: {}, byCategory: {}, byTag: {} },
    stats: { feeds: 0, articles: 0, unread: 0 },
    ai: { available: true, provider: 'deepseek-official', model: 'deepseek-flash' },
  }
  const rows = { items: [], total: 0, hasMore: false }
  const result = {
    topics: ['AI', 'Rust'],
    candidates: [{
      url: 'https://example.com/feed', finalUrl: 'https://example.com/feed', title: 'Example Feed',
      siteUrl: 'https://example.com', description: 'A verified suggestion', image: '',
      suggestedCategory: 'AI', tags: ['ai'], matchedTopics: ['ai'], reason: '', source: 'catalog',
    }, {
      url: 'https://existing.example/feed', finalUrl: 'https://existing.example/feed', title: 'Already Here',
      siteUrl: 'https://existing.example', description: '', image: '',
      suggestedCategory: '', tags: [], matchedTopics: [], reason: '', source: 'ai', existing: true,
    }],
    skipped: [],
    existingCount: 1,
    ai: { available: true, requested: true, used: false, error: null },
  }
  const render = (queue) => {
    let loaded
    new Function('window', source)({ __ModuleLoader__: { load(options) { loaded = options } } })
    const React = createReactMock(queue)
    const plugin = loaded.factory(name => { if (name === 'react') return React; throw new Error(name) })
    const registrations = []
    plugin.apply({
      effect(fn) { fn(); return () => {} },
      locale: { register() { return () => {} }, bind() { return key => key } },
      slots: { inject(key, cb) { return cb() }, register(options, component) { registrations.push({ options, component }); return () => {} } },
    })
    const main = registrations.find(item => item.options.name === 'main')
    return classesOf(renderTree(main.component({ t: key => key, ...main.options.inject() })))
  }
  const base = [state, rows, { kind: 'all' }, '', null, null, null, false, null, null, '', null, { type: 'discover' }, null, null, false]
  const empty = render([...base])
  assert.equal(empty.has('rss-discover-page'), true)
  assert.equal(empty.has('rss-discover-topics'), true)
  assert.equal(empty.has('rss-discover-custom'), true)
  assert.equal(empty.has('rss-empty'), true)

  const noSelection = render([...base, ['AI', 'Rust'], [], '', null, null, '', [], '', '', '', {}, ''])
  assert.equal(noSelection.has('rss-topicchip'), true)
  assert.equal(noSelection.has('is-active'), false)

  const filled = render([...base, ['AI', 'Rust'], ['AI'], '', result, null, '', ['https://example.com/feed'], '', '', '', {}, ''])
  for (const name of ['rss-discover-page', 'rss-discover-results', 'rss-discover-card', 'rss-sourcepill', 'rss-discover-addbar', 'rss-topicchip', 'rss-discover-addgrid', 'is-existing', 'is-muted']) {
    assert.equal(filled.has(name), true, `missing ${name}`)
  }
  const recommending = render([...base, ['AI', 'Rust'], ['AI'], '', null, 'recommend', '', [], '', '', '', {}, ''])
  for (const name of ['rss-radar-panel', 'rss-radar', 'rss-radar-ring', 'rss-radar-sweep', 'rss-radar-core', 'rss-radar-dot', 'rss-radar-caption', 'rss-radar-hint']) {
    assert.equal(recommending.has(name), true, `missing ${name}`)
  }
  for (const name of ['rss-discover-topic-actions', 'rss-discover-recommend', 'rss-discover-btn-spin', 'rss-discover-cancel', 'is-searching']) {
    assert.equal(recommending.has(name), true, `missing ${name}`)
  }
  const failedResult = { ...result, candidates: [], existingCount: 0, ai: { ...result.ai, error: 'token limit' } }
  const failed = render([...base, ['AI', 'Rust'], ['AI'], '', failedResult, null, '', [], '', '', '', {}, ''])
  assert.equal(failed.has('rss-banner-row'), true, 'empty AI failure banner')
  assert.equal(failed.has('rss-textbtn'), true, 'empty AI failure retry')
  const partialResult = { ...result, candidates: [result.candidates[0]], existingCount: 0, ai: { ...result.ai, error: 'token limit' } }
  const partial = render([...base, ['AI', 'Rust'], ['AI'], '', partialResult, null, '', [], '', '', '', {}, ''])
  assert.equal(partial.has('rss-banner-row'), true, 'partial AI failure banner')
  assert.equal(partial.has('rss-discover-card'), true, 'partial AI failure keeps curated cards')
  assert.match(source, /hostCall\('discoverTopics'/)
  assert.match(source, /hostCall\('discoverFeeds'/)
  assert.match(source, /limit: 8/)
  assert.match(source, /discover\.aiFailedEmpty/)
  assert.match(source, /cancelRecommend/)
  assert.match(source, /hostCall\('feedsAddBatch'/)
})

test('the edit-feed, rename-category, shortcuts, and discard dialogs render', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const feed = {
    id: 'f1', url: 'https://example.com/feed', title: 'Example', siteUrl: '', description: '', image: '',
    categoryId: 'c1', categoryName: 'AI', tags: ['ai'], enabled: true, error: null,
    lastFetchedAt: null, unread: 1, articleCount: 1,
  }
  const state = {
    settings: { pageSize: 40, aiProvider: '', aiModel: '', translateTo: '', preferredLanguage: '', autoClassify: false, refreshMinutes: 30 },
    feeds: [feed],
    categories: [{ id: 'c1', name: 'AI', order: 0, unread: 1, feedCount: 1 }],
    tags: [{ name: 'ai', count: 1 }],
    counts: { all: 1, unread: 1, starred: 0, later: 0, byFeed: { f1: 1 }, byCategory: { c1: 1 }, byTag: { ai: 1 } },
    filters: [],
    stats: { feeds: 1, articles: 1, unread: 1 },
    ai: { available: true, provider: 'deepseek-official', model: 'deepseek-flash' },
  }
  const rows = { items: [{ id: 'a1', feedId: 'f1', feedTitle: 'Example', title: 'Story', url: '', author: '', publishedAt: new Date().toISOString(), snippet: '', tags: [], image: '', read: false, starred: false, readLater: false, hasSummary: false, hasTranslation: false, muted: false, highlighted: false }], total: 1, hasMore: false }
  const article = { id: 'a1', feedId: 'f1', feedTitle: 'Example', title: 'Story', url: '', author: '', publishedAt: new Date().toISOString(), tags: [], image: '', read: false, starred: false, readLater: false, contentHtml: '<p>Body</p>', summaryHtml: '', ai: {} }
  const render = (dialog, manageDialog = null, extra = []) => {
    let loaded
    new Function('window', source)({ __ModuleLoader__: { load(options) { loaded = options } } })
    const queue = [state, rows, { kind: 'all' }, '', 'a1', article, null, false, null, null, '', null, dialog, manageDialog, null, false, ...extra]
    const React = createReactMock(queue)
    const plugin = loaded.factory(name => { if (name === 'react') return React; throw new Error(name) })
    const registrations = []
    plugin.apply({
      effect(fn) { fn(); return () => {} },
      locale: { register() { return () => {} }, bind() { return key => key } },
      slots: { inject(key, cb) { return cb() }, register(options, component) { registrations.push({ options, component }); return () => {} } },
    })
    const main = registrations.find(item => item.options.name === 'main')
    return classesOf(renderTree(main.component({ t: key => key, ...main.options.inject() })))
  }

  const edit = render({ type: 'editFeed', feed }, null, ['summary', '', [], false, '', 'Example', '', '', 'ai', true, false, ''])
  for (const name of ['rss-modal', 'rss-readonly', 'rss-dialog-actions', 'rss-switch', 'rss-btn-danger']) {
    assert.equal(edit.has(name), true, `edit feed missing ${name}`)
  }

  const shortcuts = render({ type: 'shortcuts' }, null, ['summary', '', [], false, ''])
  assert.equal(shortcuts.has('rss-shortcut-group'), true)
  assert.equal(shortcuts.has('rss-shortcut-row'), true)

  const rename = render({ type: 'settings', tab: 'categories' }, { type: 'renameCategory', category: { id: 'c1', name: 'AI' } })
  assert.equal(rename.has('rss-settings-page'), true)
  assert.equal(rename.has('rss-modal'), true)
  assert.equal(rename.has('rss-category-actions'), true)

  const discard = render({ type: 'settings', tab: 'general' }, { type: 'discardSettings' })
  assert.equal(discard.has('rss-settings-page'), true)
  assert.equal(discard.has('rss-modal'), true)
  assert.equal(discard.has('rss-modal-foot'), true)
})

test('locale dictionaries stay in parity and cover every literal t() key', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const enStart = source.indexOf('const dictEn = {')
  const zhStart = source.indexOf('const dictZh = {')
  const zhEnd = source.indexOf('     * Host API', zhStart)
  assert.ok(enStart > 0 && zhStart > enStart && zhEnd > zhStart)
  const keysOf = block => [...block.matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/gm)].map(match => match[1] ?? match[2])
  const enKeys = keysOf(source.slice(enStart, zhStart))
  const zhKeys = keysOf(source.slice(zhStart, zhEnd))
  const en = new Set(enKeys)
  const zh = new Set(zhKeys)
  assert.deepEqual([...en].sort(), [...zh].sort())
  assert.equal(enKeys.length, en.size, 'duplicate English locale keys')
  assert.equal(zhKeys.length, zh.size, 'duplicate Chinese locale keys')
  const used = [...source.matchAll(/(?<![\w$.])t\('([^']+)'\)/g)]
    .map(match => match[1])
    .filter(key => !/[\s,;]/.test(key))
  for (const key of used) {
    assert.equal(en.has(key), true, `missing en locale key: ${key}`)
    assert.equal(zh.has(key), true, `missing zh locale key: ${key}`)
  }
})

test('the list exposes search, muted, paused, error, toast, drawer, and mobile-reading states', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const feed = {
    id: 'f1', url: 'https://example.com/feed', title: 'Example', siteUrl: '', description: '', image: '',
    categoryId: null, categoryName: '', tags: [], enabled: false, error: null, lastFetchedAt: null, unread: 1, articleCount: 1,
  }
  const state = {
    settings: { pageSize: 40, aiProvider: '', aiModel: '', translateTo: '', preferredLanguage: '', autoClassify: false, refreshMinutes: 30 },
    feeds: [feed],
    categories: [],
    tags: [],
    counts: { all: 1, unread: 1, starred: 0, later: 0, byFeed: { f1: 1 }, byCategory: {}, byTag: {} },
    filters: [],
    stats: { feeds: 1, articles: 1, unread: 1 },
    ai: { available: true, provider: 'deepseek-official', model: 'deepseek-flash' },
  }
  const rows = { items: [{ id: 'a1', feedId: 'f1', feedTitle: 'Example', title: 'Story', url: '', author: '', publishedAt: new Date().toISOString(), snippet: '', tags: [], image: '', read: false, starred: false, readLater: false, hasSummary: false, hasTranslation: false, muted: false, highlighted: false }], total: 1, hasMore: false, mutedHidden: 2 }
  const article = { id: 'a1', feedId: 'f1', feedTitle: 'Example', title: 'Story', url: '', author: '', publishedAt: new Date().toISOString(), tags: [], image: '', read: false, starred: false, readLater: false, contentHtml: '<p>Body</p>', summaryHtml: '', ai: {} }
  const render = (options = {}) => {
    let loaded
    new Function('window', source)({ __ModuleLoader__: { load(options) { loaded = options } } })
    const queue = [
      options.state ?? state,
      options.articles ?? rows,
      options.view ?? { kind: 'feed', id: 'f1' },
      options.query ?? '',
      options.selectedId ?? null,
      options.current ?? null,
      options.loading ?? null,
      false,
      options.busy ?? null,
      null,
      options.errors ?? { list: null, reader: null, ai: null },
      options.toast ?? null,
      options.dialog ?? null,
      options.manageDialog ?? null,
      null,
      options.navOpen ?? false,
      'summary', '', [], false, '',
      ...(options.extra ?? []),
    ]
    const React = createReactMock(queue)
    const plugin = loaded.factory(name => { if (name === 'react') return React; throw new Error(name) })
    const registrations = []
    plugin.apply({
      effect(fn) { fn(); return () => {} },
      locale: { register() { return () => {} }, bind() { return key => key } },
      slots: { inject(key, cb) { return cb() }, register(options, component) { registrations.push({ options, component }); return () => {} } },
    })
    const main = registrations.find(item => item.options.name === 'main')
    return classesOf(renderTree(main.component({ t: key => key, ...main.options.inject() })))
  }

  assert.equal(render({ view: { kind: 'feed', id: 'f1' } }).has('rss-banner-row'), true, 'paused banner')
  assert.equal(render({ view: { kind: 'feed', id: 'f1' } }).has('is-warn'), true, 'paused banner kind')
  assert.equal(render().has('rss-muted-notice'), true, 'muted notice')
  const search = render({ query: 'ai', loading: 'search' })
  assert.equal(search.has('rss-search-spin'), true, 'search spinner')
  assert.equal(search.has('rss-search-clear'), true, 'search clear')
  assert.equal(search.has('is-searching'), true, 'search dim')
  const failed = render({ errors: { list: 'Load failed', reader: null, ai: null } })
  assert.equal(failed.has('rss-banner-row'), true, 'error banner')
  const toast = render({ toast: { text: 'Marked 3 read', kind: 'ok', action: { label: 'Undo', onClick() {} } } })
  assert.equal(toast.has('rss-toast-action'), true, 'toast action')
  assert.equal(render({ navOpen: true }).has('rss-nav-backdrop'), true, 'drawer backdrop')
  const reading = render({ current: article, selectedId: 'a1', view: { kind: 'all' } })
  assert.equal(reading.has('rss-reading'), true, 'mobile reading class')
  assert.equal(reading.has('rss-reader-back'), true, 'reader back button')
  const failedOpen = render({ current: null, selectedId: 'a1', errors: { list: null, reader: 'Nope', ai: null }, view: { kind: 'all' } })
  assert.equal(failedOpen.has('rss-reading'), true, 'failed open keeps reading mode for back/retry')
  assert.equal(failedOpen.has('rss-reader-back'), true, 'failed open has back')
  assert.equal(failedOpen.has('rss-banner-row'), true, 'failed open shows reader error')
})
