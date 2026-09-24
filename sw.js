/**
 * Spore service worker — the single chokepoint for everything a hosted site loads.
 *
 * WebTorrent's `client.createServer({ controller })` expects a worker that
 * proxies fetches to the page over a MessagePort. Rather than shipping
 * WebTorrent's stock `dist/sw.min.js`, we re-implement that protocol here
 * (derived from `lib/worker-server.js` + `lib/worker.js`, MIT) for two reasons:
 *
 *  1. SECURITY. The response headers are built here, so this file — not the
 *     torrent, not the page — decides the Content-Security-Policy every site
 *     runs under. Stock WebTorrent sends `frame-ancestors 'none'` (which would
 *     forbid our viewer iframe) and no egress restrictions at all.
 *  2. RENDERING. Stock WebTorrent turns any `destination: 'document'` request
 *     into a `Content-Disposition: attachment` download. We serve sites, so we
 *     ask for those files inline instead.
 *
 * Because every subresource of a site (CSS, images, fonts, XHR, nested frames)
 * is a fetch from this origin, this worker sees all of them. That is why the
 * gate does not rewrite HTML or invent custom tags: there is nothing to miss.
 */

/**
 * Bump whenever this file changes, together with EXPECTED_WORKER_VERSION in
 * js/config.js. A service worker can outlive the page that installed it, and a
 * stale one is invisible: everything looks healthy and nothing works. The
 * Diagnostics panel compares the two and says so.
 */
const VERSION = '2026-09-24.1'

const WEBTORRENT_PREFIX = 'webtorrent/'
const PORT_TIMEOUT_MS = 5000
/** How long to wait for a tab to answer with the file before giving up. */
const PAGE_TIMEOUT_MS = 20000
const POLICY_TIMEOUT_MS = 1000

/* -------------------------------------------------------------------------- */
/* Which origin this worker is serving                                        */
/* -------------------------------------------------------------------------- */

/**
 * The gate registers this file as `sw.js`. With content isolation on, each
 * site's own origin (`<infohash>.<content domain>`) registers it too, from
 * relay.html, as `sw.js?gate=<gate origin>` — see
 * spec/second-origin-isolation.md. Three things differ there:
 *
 *  - It serves one torrent: the infohash in its own hostname, and no other.
 *  - A site's ancestors are relay.html *and* the gate, so `frame-ancestors`
 *    has to name both.
 *  - Its questions — for a file, for the scripts policy — go to relay.html
 *    alone. The site is a window of this origin too, and one with scripts on
 *    could otherwise answer ahead of the relay (about nothing but itself, but
 *    there is no reason to let it).
 *
 * A site with scripts on can re-register this worker with a different `gate`.
 * That changes its own origin and nothing else, which is the boundary.
 */
const GATE = new URL(self.location.href).searchParams.get('gate')
const CONTENT_MODE = GATE !== null
const OWN_INFOHASH = CONTENT_MODE ? ownInfoHash() : null

function ownInfoHash () {
  const label = self.location.hostname.split('.')[0]
  let gateIsAnOrigin = false
  try { gateIsAnOrigin = new URL(GATE).origin === GATE } catch {}
  // Anything malformed serves nothing, rather than guessing what was meant.
  return gateIsAnOrigin && /^[0-9a-f]{40}$/.test(label) ? label : null
}

/**
 * The windows this worker may ask. On the gate, exactly the ones it always
 * asked; on a content origin, relay.html and nothing else.
 */
async function answeringWindows ({ includeUncontrolled }) {
  if (!CONTENT_MODE) return self.clients.matchAll({ type: 'window', includeUncontrolled })
  const relay = new URL('relay.html', self.registration.scope).pathname
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return windows.filter(client => new URL(client.url).pathname === relay)
}

/** Set once WebTorrent confirms the browser can cancel worker ReadableStreams. */
let streamCancelSupported = false

self.addEventListener('message', event => {
  if (event.data?.type === 'spore/version') {
    event.ports[0]?.postMessage({ version: VERSION })
  }

  // Asked by a page that found this worker parked in `waiting` behind an older
  // one. `skipWaiting()` on install is supposed to prevent that and usually
  // does, but it is not guaranteed, and the worker that is active in the
  // meantime may be an old build that understands none of these messages —
  // which is exactly the state that left Chromium unable to display anything.
  if (event.data?.type === 'spore/skip-waiting') {
    event.waitUntil(self.skipWaiting())
  }

  // A page can end up with an active worker that is not controlling it — a
  // hard reload produces exactly that, and it is invisible from the page's
  // side except that nothing works. Claiming on request fixes it without
  // making the reader reload.
  if (event.data?.type === 'spore/claim') {
    event.waitUntil(self.clients.claim().then(
      () => event.ports[0]?.postMessage({ claimed: true }),
      error => event.ports[0]?.postMessage({ claimed: false, error: String(error) })))
  }
})

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const response = route(event)
  if (response) event.respondWith(response)
})

function route (event) {
  const base = self.registration.scope + WEBTORRENT_PREFIX
  const { url } = event.request

  if (!url.startsWith(base)) return null // not ours: let the network handle it
  if (url.startsWith(base + 'keepalive/')) return new Response()
  if (url.startsWith(base + 'cancel/')) {
    // WebTorrent probes this to learn whether stream cancellation works here.
    return new Response(new ReadableStream({ cancel () { streamCancelSupported = true } }))
  }
  if (url.startsWith(base + 'probe/')) {
    // Answered so the page can find out whether a *sandboxed* frame reaches
    // this worker at all. WebKit does not let one: a frame with
    // `sandbox="allow-same-origin"` is never controlled, its request goes to
    // the network, and the reader gets the host's 404. Chrome and Firefox
    // serve it. The page cannot detect that by asking, only by trying.
    //
    // Served with the same policy a site gets, so the answer is about frames
    // rather than about anything special done for the probe.
    return new Response('<!doctype html><title>probe</title><body>served', {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Cache-Control': 'no-store'
      }
    })
  }
  return serve(event, url.slice(base.length))
}

/* -------------------------------------------------------------------------- */
/* Isolation between torrents                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which torrent, if any, is asking?
 *
 * This is how one site is kept out of another's files, and it is enforced here
 * rather than left to CSP. The original design pinned every CSP source to
 * `<origin>/webtorrent/<infoHash>/` and relied on path-prefix matching. Chrome
 * honours that; Firefox refused the site's own worker-served stylesheets and
 * images under it, so the page rendered unstyled. A boundary that one browser
 * enforces too loosely and another too tightly is the wrong place for the
 * boundary — the worker sees every request and behaves the same everywhere.
 *
 * `clientId` covers subresources: it names the document that asked. Navigations
 * arrive with no client, so the referrer stands in — which is why responses are
 * sent with `Referrer-Policy: same-origin` rather than `no-referrer`. Nothing
 * leaks by doing so: a site cannot reach anything off this origin anyway.
 */
async function askingTorrent (event) {
  const base = self.registration.scope + WEBTORRENT_PREFIX

  const client = event.clientId ? await self.clients.get(event.clientId) : null
  const source = client?.url || event.request.referrer
  if (!source || !source.startsWith(base)) return null // the gate itself

  return source.slice(base.length).split('/')[0]
}

/* -------------------------------------------------------------------------- */
/* Per-site policy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Scripts are opt-in per site and the toggle lives in the page, so the worker
 * has to ask — on every request, deliberately. Caching the answer here would
 * mean inventing an invalidation protocol and getting it wrong in exactly the
 * situation that matters: the reader flips the switch, the page reloads the
 * frame, and the worker serves it under the policy from a moment ago. The page
 * answers out of `localStorage`, so a round-trip costs a pair of postMessages.
 *
 * If nobody answers, we fail closed.
 */
async function policyFor (infoHash) {
  const denied = { scripts: false }
  const windows = await answeringWindows({ includeUncontrolled: false })
  if (windows.length === 0) return denied

  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(denied), POLICY_TIMEOUT_MS)
    for (const client of windows) {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = ({ data }) => {
        clearTimeout(timer)
        resolve({ scripts: !!data?.scripts })
      }
      // No `url` field: WebTorrent's own message handler ignores this message.
      client.postMessage({ type: 'spore/policy-query', infoHash }, [port2])
    }
  })
}

/**
 * The policy that a site runs under.
 *
 * The job here is egress: nothing outside this origin is ever a permitted
 * source, so a site cannot make the browser touch a third party. That matters
 * even with scripts off, because an `<img>`, a webfont or a form is enough to
 * report the reader's IP address to whoever is listening.
 *
 * Same-origin loads say `'self'` rather than a path pinned to the torrent.
 * Pinning was the original design and Chrome enforces it correctly, but
 * Firefox rejected a site's own worker-served stylesheets and images under it.
 * Cross-torrent access is refused by `askingTorrent` above instead — in code,
 * where every browser behaves the same. CSP keeps the job it does uniformly.
 */
function contentSecurityPolicy (origin, allowScripts) {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    // No form can post the reader anywhere, including back into the torrent.
    "form-action 'none'",
    // Only the gate may frame a site; a site may not be framed by the outside.
    // On a content origin the site sits inside relay.html, inside the gate,
    // and every ancestor is checked, so both are named.
    CONTENT_MODE ? `frame-ancestors 'self' ${GATE}` : `frame-ancestors ${origin}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    // Inline styles are unavoidable in real static sites and cannot exfiltrate
    // on their own: what a stylesheet may *load* is still same-origin only.
    "style-src 'self' 'unsafe-inline'",
    "frame-src 'self'",
    "child-src 'self'",
    allowScripts ? "script-src 'self' 'unsafe-inline'" : "script-src 'none'",
    // Even with scripts on, egress stays on this origin.
    allowScripts ? "connect-src 'self'" : "connect-src 'none'",
    allowScripts ? "worker-src 'self'" : "worker-src 'none'"
  ].join('; ')
}

/**
 * WebTorrent answers with `Access-Control-Allow-Origin: *`. We narrow it to the
 * gate itself and to opaque origins (`null`), which is what our sandboxed
 * viewer iframes send, so an unrelated website cannot quietly read torrents out
 * of this browser. Torrent payloads are public by nature, so this is hygiene
 * rather than a hard boundary.
 */
function corsHeader (requestOrigin, gateOrigin) {
  if (requestOrigin === 'null' || requestOrigin === gateOrigin) return requestOrigin
  return null
}

/* -------------------------------------------------------------------------- */
/* Serving                                                                    */
/* -------------------------------------------------------------------------- */

async function serve (event, torrentPath) {
  const request = event.request
  const infoHash = torrentPath.split('/')[0]
  const gateOrigin = new URL(self.registration.scope).origin

  if (CONTENT_MODE && (OWN_INFOHASH === null || infoHash !== OWN_INFOHASH)) {
    return new Response('This address serves one site only.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain', 'Content-Security-Policy': "default-src 'none'" }
    })
  }

  const asking = await askingTorrent(event)
  if (asking && asking !== infoHash) {
    return new Response('Cross-torrent request refused.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain', 'Content-Security-Policy': "default-src 'none'" }
    })
  }

  const [policy, upstream] = await Promise.all([
    policyFor(infoHash),
    requestFromPage(request)
  ])
  if (!upstream) {
    return new Response(
      'No Spore tab answered for this torrent within ' + (PAGE_TIMEOUT_MS / 1000) + ' seconds.\n\n' +
      'The tab that holds the swarm has to stay open, and it has to have this ' +
      'torrent loaded. If this tab is the one, reload it.',
      { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }

  const { data, port } = upstream
  const headers = new Headers(data.headers)
  headers.set('Content-Security-Policy', contentSecurityPolicy(gateOrigin, policy.scripts))
  headers.set('X-Content-Type-Options', 'nosniff')
  // same-origin, not no-referrer: the worker needs the referrer to tell which
  // torrent a navigation came from, and it never travels off this origin.
  headers.set('Referrer-Policy', 'same-origin')

  headers.delete('Access-Control-Allow-Origin')
  const allowedOrigin = corsHeader(request.headers.get('Origin'), gateOrigin)
  if (allowedOrigin) headers.set('Access-Control-Allow-Origin', allowedOrigin)

  const init = { status: data.status, headers }

  if (data.body !== 'STREAM') {
    closePort(port)
    return new Response(data.body, init)
  }
  return new Response(streamFromPort(port, request.destination), init)
}

/**
 * Hand the request to whichever tab answers first; that tab owns the WebTorrent
 * client and streams the bytes back over the returned port.
 */
async function requestFromPage (request) {
  const windows = await answeringWindows({ includeUncontrolled: true })
  if (windows.length === 0) return null

  return new Promise(resolve => {
    // Never wait indefinitely. `respondWith` on a promise that never settles
    // leaves the frame blank forever with nothing in the console — the reader
    // sees the viewer appear and stay empty, which is unreportable. A timeout
    // turns that into an error page that says what happened.
    const timer = setTimeout(() => resolve(null), PAGE_TIMEOUT_MS)
    const answer = value => { clearTimeout(timer); resolve(value) }

    for (const client of windows) {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = ({ data }) => answer({ data, port: port1 })
      client.postMessage({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        scope: self.registration.scope,
        // Lie about `document` so WebTorrent serves the file inline instead of
        // turning a page navigation into a file download.
        destination: request.destination === 'document' ? 'iframe' : request.destination,
        type: 'webtorrent'
      }, [port2])
    }
  })
}

function closePort (port) {
  port.postMessage(false) // tells the page to tear down its side
  port.onmessage = null
}

function streamFromPort (port, destination) {
  let idleTimer = null

  const cleanup = () => {
    clearTimeout(idleTimer)
    closePort(port)
  }

  return new ReadableStream({
    pull (controller) {
      return new Promise(resolve => {
        port.onmessage = ({ data }) => {
          if (data) controller.enqueue(data)
          else { cleanup(); controller.close() }
          resolve()
        }
        // Firefox cannot cancel a worker ReadableStream, so an abandoned
        // subresource stream would leak a port forever: drop it after a idle
        // spell. Never for a document, which the browser reads to completion.
        if (!streamCancelSupported && destination !== 'document') {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => { cleanup(); resolve() }, PORT_TIMEOUT_MS)
        }
        port.postMessage(true) // ask for the next chunk
      })
    },
    cancel: cleanup
  })
}
