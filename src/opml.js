/** OPML 2.0 subscription import and export. */
import { escapeHtml, hashId } from './util.js'
import { attr, childElements, descendants, parseMarkup } from './xml.js'

/** Write subscriptions as a category-grouped OPML document. */
export function exportOpml(feeds, categories) {
  const categoryName = new Map(categories.map(category => [category.id, category.name]))
  const groups = new Map()
  for (const feed of feeds) {
    const name = categoryName.get(feed.categoryId) ?? 'Uncategorized'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(feed)
  }
  const outlines = [...groups.entries()].map(([name, list]) => {
    const children = list.map(feed => {
      const attrs = [
        `text="${escapeHtml(feed.title)}"`,
        `title="${escapeHtml(feed.title)}"`,
        `type="rss"`,
        `xmlUrl="${escapeHtml(feed.url)}"`,
        feed.siteUrl ? `htmlUrl="${escapeHtml(feed.siteUrl)}"` : '',
        feed.tags.length > 0 ? `category="${escapeHtml(feed.tags.join(','))}"` : '',
      ].filter(part => part !== '').join(' ')
      return `      <outline ${attrs} />`
    }).join('\n')
    return `    <outline text="${escapeHtml(name)}" title="${escapeHtml(name)}">\n${children}\n    </outline>`
  }).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>DSH RSS subscriptions (${new Date().toISOString().slice(0, 10)})</title>`,
    '  </head>',
    '  <body>',
    outlines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n')
}

/** Parse an OPML document into feed candidates. */
export function importOpml(source) {
  const root = parseMarkup(String(source ?? ''), { html: false })
  const body = descendants(root, 'body', 1)[0] ?? root
  const feeds = []
  const errors = []
  const seen = new Set()
  const walk = (node, category) => {
    for (const outline of childElements(node, 'outline')) {
      const xmlUrl = attr(outline, 'xmlUrl') ?? attr(outline, 'feedUrl')
      const title = attr(outline, 'title') ?? attr(outline, 'text') ?? ''
      const htmlUrl = attr(outline, 'htmlUrl') ?? attr(outline, 'htmlurl') ?? ''
      const tagText = attr(outline, 'category') ?? ''
      if (xmlUrl !== undefined && xmlUrl.trim() !== '') {
        const url = xmlUrl.trim()
        if (seen.has(url)) continue
        seen.add(url)
        feeds.push({
          url,
          title: title.trim(),
          siteUrl: htmlUrl.trim(),
          category: category.trim(),
          tags: tagText.split(',').map(tag => tag.trim()).filter(tag => tag !== ''),
        })
      } else {
        const nextCategory = (attr(outline, 'text') ?? attr(outline, 'title') ?? category).trim()
        walk(outline, nextCategory || category)
      }
    }
  }
  walk(body, '')
  if (feeds.length === 0) errors.push('No outline with an xmlUrl was found.')
  return { feeds, errors }
}

/** Build a category id when importing into a store. */
export function importedCategoryId(name) {
  return name ? hashId(name.toLowerCase(), 'cat') : null
}
