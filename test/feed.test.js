import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFeed, feedFormat, isValidFeedUrl, decodeBody } from '../src/feed.js'

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com</link>
    <description>Notes about &lt;code&gt;.</description>
    <language>en-us</language>
    <image><url>https://example.com/logo.png</url></image>
    <item>
      <title>First post</title>
      <link>/posts/first</link>
      <guid>post-1</guid>
      <description><![CDATA[<p>Short intro</p>]]></description>
      <content:encoded><![CDATA[<p>Full body with <strong>bold</strong>.</p>]]></content:encoded>
      <dc:creator>Ada</dc:creator>
      <pubDate>Tue, 05 Nov 2024 10:00:00 GMT</pubDate>
      <category>engineering</category>
      <category>rss</category>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/posts/second</link>
      <guid>post-2</guid>
      <description>Plain summary</description>
      <pubDate>2024-11-06T12:30:00Z</pubDate>
    </item>
  </channel>
</rss>`

test('parses RSS 2.0 with content, author, categories, and resolved links', () => {
  const feed = parseFeed(RSS, 'https://example.com/feed.xml')
  assert.equal(feed.title, 'Example Feed')
  assert.equal(feed.siteUrl, 'https://example.com/')
  assert.equal(feed.language, 'en-us')
  assert.equal(feed.image, 'https://example.com/logo.png')
  assert.equal(feed.items.length, 2)
  const first = feed.items[0]
  assert.equal(first.title, 'First post')
  assert.equal(first.url, 'https://example.com/posts/first')
  assert.equal(first.author, 'Ada')
  assert.deepEqual(first.tags, ['engineering', 'rss'])
  assert.match(first.contentHtml, /Full body with <strong>bold<\/strong>/)
  assert.equal(first.contentHtml.startsWith('<p>Full body'), true)
  assert.equal(first.publishedAt, '2024-11-05T10:00:00.000Z')
})

test('parses Atom with xhtml content and alternate links', () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <title>Atom Example</title>
    <subtitle>An atom feed</subtitle>
    <link href="https://atom.example/" rel="alternate"/>
    <entry>
      <id>urn:uuid:1</id>
      <title type="html">Hello &amp;amp; welcome</title>
      <link rel="alternate" href="/a/1"/>
      <updated>2024-10-01T08:00:00Z</updated>
      <author><name>Grace</name></author>
      <category term="ai"/>
      <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Body <em>here</em></p></div></content>
    </entry>
  </feed>`
  const feed = parseFeed(atom, 'https://atom.example/feed.xml')
  assert.equal(feed.title, 'Atom Example')
  assert.equal(feed.description, 'An atom feed')
  assert.equal(feed.items.length, 1)
  const item = feed.items[0]
  assert.equal(item.url, 'https://atom.example/a/1')
  assert.equal(item.author, 'Grace')
  assert.deepEqual(item.tags, ['ai'])
  assert.match(item.contentHtml, /Body <em>here<\/em>/)
  assert.equal(item.title, 'Hello & welcome')
})

test('parses RSS 1.0 RDF feeds', () => {
  const rdf = `<?xml version="1.0"?>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
    <channel rdf:about="https://rdf.example/"><title>RDF Feed</title><link>https://rdf.example/</link><description>old school</description></channel>
    <item rdf:about="https://rdf.example/1"><title>RDF item</title><link>https://rdf.example/1</link><description>Body</description><dc:date>2024-01-01</dc:date></item>
  </rdf:RDF>`
  const feed = parseFeed(rdf, 'https://rdf.example/feed.rdf')
  assert.equal(feed.title, 'RDF Feed')
  assert.equal(feed.items.length, 1)
  assert.equal(feed.items[0].url, 'https://rdf.example/1')
})

test('parses JSON Feed and deduplicates guids', () => {
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JSON Feed',
    home_page_url: 'https://json.example/',
    items: [
      { id: '1', url: 'https://json.example/1', title: 'One', content_html: '<p>one</p>', date_published: '2024-05-01T00:00:00Z' },
      { id: '1', url: 'https://json.example/1', title: 'One updated', content_html: '<p>one v2</p>', date_published: '2024-05-01T00:00:00Z' },
    ],
  })
  const feed = parseFeed(json, 'https://json.example/feed.json')
  assert.equal(feed.title, 'JSON Feed')
  assert.equal(feed.items.length, 1)
  assert.equal(feed.items[0].title, 'One updated')
})

test('rejects non-feed documents and validates URLs', () => {
  assert.throws(() => parseFeed('<html><body>not a feed</body></html>', 'https://example.com'), /not a supported/)
  assert.throws(() => parseFeed('', 'https://example.com'), /empty/)
  assert.equal(isValidFeedUrl('https://example.com/feed'), true)
  assert.equal(isValidFeedUrl('ftp://example.com/feed'), false)
  assert.equal(feedFormat(RSS), 'rss')
  assert.equal(feedFormat('{"version":"https://jsonfeed.org/version/1"}'), 'jsonfeed')
})

test('decodes a UTF-8 body and a declared charset', () => {
  const utf8 = new TextEncoder().encode('<rss><channel><title>中文</title></channel></rss>')
  assert.match(decodeBody(utf8, 'application/xml; charset=utf-8'), /中文/)
})
