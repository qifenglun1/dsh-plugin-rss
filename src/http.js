/** Conditional HTTP fetching with byte caps, cancellation, and clear failures. */

const USER_AGENT = 'DSH-RSS/1.0 (DeepSeek Harness RSS reader)'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

/** Build one failure carrying a stable code and HTTP-ish status. */
function failure(message, code, status) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

/** Read a response body while enforcing a byte cap. */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    throw failure(`The response is larger than the ${Math.round(maxBytes / 1024)} KiB limit.`, 'payload_too_large', 413)
  }
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw failure(`The response is larger than the ${Math.round(maxBytes / 1024)} KiB limit.`, 'payload_too_large', 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Whether a hostname resolves to a loopback, private, link-local, or metadata address. */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host === '::' || host === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true // fe80::/10 link local
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (mapped !== null) return isPrivateHost(mapped[1])
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (parts === null) {
    // Decimal, octal, and short-form IPv4 variants are all loopback/private shorthand.
    return /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/.test(host)
  }
  const [a, b] = [Number(parts[1]), Number(parts[2])]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return a >= 224
}

/** Reject schemes and, unless allowed, private or loopback hosts. */
function assertFetchable(url, allowPrivateHosts) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw failure('Only http and https URLs can be fetched.', 'invalid_scheme', 400)
  }
  if (!allowPrivateHosts && isPrivateHost(url.hostname)) {
    throw failure('This host is on a private or loopback network and cannot be fetched.', 'blocked_host', 400)
  }
}

/** Combine an optional caller signal with our own fetch controller. */
export function combineSignals(signals) {
  const active = signals.filter(signal => signal !== undefined && signal !== null)
  if (active.length === 1) return active[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active)
  const controller = new AbortController()
  for (const signal of active) {
    if (signal.aborted) { controller.abort(signal.reason); break }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * Fetch a feed or article page.
 * @param {string} url - absolute http(s) URL.
 * @param {object} options - timeout, byte cap, validators, accept header, caller signal, private-host opt-in.
 * @returns {Promise<{ status: number, notModified: boolean, body: Uint8Array, contentType: string, finalUrl: string, etag: string|undefined, lastModified: string|undefined }>}
 */
export async function fetchResource(url, options = {}) {
  const {
    timeoutMs = 25_000,
    maxBytes = 8 * 1024 * 1024,
    etag = undefined,
    lastModified = undefined,
    signal = undefined,
    allowPrivateHosts = false,
    accept = 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8, application/feed+json;q=0.8, text/html;q=0.7, */*;q=0.5',
    userAgent = USER_AGENT,
  } = options

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw failure('The URL is not valid.', 'invalid_url', 400)
  }
  assertFetchable(parsed, allowPrivateHosts)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const combinedSignal = combineSignals([controller.signal, signal])

  const headers = {
    'user-agent': userAgent,
    accept,
    'accept-language': 'en,zh-CN;q=0.9,*;q=0.5',
  }
  if (etag) headers['if-none-match'] = etag
  if (lastModified) headers['if-modified-since'] = lastModified

  let current = parsed
  let response
  let redirects = 0
  try {
    for (;;) {
      response = await fetch(current, {
        headers,
        redirect: 'manual',
        signal: combinedSignal,
        cache: 'no-store',
      })
      if (!REDIRECT_STATUSES.has(response.status)) break
      const location = response.headers.get('location')
      await response.body?.cancel?.().catch(() => {})
      if (location === null || location === '') throw failure('The server sent an empty redirect.', 'bad_redirect', 502)
      if (redirects >= MAX_REDIRECTS) throw failure('The request was redirected too many times.', 'too_many_redirects', 502)
      let next
      try {
        next = new URL(location, current)
      } catch {
        throw failure('The server sent an invalid redirect location.', 'bad_redirect', 502)
      }
      assertFetchable(next, allowPrivateHosts)
      current = next
      redirects += 1
    }

    if (response.status === 304) {
      return {
        status: 304,
        notModified: true,
        body: new Uint8Array(0),
        contentType: response.headers.get('content-type') ?? '',
        finalUrl: current.toString(),
        etag: response.headers.get('etag') ?? etag,
        lastModified: response.headers.get('last-modified') ?? lastModified,
      }
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      const hint = response.status === 401 || response.status === 403
        ? 'The server refused access.'
        : response.status === 404
          ? 'The address was not found.'
          : `The server answered HTTP ${response.status}.`
      throw failure(hint, 'upstream_error', 502)
    }
    const body = await readCapped(response, maxBytes)
    return {
      status: response.status,
      notModified: false,
      body,
      contentType: response.headers.get('content-type') ?? '',
      finalUrl: current.toString(),
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
    }
  } catch (error) {
    if (signal?.aborted) {
      const aborted = new Error('The request was cancelled.')
      aborted.name = 'AbortError'
      aborted.code = 'aborted'
      throw aborted
    }
    if (controller.signal.aborted) {
      const seconds = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} seconds`
      throw failure(`The request timed out after ${seconds}.`, 'timeout', 504)
    }
    if (typeof error?.status === 'number') throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/fetch failed|terminated|UND_ERR|other side closed|ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
      const cause = error?.cause?.code ?? error?.cause?.message
      const detail = cause === undefined ? 'The address could not be reached.' : `The address could not be reached (${cause}).`
      throw failure(detail, 'network_error', 502)
    }
    throw failure(message, 'network_error', 502)
  } finally {
    clearTimeout(timer)
  }
}
