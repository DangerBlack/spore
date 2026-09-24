/**
 * The page between the gate and a site, on the site's own origin.
 *
 * With content isolation on, the gate frames `<infohash>.<content>/relay.html`
 * rather than the site. This page:
 *
 *  1. registers this origin's copy of `sw.js`, told which gate it belongs to;
 *  2. passes that worker's questions — a file, the scripts policy — up to the
 *     gate, by handing over the worker's own port, so the answer travels
 *     straight back without passing through here;
 *  3. frames the site from this origin, which is what puts the browser's
 *     origin boundary between the site and Spore;
 *  4. tells the gate whether the site actually arrived, since the gate cannot
 *     look inside a frame from another origin.
 *
 * It is a separate document from the site so the site's HTML never has to be
 * rewritten to carry any of this. It is *not* a security boundary: a site with
 * scripts on shares this origin and can reach this page. What it could do here
 * it could only do to itself, because the gate answers this origin about this
 * one torrent and nothing else. See spec/second-origin-isolation.md.
 */

import { TORRENT_PATH } from './config.js'
import { RELAY, contentOrigin, isolation, isolationProblem } from './isolation.js'

/** Same budget the gate's own viewer gives a page before calling it stuck. */
const LOAD_TIMEOUT_MS = 15_000
const ACTIVATE_TIMEOUT_MS = 10_000
/** A worker streaming a long file must not be stopped for looking idle. */
const KEEPALIVE_MS = 20_000

start().catch(err => say(`This site could not be shown: ${err.message}`))

async function start () {
  if (isolationProblem) throw isolationProblem
  if (!isolation) throw new Error('this gate does not use content isolation')
  if (window.parent === window) throw new Error('this page only works inside Spore')

  const infoHash = location.hostname.split('.')[0]
  // The same check the gate makes when it builds this address. A page that is
  // not at the origin its own hash implies is not one Spore framed.
  if (contentOrigin(infoHash) !== location.origin) throw new Error('this is not a site address')

  const params = new URLSearchParams(location.search)
  const path = sitePath(params.get('path'))

  navigator.serviceWorker.addEventListener('message', forward)
  navigator.serviceWorker.startMessages()

  const registration = await navigator.serviceWorker.register(
    `./sw.js?gate=${encodeURIComponent(isolation.gate)}`,
    { scope: './', updateViaCache: 'none' })
  await activated(registration)
  setInterval(() => fetch(`./${TORRENT_PATH}/keepalive/`).catch(() => {}), KEEPALIVE_MS)

  show(`./${TORRENT_PATH}/${infoHash}/${path}`, {
    scripts: params.get('scripts') === '1',
    sandbox: params.get('sandbox') !== '0'
  })
}

/**
 * The file to show, as a URL path.
 *
 * Handed over by the gate, which took it from the torrent's own file list —
 * strangers' data, so checked here too. A `..` segment would climb out of the
 * torrent's directory and frame this page inside itself, or anything else this
 * origin serves.
 */
function sitePath (path) {
  if (!path) throw new Error('no page was named')
  const segments = path.split('/')
  if (segments.some(s => s === '' || s === '.' || s === '..')) throw new Error('that is not a page in this site')
  return segments.map(encodeURIComponent).join('/')
}

/**
 * Up to the gate, with the worker's port.
 *
 * Addressed to the gate's origin, so if anything but the gate has framed this
 * page the browser drops the message and nothing is answered.
 */
function forward (event) {
  const data = event.data
  if (data?.type === 'webtorrent' && data.url) {
    parent.postMessage({
      spore: RELAY.request,
      request: { url: data.url, method: data.method, headers: data.headers, destination: data.destination }
    }, isolation.gate, [...event.ports])
  } else if (data?.type === 'spore/policy-query') {
    parent.postMessage({ spore: RELAY.policy }, isolation.gate, [...event.ports])
  }
}

function activated (registration) {
  const worker = registration.active ?? registration.waiting ?? registration.installing
  if (worker?.state === 'activated') return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('its worker did not start')), ACTIVATE_TIMEOUT_MS)
    const watch = w => w?.addEventListener('statechange', () => {
      if (w.state === 'activated') { clearTimeout(timer); resolve() }
    })
    watch(registration.installing)
    watch(registration.waiting)
    registration.addEventListener('updatefound', () => watch(registration.installing))
  })
}

function show (src, { scripts, sandbox }) {
  const frame = document.createElement('iframe')
  frame.title = 'Site'
  // The same flags the gate gives a site on its own origin. This page is framed
  // with a sandbox too (when the engine allows one), and flags only narrow
  // downwards, so the site can have no more than both allow.
  if (sandbox) frame.setAttribute('sandbox', scripts ? 'allow-same-origin allow-scripts' : 'allow-same-origin')

  let reported = false
  const report = () => {
    if (reported) return
    reported = true
    clearTimeout(timer)
    parent.postMessage({ spore: RELAY.shown, relay: location.href, arrived: arrived(frame, src) }, isolation.gate)
  }
  const timer = setTimeout(report, LOAD_TIMEOUT_MS)
  frame.addEventListener('load', () => {
    // Attaching a frame can fire `load` for its initial about:blank before the
    // real navigation has happened; that one says nothing about the site.
    let here = ''
    try { here = frame.contentDocument?.URL ?? '' } catch {}
    if (here !== 'about:blank') report()
  })

  frame.src = src
  document.body.append(frame)
}

/** What the gate's viewer checks on its own origin, checked here instead. */
function arrived (frame, src) {
  try {
    const doc = frame.contentDocument
    if (!doc || doc.URL !== new URL(src, location.href).href) return false
    return (doc.body?.childElementCount ?? 0) > 0 || (doc.body?.textContent ?? '').trim().length > 0
  } catch {
    return false
  }
}

function say (text) {
  const p = document.createElement('p')
  p.textContent = text
  document.body.replaceChildren(p)
}
