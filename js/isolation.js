/**
 * Each site on an origin of its own, when the mirror can provide one.
 *
 * Off by default (`CONTENT_ISOLATION` in config.js), and then nothing in this
 * module does anything: sites are served from the gate's own origin exactly as
 * they always were. On, a site with infohash H is shown at
 *
 *     <scheme>//H.<content>/relay.html
 *
 * which frames the site itself from the same origin. The browser then keeps
 * H's scripts away from Spore's storage and from every other site's, which is
 * the boundary the shared origin cannot give. See
 * spec/second-origin-isolation.md for why it is built this way.
 *
 * Imported by the gate and by relay.js on the content origin, so it must not
 * import anything that loads WebTorrent.
 */

import { CONTENT_ISOLATION, TORRENT_PATH } from './config.js'
import { scriptsAllowed } from './policy.js'

const INFOHASH = /^[0-9a-f]{40}$/

/** A host, optionally with a port: `spore-content.example[:8443]`. */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/

/** Messages from a relay all carry a `spore` field with one of these. */
export const RELAY = {
  request: 'relay/request',
  policy: 'relay/policy',
  shown: 'relay/shown'
}

let problem = null

/**
 * The configuration, checked, or null when isolation is off.
 *
 * A mistake here is not survivable quietly: a gate that frames sites at an
 * address its operator got wrong shows nothing at all, and says nothing about
 * why. So it is reported rather than ignored — `isolationProblem` — and the gate
 * shows it instead of starting.
 *
 * @type {null | { gate: string, scheme: string, content: string }}
 */
export const isolation = (() => {
  if (CONTENT_ISOLATION == null) return null
  try {
    const { gate, content } = CONTENT_ISOLATION
    const origin = new URL(gate).origin
    if (origin !== gate) throw new Error(`gate must be an origin like https://spore.example, not ${gate}`)
    if (typeof content !== 'string' || !HOST.test(content)) {
      throw new Error(`content must be a domain like spore-content.example, not ${content}`)
    }
    // A content domain under the gate's own would put every site on the gate's
    // *site*: able to set cookies the gate receives, and in Chromium possibly
    // sharing its process. The origin boundary holds either way; the site
    // boundary does not. Only the obvious case can be caught without the
    // Public Suffix List, so the rest is on the documentation.
    const scheme = new URL(gate).protocol
    // Spelled the way a browser spells an origin: lower case, and without a
    // port that is the scheme's default. `spore-content.example:443` would
    // otherwise never equal the origin the browser reports, and every site
    // would be refused as not ours.
    const normalized = new URL(`${scheme}//${content}`).host
    const gateHost = new URL(gate).hostname
    const contentHost = new URL(`${scheme}//${content}`).hostname
    if (contentHost === gateHost || contentHost.endsWith(`.${gateHost}`) ||
        gateHost.endsWith(`.${contentHost}`)) {
      throw new Error(
        `content (${content}) must be on a different domain from the gate (${gateHost}), ` +
        'e.g. spore-content.example rather than content.' + gateHost)
    }
    return { gate, scheme, content: normalized }
  } catch (err) {
    problem = new Error(`CONTENT_ISOLATION in js/config.js is not usable: ${err.message}`)
    return null
  }
})()

/** @type {Error|null} set when isolation was asked for and cannot work */
export const isolationProblem = problem

/**
 * The origin a torrent's site lives on.
 *
 * The infohash becomes part of a hostname, so it is checked here, where the
 * hostname is built, rather than trusted because of where it came from: a
 * value with a dot in it would name somebody else's subdomain.
 */
export function contentOrigin (infoHash) {
  if (!isolation) throw new Error('content isolation is off')
  if (!INFOHASH.test(infoHash)) throw new Error(`not an infohash: ${infoHash}`)
  return `${isolation.scheme}//${infoHash}.${isolation.content}`
}

/**
 * A path inside a torrent, as a URL path: each segment escaped, slashes kept.
 *
 * Here rather than in site.js because relay.js needs it too and must not load
 * what site.js imports; site.js's `entryURL` uses this same function, so the
 * gate's viewer and the relay cannot spell one file two ways.
 */
export function encodePath (path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Does this hostname have the shape of a site's own origin?
 *
 * The exact rule sw.js applies to decide it is serving a site rather than the
 * gate — the first label is a 40-character infohash — written in the same form
 * so the two cannot disagree. (sw.js is a classic worker and cannot import
 * this; the expression there must stay identical.) An earlier version here
 * required a dot after the hash, and so missed a single-label hostname that sw.js
 * would still have taken for a site.
 */
export function isSiteHostname (hostname) {
  return INFOHASH.test(hostname.split('.')[0])
}

/** The infohash whose origin this is, or null if it is not one of ours. */
export function infoHashOf (origin) {
  if (!isolation || typeof origin !== 'string') return null
  const infoHash = origin.slice(`${isolation.scheme}//`.length).split('.')[0]
  if (!INFOHASH.test(infoHash)) return null
  return contentOrigin(infoHash) === origin ? infoHash : null
}

/**
 * Where the viewer should point to show a file of a torrent.
 *
 * @param {string} infoHash
 * @param {string} path      the file, relative to the torrent
 * @param {{scripts: boolean, sandbox: boolean}} policy
 */
export function relayURL (infoHash, path, { scripts, sandbox }) {
  const url = new URL('/relay.html', contentOrigin(infoHash))
  url.searchParams.set('path', path)
  if (scripts) url.searchParams.set('scripts', '1')
  if (!sandbox) url.searchParams.set('sandbox', '0')
  return url.href
}

/**
 * Answer the relay framed in the viewer.
 *
 * Every message is checked twice before anything is done with it: it must come
 * from the viewer's own frame, and from the exact origin computed for an
 * infohash. The infohash used from then on is the one taken from the origin —
 * never one the message names — so a site can only ever be answered about
 * itself, whatever it sends.
 *
 * @param {object} options
 * @param {{wrapRequest: Function}} options.server  what client.createServer() returned
 * @param {string} options.scope   the gate worker's registration scope
 * @param {() => (Window|null)} options.frame  the viewer frame's window, now
 * @param {(infoHash: string, report: object) => void} options.onShown
 */
export function answerRelays ({ server, scope, frame, onShown }) {
  if (!isolation) return

  // Not rate-limited. A site with scripts on can send as many requests as it
  // likes, each for its own torrent: it costs the gate tab work, and reaches no
  // other site's data. A scripted page could burn its own tab anyway.
  window.addEventListener('message', event => {
    const kind = event.data?.spore
    if (kind !== RELAY.request && kind !== RELAY.policy && kind !== RELAY.shown) return

    const infoHash = infoHashOf(event.origin)
    if (!infoHash || !event.source || event.source !== frame()) return

    const [port] = event.ports

    if (kind === RELAY.policy) {
      port?.postMessage({ scripts: scriptsAllowed(infoHash) })
      return
    }
    if (kind === RELAY.shown) {
      onShown(infoHash, event.data)
      return
    }
    if (port) relayRequest(server, scope, infoHash, event.data.request, port)
  })
}

/**
 * Hand a request from a content origin to the same server that answers the
 * gate's own worker.
 *
 * `wrapRequest` reads only `data` and `ports[0]`, so the port the content
 * origin's worker created is answered directly, across the boundary: ranges,
 * types and streaming are WebTorrent's own code, not a second copy of it. What
 * is done here is only deciding whether to answer, and rebuilding the URL from
 * the infohash the origin proves rather than the one the request says.
 */
function relayRequest (server, scope, infoHash, request, port) {
  const refuse = (status, text) => port.postMessage({
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: text
  })

  let url
  try {
    url = new URL(request?.url)
  } catch {
    return refuse(400, 'Unreadable request.')
  }

  const prefix = `/${TORRENT_PATH}/${infoHash}/`
  if (url.origin !== contentOrigin(infoHash) || !url.pathname.startsWith(prefix)) {
    return refuse(403, 'A site can only ask for its own files.')
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refuse(405, 'Only GET and HEAD.')
  }
  // WebTorrent decodes the path inside an async handler, where a malformed
  // escape throws, is never answered, and turns into a 504 twenty seconds
  // later. Refused here instead, at once.
  try {
    decodeURIComponent(url.pathname)
  } catch {
    return refuse(400, 'Malformed path.')
  }

  const range = request.headers?.range
  server.wrapRequest({
    data: {
      type: 'webtorrent',
      url: new URL(`${TORRENT_PATH}/${infoHash}/${url.pathname.slice(prefix.length)}`, scope).href,
      method: request.method,
      headers: typeof range === 'string' ? { range } : {},
      destination: request.destination
    },
    ports: [port]
  })
}
