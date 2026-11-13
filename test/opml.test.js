import test from 'node:test'
import assert from 'node:assert/strict'
import { exportOpml, importOpml } from '../src/opml.js'

test('exports a category-grouped OPML document', () => {
  const categories = [{ id: 'c1', name: 'AI' }, { id: 'c2', name: 'Tech' }]
  const feeds = [
    { id: 'f1', title: 'DeepMind', url: 'https://deepmind.example/rss', siteUrl: 'https://deepmind.example', categoryId: 'c1', tags: ['research'] },
    { id: 'f2', title: 'Verge', url: 'https://verge.example/rss', siteUrl: '', categoryId: 'c2', tags: [] },
    { id: 'f3', title: 'Loose', url: 'https://loose.example/rss', siteUrl: '', categoryId: null, tags: [] },
  ]
  const xml = exportOpml(feeds, categories)
  assert.match(xml, /<opml version="2.0">/)
  assert.match(xml, /text="AI"/)
  assert.match(xml, /xmlUrl="https:\/\/deepmind\.example\/rss"/)
  assert.match(xml, /category="research"/)
  assert.match(xml, /Uncategorized/)
})

test('round-trips its own export', () => {
  const feeds = [
    { id: 'f1', title: 'DeepMind', url: 'https://deepmind.example/rss', siteUrl: 'https://deepmind.example', categoryId: 'c1', tags: ['research'] },
    { id: 'f2', title: 'Verge', url: 'https://verge.example/rss', siteUrl: '', categoryId: 'c2', tags: [] },
  ]
  const categories = [{ id: 'c1', name: 'AI' }, { id: 'c2', name: 'Tech' }]
  const parsed = importOpml(exportOpml(feeds, categories))
  assert.equal(parsed.feeds.length, 2)
  assert.equal(parsed.feeds[0].url, 'https://deepmind.example/rss')
  assert.equal(parsed.feeds[0].category, 'AI')
  assert.deepEqual(parsed.feeds[0].tags, ['research'])
})

test('imports nested outline categories and reports an empty document', () => {
  const xml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="News">
      <outline text="BBC" type="rss" xmlUrl="https://bbc.example/rss" htmlUrl="https://bbc.example"/>
      <outline text="Nested"><outline text="CNN" xmlUrl="https://cnn.example/rss"/></outline>
    </outline>
  </body></opml>`
  const parsed = importOpml(xml)
  assert.equal(parsed.feeds.length, 2)
  assert.equal(parsed.feeds[0].category, 'News')
  assert.equal(parsed.feeds[1].category, 'Nested')
  assert.equal(importOpml('<opml><body></body></opml>').errors.length, 1)
})
