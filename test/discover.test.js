import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FEED_CATALOG, catalogCandidates, existingFeedKeys, inferTopics, isExistingCandidate,
  mergeCandidates, normalizeTopicList, topicTokens,
} from '../src/discover.js'
import { isValidFeedUrl } from '../src/feed.js'

test('the curated catalog is complete, unique, and uses http(s) URLs', () => {
  assert.equal(FEED_CATALOG.length >= 30, true)
  const urls = new Set()
  for (const entry of FEED_CATALOG) {
    assert.equal(typeof entry.title, 'string')
    assert.equal(entry.title.length > 0, true)
    assert.equal(isValidFeedUrl(entry.url), true, entry.url)
    assert.equal(typeof entry.category, 'string')
    assert.equal(Array.isArray(entry.topics) && entry.topics.length > 0, true, entry.title)
    assert.equal(urls.has(entry.url), false, `duplicate ${entry.url}`)
    urls.add(entry.url)
  }
})

test('topics expand into aliases and split composite labels', () => {
  assert.equal(topicTokens(['AI agents']).includes('ai'), true)
  assert.equal(topicTokens(['人工智能']).includes('ai'), true)
  assert.equal(topicTokens(['machine learning']).includes('ml'), true)
  assert.equal(topicTokens(['js']).includes('javascript'), true)
  assert.equal(normalizeTopicList(['#AI', ' ai ', 'Rust', 'rust']).length, 2)
  assert.equal(normalizeTopicList(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']).length, 8)
  // Prototype keys must not be read as alias lists.
  assert.equal(topicTokens(['constructor']).includes('constructor'), true)
  assert.equal(topicTokens(['__proto__']).includes('__proto__'), true)
  assert.equal(topicTokens(['toString']).includes('tostring'), true)
})

test('catalog candidates rank topic-relevant feeds and ignore unrelated topics', () => {
  const ai = catalogCandidates(['ai', 'llm'], { limit: 6 })
  assert.equal(ai.length > 0, true)
  assert.equal(ai.every(candidate => candidate.source === 'catalog'), true)
  assert.equal(ai.some(candidate => /OpenAI|Hugging Face|DeepMind/i.test(candidate.title)), true)
  assert.equal(ai[0].score >= ai[ai.length - 1].score, true)

  const programming = catalogCandidates(['rust'], { limit: 4 })
  assert.equal(programming.some(candidate => candidate.title === 'Rust Blog'), true)

  assert.deepEqual(catalogCandidates(['zzz-unmatched-topic-zzz']), [])
})

test('inferred topics prefer reading signals, then feed tags and categories', () => {
  const store = {
    state: {
      interests: { tags: { ai: 6, rust: 1 }, feeds: {} },
      articles: [
        { starred: true, tags: ['agents', 'ai'] },
        { readLater: true, tags: ['design'] },
        { starred: false, readLater: false, tags: ['unread-topic'] },
      ],
      feeds: [{ tags: ['programming'] }],
      categories: [{ name: 'Technology' }],
    },
  }
  const topics = inferTopics(store, 8)
  assert.equal(topics[0], 'ai')
  assert.equal(topics.includes('agents'), true)
  assert.equal(topics.includes('design'), true)
  assert.equal(topics.includes('programming'), true)
  assert.equal(topics.includes('Technology'), false)
  assert.equal(topics.length <= 8, true)
})

test('generic feed section labels are filtered out of inferred topics', () => {
  const store = {
    state: {
      interests: { tags: { news: 5, tech: 4, featured: 3, ai: 1 }, feeds: {} },
      articles: [{ starred: true, tags: ['news', 'Featured', 'semiconductors'] }],
      feeds: [{ tags: ['Technology', 'blog'] }],
      categories: [{ name: 'Technology' }, { name: 'AI' }, { name: '新闻' }],
    },
  }
  const topics = inferTopics(store, 8)
  for (const generic of ['News', 'Tech', 'Featured', 'Technology', 'blog', '新闻']) {
    assert.equal(topics.includes(generic), false, `${generic} should be filtered`)
  }
  assert.equal(topics.includes('ai'), true)
  assert.equal(topics.includes('semiconductors'), true)
  assert.equal(topics.length <= 8, true)
})

test('existing subscriptions are detected by exact URL, not shared hosts', () => {
  const keys = existingFeedKeys([
    { url: 'https://feeds.arstechnica.com/arstechnica/index', siteUrl: 'https://arstechnica.com' },
    { url: 'https://example.com/feed.xml', siteUrl: 'https://example.com' },
  ])
  assert.equal(isExistingCandidate({ url: 'https://example.com/feed.xml' }, keys), true)
  assert.equal(isExistingCandidate({ url: 'https://feeds.arstechnica.com/arstechnica/index' }, keys), true)
  assert.equal(isExistingCandidate({ url: 'https://example.com/other-feed' }, keys), false)
  assert.equal(isExistingCandidate({ url: 'https://www.arstechnica.com/other-feed' }, keys), false)
  assert.equal(isExistingCandidate({ finalUrl: 'https://example.com/feed.xml' }, keys), true)
  assert.equal(isExistingCandidate({ url: 'https://unrelated.example/feed' }, keys), false)
})

test('merge candidates deduplicates normalized URLs and drops invalid entries', () => {
  const merged = mergeCandidates([
    { url: 'https://example.com/feed#top', title: 'One' },
    { url: 'https://example.com/feed', title: 'Duplicate' },
    { url: 'javascript:alert(1)', title: 'Bad' },
    { url: 'https://second.example/feed', title: 'Two' },
  ], 10)
  assert.deepEqual(merged.map(candidate => candidate.title), ['One', 'Two'])
  assert.equal(merged[0].url, 'https://example.com/feed')
})
