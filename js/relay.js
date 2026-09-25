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
import { RELAY, contentOrigin, encodePath, isolation, isolationProblem } from './isolation.js'
import { pageArrived } from './viewer.js'

/** Same budget the gate's own viewer gives a page before calling it stuck. */
const LOAD_TIMEOUT_MS = 15_000
const ACTIVATE_TIMEOUT_MS = 10_000
/** A worker streaming a long file must not be stopped for looking idle. */
const KEEPALIVE_MS = 20_000

start().catch(err => {
  say(`This site could not be shown: ${err.message}`)
  // Said to the gate as well, at once and with the reason: otherwise it waits
  // out its whole timeout and then can only report a blank frame.
  if (isolation && window.parent !== window) {
    parent.postMessage({ spore: RELAY.shown, relay: location.href, arrived: false, reason: err.message },
      isolation.gate)
  }
})

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

  const script = new URL(`./sw.js?gate=${encodeURIComponent(isolation.gate)}`, location.href).href
  const registration = await navigator.serviceWorker.register(script, { scope: './', updateViaCache: 'none' })
  // register() hands back an existing registration untouched when its script
  // URL already matches, so a newer sw.js on the host would never be fetched.
  // Asked for explicitly; a failed check leaves the current worker, which is
  // then still required to be ours below.
  await registration.update().catch(() => {})
  await activated(registration, script)
  await removeOthers(registration)
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
  return encodePath(path)
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

/**
 * Wait until the active worker is *this* script, activated.
 *
 * Any activated worker is not enough. A site with scripts on can register
 * `sw.js?gate=<somewhere else>` at this same scope; the next visit's register()
 * starts installing the right one, but the planted one is still active and
 * would serve the site — with `frame-ancestors` naming the wrong gate, so the
 * reader sees a blank frame. The same holds for an older build of sw.js. So the
 * active worker's own script URL has to be the one registered here.
 *
 * Every worker state is watched, the active one included: a reload during
 * activation finds `active` present but still `activating`.
 */
function activated (registration, script) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('its worker did not start')), ACTIVATE_TIMEOUT_MS)
    const check = () => {
      const active = registration.active
      if (active?.state !== 'activated' || active.scriptURL !== script) return false
      clearTimeout(timer)
      resolve()
      return true
    }
    if (check()) return
    for (const worker of [registration.installing, registration.waiting, registration.active]) {
      worker?.addEventListener('statechange', check)
    }
    registration.addEventListener('updatefound',
      () => registration.installing?.addEventListener('statechange', check))
  })
}

/**
 * Only this page's own registration may stay.
 *
 * A site with scripts on shares this origin and can register Spore's `sw.js`
 * itself — with a narrower scope, say `/webtorrent/`, which then controls the
 * site's pages ahead of the relay's. It fails closed (it has no relay to ask,
 * so it answers nothing), but it outlives the reader turning scripts off and
 * leaves the site blank until removed. So it is removed, every time.
 */
async function removeOthers (registration) {
  for (const other of await navigator.serviceWorker.getRegistrations()) {
    if (other.scope !== registration.scope) await other.unregister()
  }
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
    return pageArrived(frame.contentDocument, new URL(src, location.href).href)
  } catch {
    return false
  }
}

function say (text) {
  const p = document.createElement('p')
  p.textContent = text
  document.body.replaceChildren(p)
}
