import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeHtml, htmlToText, extractArticle, looksLikeHtml, previewText } from '../src/html.js'

test('sanitize keeps a safe subset and resolves links', () => {
  const dirty = `<div onclick="steal()"><script>alert(1)</script>
    <p>Hello <a href="/rel" title="x">link</a> <img src="pic.png" onerror="x()"></p>
    <iframe src="https://evil"></iframe><style>p{}</style></div>`
  const clean = sanitizeHtml(dirty, 'https://example.com/post/1')
  assert.equal(clean.includes('<script'), false)
  assert.equal(clean.includes('onclick'), false)
  assert.equal(clean.includes('onerror'), false)
  assert.equal(clean.includes('<iframe'), false)
  assert.equal(clean.includes('<style'), false)
  assert.match(clean, /href="https:\/\/example\.com\/rel"/)
  assert.match(clean, /src="https:\/\/example\.com\/post\/pic\.png"/)
  assert.match(clean, /rel="noopener noreferrer nofollow"/)
  assert.equal(clean.includes('Hello'), true)
})

test('sanitize rejects javascript URLs and keeps data images', () => {
  const clean = sanitizeHtml('<a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AAAA">', 'https://e.com/')
  assert.equal(clean.includes('javascript:'), false)
  assert.match(clean, /src="data:image\/png;base64,AAAA"/)
})

test('htmlToText preserves paragraphs, bullets, and line breaks', () => {
  const text = htmlToText('<h2>Title</h2><p>One<br>two</p><ul><li>a</li><li>b</li></ul>')
  assert.match(text, /Title/)
  assert.match(text, /One\ntwo/)
  assert.match(text, /• a/)
  assert.match(text, /• b/)
})

test('extracts the readable container and metadata from a page', () => {
  const page = `<!doctype html><html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="The real title">
    <meta property="og:image" content="/hero.jpg">
    <meta name="author" content="Ada Lovelace">
    <meta property="article:published_time" content="2024-02-02T10:00:00Z">
    </head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <div class="sidebar"><p>Subscribe now! Share this article!</p></div>
    <article class="post-content">
      <p>This is the opening paragraph of the article, and it has enough words to look like real prose rather than navigation.</p>
      <p>Here is a second paragraph with a quotation: "Reading is good." It continues for a while to raise the score.</p>
      <p>A third paragraph mentions numbers 123 and dates, so punctuation and length both contribute positively.</p>
    </article>
    <footer>Copyright</footer>
    </body></html>`
  const article = extractArticle(page, 'https://example.com/post')
  assert.equal(article.title, 'The real title')
  assert.equal(article.byline, 'Ada Lovelace')
  assert.equal(article.image, 'https://example.com/hero.jpg')
  assert.match(article.contentText, /opening paragraph/)
  assert.match(article.contentText, /second paragraph/)
  assert.equal(article.contentText.includes('Subscribe now'), false)
  assert.equal(article.contentText.includes('Copyright'), false)
})

test('preview text strips markup', () => {
  assert.equal(previewText('<p>Hello <b>world</b></p>'), 'Hello world')
  assert.equal(looksLikeHtml('<p>x</p>'), true)
  assert.equal(looksLikeHtml('plain text'), false)
})
