import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateFilters, searchScore, relevanceOf, recommendArticles, digestCandidates, recencyWeight, tokenize } from '../src/rank.js'

const base = {
  id: 'a1', feedId: 'f1', title: 'DeepSeek releases a new model', summaryHtml: '<p>AI research update</p>',
  contentHtml: '<p>Details about training and evaluation.</p>', author: 'Ada', tags: ['ai', 'research'],
  publishedAt: new Date().toISOString(), read: false, starred: false, readLater: false,
}

test('filters match configured fields and can mute or highlight', () => {
  const rules = [
    { id: '1', name: 'ads', field: 'title', op: 'contains', value: 'sponsored', type: 'mute', enabled: true },
    { id: '2', name: 'ai', field: 'content', op: 'contains', value: 'training', type: 'highlight', enabled: true },
  ]
  const result = evaluateFilters({ ...base, title: 'Sponsored: a thing' }, rules)
  assert.equal(result.muted, true)
  assert.equal(result.highlighted, true)
  const disabled = evaluateFilters({ ...base, title: 'Sponsored: a thing' }, rules.map(rule => ({ ...rule, enabled: false })))
  assert.equal(disabled.muted, false)
  const regex = evaluateFilters({ ...base, author: 'DeepSeek Team' }, [{ id: '3', name: 'team', field: 'author', op: 'regex', value: '^deepseek', type: 'mute', enabled: true }])
  assert.equal(regex.muted, true)
})

test('search requires every token and scores titles highest', () => {
  assert.equal(searchScore(base, 'deepseek'), 10 + 8)
  assert.equal(searchScore(base, 'deepseek model'), 20)
  assert.equal(searchScore(base, 'deepseek cooking'), 0)
  assert.equal(searchScore(base, 'research'), 9)
  assert.equal(searchScore(base, 'ada'), 4)
  assert.deepEqual(tokenize('A b, a'), ['a', 'b'])
})

test('recency decays and relevance explains its parts', () => {
  const now = Date.now()
  assert.equal(recencyWeight(new Date(now).toISOString(), now), 1)
  assert.equal(recencyWeight(new Date(Date.now() - 72 * 3600_000).toISOString()) < 0.6, true)
  const fresh = relevanceOf(base, { feedWeights: { f1: 2 }, tagWeights: { ai: 4 } })
  assert.equal(fresh.score > 0.4, true)
  assert.equal(fresh.reasons.includes('unread'), true)
  assert.equal(fresh.reasons.length <= 3, true)
  const old = relevanceOf({ ...base, publishedAt: '2020-01-01T00:00:00Z', read: true }, {})
  assert.equal(old.score < fresh.score, true)
})

test('recommendations exclude read articles unless saved', () => {
  const items = [
    { ...base, id: 'new', publishedAt: new Date().toISOString() },
    { ...base, id: 'old', publishedAt: '2020-01-01T00:00:00Z' },
    { ...base, id: 'read', read: true, publishedAt: new Date().toISOString() },
    { ...base, id: 'saved', read: true, starred: true, publishedAt: new Date().toISOString() },
  ]
  const ranked = recommendArticles(items, {})
  assert.equal(ranked.some(entry => entry.article.id === 'read'), false)
  assert.equal(ranked.some(entry => entry.article.id === 'saved'), true)
  assert.equal(ranked[0].article.id, 'new')
  assert.equal(digestCandidates(items, { limit: 2 }).length, 2)
})
