import test from 'node:test'
import assert from 'node:assert/strict'
import { RssAi, AiUnavailableError, AiFailureError, stripSummaryLabel } from '../src/ai.js'

function makeStore() {
  const rows = new Map()
  return {
    settings() {
      return { aiProvider: '', aiModel: '', translateTo: '', preferredLanguage: '', autoClassify: false }
    },
    stateForClient() {
      return { feeds: [{ id: 'f1', title: 'Example' }], categories: [{ name: 'AI' }, { name: 'Technology' }] }
    },
    updateArticle(id, patch) {
      const current = rows.get(id) ?? { id, ai: {}, tags: [] }
      rows.set(id, { ...current, ...patch, ai: { ...current.ai, ...(patch.ai ?? {}) } })
      return rows.get(id)
    },
    getArticle(id) { return rows.get(id) },
    rows,
  }
}

function makeCtx(answer, { model = true } = {}) {
  const llm = {
    async prepareCall(config) {
      return {
        config,
        async *stream() {
          yield { type: 'text-delta', text: answer }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    listProviders() { return [{ id: 'deepseek-official', name: 'DeepSeek' }] },
    async listModels() { return [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
  }
  return {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel' && model) return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      return undefined
    },
  }
}

const article = {
  id: 'a1', feedId: 'f1', title: 'A title', url: 'https://example.com/a', author: 'Ada',
  publishedAt: '2024-01-01T00:00:00Z', language: 'en', tags: ['ai'],
  summaryHtml: '<p>summary</p>', contentHtml: '<p>Body text that is long enough to summarize.</p>', ai: {},
}

test('summarizes, caches, and resolves the default model route', async () => {
  const store = makeStore()
  const ai = new RssAi({ ctx: makeCtx('**TL;DR** one line'), store, config: { aiMaxInputChars: 4000 } })
  const route = ai.describe()
  assert.equal(route.provider, 'deepseek-official')
  assert.equal(route.model, 'deepseek-flash')
  assert.equal(route.source, 'default-model')
  const result = await ai.summarize(article)
  assert.equal(result.summary, 'one line')
  assert.equal(store.rows.get('a1').ai.summary, 'one line')
  assert.equal(store.rows.get('a1').ai.summaryLanguage, 'Simplified Chinese (简体中文)')
})

test('translates into the requested language', async () => {
  const store = makeStore()
  const ai = new RssAi({ ctx: makeCtx('译文'), store, config: { aiMaxInputChars: 4000 } })
  const result = await ai.translate(article, { to: 'English' })
  assert.equal(result.translation, '译文')
  assert.equal(store.rows.get('a1').ai.translationLang, 'English')
})

test('parses classification JSON and merges tags', async () => {
  const store = makeStore()
  const answer = '```json\n{"categories":["AI"],"tags":["transformer","training"],"relevance":88}\n```'
  const ai = new RssAi({ ctx: makeCtx(answer), store, config: { aiMaxInputChars: 4000 } })
  const result = await ai.classify(article)
  assert.deepEqual(result.categories, ['AI'])
  assert.deepEqual(result.tags, ['transformer', 'training'])
  assert.equal(result.relevance, 88)
  assert.deepEqual(store.rows.get('a1').tags, ['ai', 'transformer', 'training'])
})

test('rejects classification answers that are not JSON', async () => {
  const store = makeStore()
  const ai = new RssAi({ ctx: makeCtx('no json here'), store, config: { aiMaxInputChars: 4000 } })
  await assert.rejects(() => ai.classify(article), (error) => error instanceof AiFailureError)
})

test('answers a grounded question and writes a brief', async () => {
  const store = makeStore()
  const ai = new RssAi({ ctx: makeCtx('Because the article says so.'), store, config: { aiMaxInputChars: 4000 } })
  const answer = await ai.ask(article, { question: 'Why?', history: [{ role: 'user', content: 'Hi' }] })
  assert.match(answer.answer, /article says/)
  const brief = await ai.brief([article], { language: 'English' })
  assert.match(brief.brief, /article says/)
})

test('suggests three article-grounded questions in the article language', async () => {
  const store = makeStore()
  let system = ''
  let prompt = ''
  const llm = {
    async prepareCall(config) {
      return {
        config,
        async *stream(options) {
          system = options.system
          prompt = options.messages[0].content[0].text
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              questions: [
                'Why did the launch slip?',
                'What changes for users?',
                'What is the next milestone?',
                'A fourth question that must be dropped',
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      return undefined
    },
  }
  const ai = new RssAi({ ctx, store, config: { aiMaxInputChars: 4000 } })
  const result = await ai.questions(article)
  assert.deepEqual(result.questions, [
    'Why did the launch slip?',
    'What changes for users?',
    'What is the next milestone?',
  ])
  assert.equal(result.language, 'English')
  assert.match(system, /English/)
  assert.match(prompt, /exactly 3/)
  assert.equal(result.route.model, 'deepseek-flash')

  const followUp = await ai.questions(article, {
    history: [
      { role: 'user', content: 'What changed?' },
      { role: 'assistant', content: 'The launch date moved to May.' },
    ],
  })
  assert.equal(followUp.questions.length, 3)
  assert.match(system, /follow-up questions/i)
  assert.match(prompt, /Conversation so far:/)
  assert.match(prompt, /<conversation>/)
  assert.match(prompt, /The launch date moved to May\./)
})

test('reports an unavailable model clearly', async () => {
  const store = makeStore()
  const ai = new RssAi({ ctx: { get: () => undefined }, store, config: {} })
  assert.equal(ai.available(), false)
  await assert.rejects(() => ai.summarize(article), (error) => error instanceof AiUnavailableError)
})

test('lists providers and models', async () => {
  const store = makeStore()
  const ai = new RssAi({ ctx: makeCtx('x'), store, config: {} })
  const models = await ai.models()
  assert.equal(models.providers[0].id, 'deepseek-official')
  assert.equal(models.models['deepseek-official'][0].id, 'deepseek-chat')
})

test('ranks candidate articles and drops unknown or duplicate picks', async () => {
  const store = makeStore()
  const answer = JSON.stringify({ picks: [
    { id: 'a1', score: 91, reason: 'deep analysis' },
    { id: 'missing', score: 99, reason: 'not a candidate' },
    { id: 'a1', score: 10, reason: 'duplicate' },
    { id: 'a2', score: 40, reason: 'useful context' },
  ] })
  const ai = new RssAi({ ctx: makeCtx(answer), store, config: {} })
  const result = await ai.recommend([
    { id: 'a1', title: 'One', feedId: 'f1', tags: ['ai'], summaryHtml: '<p>x</p>' },
    { id: 'a2', title: 'Two', feedId: 'f1', tags: [], summaryHtml: '' },
  ], { profile: { tags: ['ai'], feeds: ['Example'] } })
  assert.deepEqual(result.picks.map(pick => pick.id), ['a1', 'a2'])
  assert.equal(result.picks[0].score, 91)
  assert.equal(result.picks[0].reason, 'deep analysis')
})

test('suggests feed subscriptions for topics and drops unusable entries', async () => {
  const store = makeStore()
  const answer = JSON.stringify({ feeds: [
    { url: 'https://example.com/feed', title: 'Example', description: 'd', category: 'AI', tags: ['ai'], reason: 'matches' },
    { url: 'https://example.com/feed', title: 'Duplicate' },
    { url: 'javascript:alert(1)', title: 'Bad' },
    { url: 'https://second.example/feed', title: 'Second', category: 'Not allowed', tags: ['x'] },
  ] })
  const ai = new RssAi({ ctx: makeCtx(answer), store, config: {} })
  const result = await ai.suggestFeeds({
    topics: ['ai'],
    existing: [{ title: 'Existing', url: 'https://existing.example/feed' }],
    categories: ['AI', 'Technology'],
    limit: 10,
  })
  assert.deepEqual(result.feeds.map(feed => feed.url), ['https://example.com/feed', 'https://second.example/feed'])
  assert.equal(result.feeds[0].category, 'AI')
  assert.equal(result.feeds[0].reason, 'matches')
  assert.equal(result.feeds[1].category, '')
  assert.equal(result.route.provider, 'deepseek-official')
})

test('feed suggestions require a model and usable output', async () => {
  const store = makeStore()
  const unavailable = new RssAi({ ctx: { get: () => undefined }, store, config: {} })
  await assert.rejects(() => unavailable.suggestFeeds({ topics: ['ai'] }), (error) => error instanceof AiUnavailableError)
  const empty = new RssAi({ ctx: makeCtx('{"feeds":[{"url":"not-a-url"}]}'), store, config: {} })
  await assert.rejects(() => empty.suggestFeeds({ topics: ['ai'] }), (error) => error instanceof AiFailureError)
})

test('feed discovery retries token-limited empty answers with a larger budget', async () => {
  const store = makeStore()
  const budgets = []
  let calls = 0
  const llm = {
    async prepareCall(config) {
      budgets.push(config.maxTokens)
      calls += 1
      const attempt = calls
      return {
        config,
        async *stream() {
          if (attempt < 3) {
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          }
          yield { type: 'text-delta', text: '{"feeds":[{"url":"https://x.example/feed","title":"X"}]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      return undefined
    },
  }
  const ai = new RssAi({ ctx, store, config: {}, logger: { warn() {} } })
  const result = await ai.suggestFeeds({ topics: ['ai'] })
  assert.equal(result.feeds.length, 1)
  assert.deepEqual(budgets, [3200, 6400, 8000])
})

test('feed suggestions send topics and existing domains, not article data', async () => {
  const store = makeStore()
  let prompt = ''
  const llm = {
    async prepareCall(config) {
      return {
        config,
        async *stream(options) {
          prompt = options.messages[0].content[0].text
          yield { type: 'text-delta', text: '{"feeds":[{"url":"https://x.example/feed","title":"X"}]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const ai = new RssAi({ ctx, store, config: {} })
  await ai.suggestFeeds({
    topics: ['rust', '安全'],
    existing: [{ title: 'Existing', url: 'https://existing.example/private/feed' }],
    categories: ['Technology'],
  })
  assert.match(prompt, /rust/)
  assert.match(prompt, /安全/)
  assert.match(prompt, /existing\.example/)
  assert.match(prompt, /Technology/)
  assert.doesNotMatch(prompt, /\/private\/feed/)
})

test('strips leading TL;DR markers in common formats', () => {
  assert.equal(stripSummaryLabel('**TL;DR:** one line'), 'one line')
  assert.equal(stripSummaryLabel('**TL;DR** one line'), 'one line')
  assert.equal(stripSummaryLabel('TL;DR: one line'), 'one line')
  assert.equal(stripSummaryLabel('## TL;DR\n\nOne line.'), 'One line.')
  assert.equal(stripSummaryLabel('Too long; didn\'t read — one line'), 'one line')
  assert.equal(stripSummaryLabel('一句话总结：内容'), '一句话总结：内容')
  assert.equal(stripSummaryLabel('**TL;DR:** x\n\n**So what:** y'), 'x\n\ny')
})

test('reports an empty model answer with route diagnostics', async () => {
  const store = makeStore()
  let calls = 0
  const llm = {
    async prepareCall(config) {
      calls += 1
      return { config, async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const ai = new RssAi({ ctx, store, config: {}, logger: { warn() {} } })
  await assert.rejects(() => ai.summarize(article), (error) => {
    assert.match(error.message, /empty answer/)
    assert.match(error.message, /p\/m/)
    return true
  })
  assert.equal(calls, 1)
})

test('reports reasoning without final text', async () => {
  const store = makeStore()
  const llm = {
    async prepareCall(config) {
      return {
        config,
        async *stream() {
          yield { type: 'reasoning-delta', text: 'thinking privately' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const ai = new RssAi({ ctx, store, config: {}, logger: { warn() {} } })
  await assert.rejects(() => ai.summarize(article), /reasoning but no final text/)
})

test('retries once with a larger budget after an empty max-token finish', async () => {
  const store = makeStore()
  let calls = 0
  const llm = {
    async prepareCall(config) {
      calls += 1
      const attempt = calls
      return {
        config,
        async *stream() {
          if (attempt === 1) {
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          }
          yield { type: 'text-delta', text: 'recovered summary' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const ai = new RssAi({ ctx, store, config: {}, logger: { warn() {} } })
  const result = await ai.summarize(article)
  assert.equal(result.summary, 'recovered summary')
  assert.equal(calls, 2)
})

test('refuses to summarize an article without readable text', async () => {
  const store = makeStore()
  const ai = new RssAi({ ctx: makeCtx('x'), store, config: {} })
  await assert.rejects(
    () => ai.summarize({ ...article, contentHtml: '', summaryHtml: '', title: 'Only a title' }),
    (error) => error instanceof AiFailureError && error.code === 'ai_empty_content',
  )
  await assert.rejects(
    () => ai.questions({ ...article, contentHtml: '', summaryHtml: '', title: 'Only a title' }),
    (error) => error instanceof AiFailureError && error.code === 'ai_empty_content',
  )
})
