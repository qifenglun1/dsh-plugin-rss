import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkup, attr, child, textOf, textOfChild, localName } from '../src/xml.js'

test('parses nested elements, attributes, CDATA, and entities', () => {
  const root = parseMarkup(`<?xml version="1.0"?>
    <rss version="2.0"><channel><title>Tom &amp; Jerry</title>
    <item><guid isPermaLink="false">abc</guid><description><![CDATA[<p>Hello & <b>world</b></p>]]></description></item>
    </channel></rss>`)
  const rss = child(root, 'rss')
  assert.equal(attr(rss, 'version'), '2.0')
  const channel = child(rss, 'channel')
  assert.equal(textOfChild(channel, 'title'), 'Tom & Jerry')
  const item = child(channel, 'item')
  assert.equal(attr(child(item, 'guid'), 'isPermaLink'), 'false')
  assert.equal(textOfChild(item, 'description'), '<p>Hello & <b>world</b></p>')
})

test('tolerates malformed and unclosed markup without throwing', () => {
  const root = parseMarkup('<a><b>one<i>two</b>three</a><c>four')
  assert.equal(textOf(root).includes('one'), true)
  assert.equal(textOf(root).includes('four'), true)
  assert.equal(textOf(root).includes('three'), true)
})

test('HTML mode treats void and raw-text elements correctly', () => {
  const root = parseMarkup('<div><br><img src="a.png"><script>if (a < b) alert(1)</script><p>ok</p></div>', { html: true })
  const div = child(root, 'div')
  const script = child(div, 'script')
  assert.equal(textOf(script), 'if (a < b) alert(1)')
  assert.equal(textOfChild(div, 'p'), 'ok')
})

test('qualified names keep a local part', () => {
  assert.equal(localName('content:encoded'), 'encoded')
  assert.equal(localName('media:content'), 'content')
  assert.equal(localName('TITLE'), 'title')
})

test('a stray less-than stays text in HTML mode', () => {
  const root = parseMarkup('<p>5 < 7 and 9 > 3</p>', { html: true })
  assert.equal(textOfChild(root, 'p'), '5 < 7 and 9 > 3')
})
