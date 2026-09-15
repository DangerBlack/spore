/**
 * The WebTorrent client and the service worker that fronts it.
 *
 * The client must live in the page: a service worker cannot open WebRTC
 * connections, so the worker only proxies HTTP-shaped requests back here.
 * Consequence, and it is a real one: seeding stops when the tab closes.
 */

// The vendored bundle is an ES module, so it is imported like our own code
// rather than dropped on `window` by a classic <script>.
import WebTorrent from '../vendor/webtorrent.min.js'
import {
  DEFAULT_TRACKERS, METADATA_DEADLINE_MS, METADATA_QUIET_MS, METADATA_SILENT_MS
} from './config.js'

/** How long to wait for the worker to claim this page before carrying on. */
const CONTROLLER_TIMEOUT_MS = 3000
/** And how long to wait after explicitly asking it to claim us. */
const CLAIM_TIMEOUT_MS = 3000

/** @type {import('webtorrent').Instance|null} */
let client = null

/**
 * Register the worker and wait until it actually controls this page. Until a
 * controller exists, fetches from the viewer iframe would go to the network and
 * 404 — so this has to complete before any site is loaded.
 *
 * @returns {Promise<ServiceWorkerRegistration>}
 */
export async function startWorker () {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser has no service workers, so Spore cannot render sites. (HTTPS is required, except on localhost.)')
  }

  let registration
  try {
    registration = await navigator.serviceWorker.register(
      new URL('./sw.js', document.baseURI),
      {
        // Relative, so the gate works identically at the root of a domain and
        // under a path — which is what a GitHub project page gives you.
        scope: './',
        // Never take sw.js from the HTTP cache. Static hosts serve assets with
        // a long max-age (GitHub Pages uses ten minutes), and a cached worker
        // outliving its fix is a bug that looks like the fix never happened.
        updateViaCache: 'none'
      }
    )
  } catch (err) {
    // Overwhelmingly this is a browser set to block site data, which disables
    // service workers outright. The message the browser gives is not useful.
    throw new Error(
      `Spore could not start its service worker, so it cannot display sites: ${err.message}. ` +
      'This usually means this browser is blocking cookies and site data for ' +
      'localhost, or the page is not on HTTPS.')
  }

  // A stale worker is a classic way to spend an afternoon on a bug that is
  // already fixed: a static host may hand back a cached sw.js for a long time.
  registration.update().catch(() => {})

  if (!navigator.serviceWorker.controller) {
    await controllerTakesOver(registration)
  }
  return registration
}

/**
 * Wait for the worker to take control — but not forever.
 *
 * A hard reload (Ctrl+F5, Ctrl+Shift+R) deliberately bypasses the service
 * worker, so the page it produces is *uncontrolled* and no `controllerchange`
 * is ever coming: `clients.claim()` already ran when the worker activated.
 * Waiting on that event unconditionally meant the gate never finished starting
 * for anyone in the habit of hard-reloading — the one habit a person debugging
 * a stubborn page is most likely to have.
 *
 * An uncontrolled page is not fatal. The worker still handles the viewer's
 * iframe, because a nested navigation is matched to a registration by URL, and
 * it can still reach this page for torrent data through `includeUncontrolled`.
 */
async function controllerTakesOver (registration) {
  if (await controllerChange(CONTROLLER_TIMEOUT_MS)) return

  // A new worker stuck in `waiting` behind an older active one. This is the
  // state that had Chromium showing nothing at all: `waiting=installed,
  // active=activated`. Pushing the waiting worker through is what fixes it —
  // and it has to be asked *before* the active one, because that active worker
  // may be an old build with no idea what any of these messages mean.
  if (registration.waiting) {
    console.warn('Spore: a newer worker is waiting behind an older one; asking it to take over.')
    registration.waiting.postMessage({ type: 'spore/skip-waiting' })
    if (await controllerChange(CLAIM_TIMEOUT_MS)) return
  }

  // Active but not controlling. `clients.claim()` normally only runs on
  // activate, which has long since happened for anyone whose registration
  // predates this page load, so ask for it explicitly.
  if (registration.active) {
    console.warn('Spore: page not controlled by the worker; asking it to claim this page.')
    registration.active.postMessage({ type: 'spore/claim' })
    if (await controllerChange(CLAIM_TIMEOUT_MS)) return
  }

  await startOver(registration)
}

/**
 * Last resort: throw the registration away and reload once.
 *
 * Reached only when a worker is present and, after being asked twice, still is
 * not controlling this page — a profile whose registration is wedged in a way
 * nothing polite recovers from. Unregistering and reloading always fixes it,
 * and it is what a reader would otherwise have to find the Reset button to do.
 *
 * Guarded by a session flag so a browser that can never be controlled reloads
 * once and then gets on with reporting the problem, rather than looping.
 */
async function startOver (registration) {
  const FLAG = 'spore.restarted-worker'
  if (sessionStorage.getItem(FLAG)) {
    console.warn(
      'Spore: the worker still is not controlling this page after a restart. ' +
      'Open Diagnostics for the details, and use Reset if sites will not load.')
    return
  }

  console.warn('Spore: worker will not take control; unregistering it and reloading once.')
  try {
    sessionStorage.setItem(FLAG, '1')
    await registration.unregister()
    location.reload()
    // Give the reload a moment to happen, but never wait on it forever: a
    // reload that does not arrive must not leave the gate stuck on "Starting…",
    // which is the class of bug this whole path exists to fix.
    await new Promise(resolve => setTimeout(resolve, 2000))
  } catch (err) {
    console.warn('Spore: could not restart the worker:', err)
  }
}

/** Resolve true if the worker takes control within `timeout`. */
function controllerChange (timeout) {
  return Promise.race([
    new Promise(resolve => {
      navigator.serviceWorker.addEventListener(
        'controllerchange', () => resolve(true), { once: true })
    }),
    new Promise(resolve => setTimeout(() => resolve(false), timeout))
  ])
}

/** Create the singleton client and point the worker at it. */
export function startClient (registration) {
  if (client) return client
  client = new WebTorrent()
  // The worker derives its own path prefix from the registration scope, which
  // is why the gate works unchanged whether it is hosted at / or at /spore/.
  client.createServer({ controller: registration })
  return client
}

export function getClient () {
  if (!client) throw new Error('The swarm client has not been started.')
  return client
}

/**
 * Join a swarm and wait for the file list.
 *
 * Idempotent: re-opening a site that is already in the client (a published one,
 * say) returns the existing torrent instead of joining twice.
 */
export async function openTorrent (magnetURI, onJoin = () => {}) {
  const wt = getClient()

  const existing = await wt.get(magnetURI)
  const torrent = existing ?? wt.add(magnetURI)

  // Handed over before the wait, so the caller can show what is happening
  // instead of a spinner that means nothing.
  onJoin(torrent)
  return await withMetadata(torrent)
}

/**
 * Seed files as a new torrent and wait until it is announceable.
 *
 * `announceList` is passed explicitly. Without it WebTorrent uses its own
 * built-in defaults, which still include a tracker that refuses connections —
 * so removing it from DEFAULT_TRACKERS only cleaned up the magnet text while
 * every publish went on announcing to a dead host.
 */
export function seedTorrent (files, opts) {
  return new Promise((resolve, reject) => {
    let torrent
    try {
      torrent = getClient().seed(
        files, { announceList: DEFAULT_TRACKERS.map(t => [t]), ...opts }, resolve)
    } catch (err) {
      return reject(err)
    }

    // A seed that fails asynchronously — a duplicate infohash, a store that
    // will not write — used to leave this promise pending for the life of the
    // tab. That stranded one publish; since publishing became one-at-a-time it
    // would strand every publish after it too, with the gate insisting one was
    // still on its way. A failure has to be an answer.
    torrent?.once?.('error', reject)
  })
}

/**
 * Nobody answered for this infohash. Typed, because it is the ordinary way for
 * a site to be missing — the equivalent of a 404 — and the gate shows it very
 * differently from something having gone wrong.
 */
export class SiteNotFound extends Error {
  constructor (infoHash) {
    super('No peer answered for this site.')
    this.name = 'SiteNotFound'
    this.infoHash = infoHash
  }
}

/**
 * Wait for metadata, giving the swarm more than one chance to provide it.
 *
 * Two things make a single timeout the wrong shape here. Peers arrive in draws
 * rather than continuously — a tracker introduces you to whoever announced near
 * the same moment — so the useful question is not "how long has this taken" but
 * "has anything new happened lately". And a peer connecting is not evidence it
 * can help: another reader waiting for the same metadata is a peer with nothing
 * to give, and two of them can sit connected indefinitely.
 *
 * So the quiet timer restarts whenever a peer arrives, and each time it expires
 * the trackers are asked for a fresh draw before anything is abandoned. The
 * deadline stops that going on forever.
 */
function withMetadata (torrent) {
  if (torrent.ready) return Promise.resolve(torrent)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const deadline = startedAt + METADATA_DEADLINE_MS
    let quiet = null
    let sawAnyPeer = torrent.numPeers > 0

    const onMetadata = () => { cleanup(); resolve(torrent) }
    const onError = err => { cleanup(); reject(err) }
    const giveUp = () => { cleanup(); reject(new SiteNotFound(torrent.infoHash)) }

    const onQuiet = () => {
      // A swarm that has produced no peer at all is almost certainly a site
      // nobody is seeding, and its 404 should arrive as promptly as it always
      // did — waiting the full deadline to say so helps no one, and this is by
      // far the more common reason a site does not load.
      if (!sawAnyPeer && Date.now() - startedAt >= METADATA_SILENT_MS) return giveUp()
      if (Date.now() >= deadline) return giveUp()

      // Otherwise there is a swarm; we are just talking to the wrong part of
      // it. Ask the trackers to introduce us to somebody else. This is the step
      // that was missing: without it the first draw was also the last.
      try {
        torrent.discovery?.tracker?.update()
      } catch {
        // A tracker client that will not re-announce is not fatal; the wait
        // simply continues on the peers already known.
      }
      arm()
    }

    const arm = () => {
      clearTimeout(quiet)
      const remaining = deadline - Date.now()
      if (remaining <= 0) return giveUp()
      quiet = setTimeout(onQuiet, Math.min(METADATA_QUIET_MS, remaining))
    }

    // A new peer is a fresh chance, so it buys the swarm more time — but only
    // within the deadline, or one peer joining every few seconds could hold a
    // reader forever on a site that never loads.
    const onWire = () => { sawAnyPeer = true; arm() }

    const cleanup = () => {
      clearTimeout(quiet)
      torrent.removeListener('metadata', onMetadata)
      torrent.removeListener('error', onError)
      torrent.removeListener('wire', onWire)
    }

    torrent.on('wire', onWire)
    torrent.once('metadata', onMetadata)
    torrent.once('error', onError)
    arm()
  })
}
