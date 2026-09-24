/**
 * The window a site is shown through.
 *
 * ## Why `allow-same-origin` is here
 *
 * The obvious design is a fully sandboxed iframe with an opaque origin. It does
 * not work, and the reason is worth recording so that nobody "fixes" it back:
 *
 *   Service worker is disabled because the context is sandboxed and lacks the
 *   'allow-same-origin' flag.
 *
 * A sandboxed document without `allow-same-origin` gets an opaque origin, and a
 * client with an opaque origin is never controlled by a service worker — the
 * navigation is not intercepted and neither is a single subresource. Since the
 * worker is how sites are served at all, sites have to share the gate's origin.
 * (`Content-Security-Policy: sandbox` on the response fails the same way one
 * step later: the document loads, then everything inside it 404s.)
 *
 * So isolation rests on two layers instead:
 *
 *  - This sandbox, which withholds everything not explicitly granted: no
 *    scripts, no top-level navigation (a site cannot replace the gate), no
 *    popups (a `target=_blank` to a third party would leak the reader's IP),
 *    no forms, no downloads, no plugins.
 *  - The Content-Security-Policy the worker attaches to every response, which
 *    pins every load to the site's own torrent and blocks network egress.
 *
 * With scripts off — the default — there is no code inside the site that could
 * make use of the shared origin, so the two layers hold.
 *
 * ## The honest limit
 *
 * A site the reader opts in to scripts *does* run on the gate's origin and can
 * therefore reach `window.parent` and tamper with the gate's own chrome. CSP
 * still confines what it can load, and it cannot install a service worker of
 * its own (a registration's script fetch bypasses our worker, and scope is
 * path-limited because we never send `Service-Worker-Allowed`), but the address
 * bar above it stops being trustworthy. Fixing that properly needs a second
 * origin for content, which is a Phase 2 change. Until then the opt-in asks.
 */

/** How long a site's entry page gets to load before we call it stuck. */
const LOAD_TIMEOUT_MS = 15_000

/** Nothing is granted that the site has not been given a reason to have. */
const BASE_SANDBOX = ['allow-same-origin']

/**
 * Whether a sandboxed frame is reachable by the service worker here.
 *
 * WebKit says no, and says it silently. A frame carrying `sandbox` is never
 * controlled, however the flags are set: its request skips the worker, goes to
 * the network, and the reader gets the host's 404 as a white page. Chrome and
 * Firefox serve it. Since every browser on iOS is WebKit, this is not an edge
 * case there, it is every reader.
 *
 * Measured with two frames in one document, the only difference being the
 * attribute:
 *
 *   WebKit    plain: served     sandboxed: 404
 *   Chrome    plain: served     sandboxed: served
 *
 * Detected by trying rather than by reading the user agent, because the
 * question is what this engine does, and engines change.
 */
let sandboxIsServed = null

export function sandboxWorks () {
  return sandboxIsServed
}

/**
 * Ask the worker for a page from inside a sandboxed frame, and see if it
 * arrives. Runs once, on a hidden frame, and settles before any site is shown.
 */
export async function probeSandbox (probeURL) {
  if (sandboxIsServed !== null) return sandboxIsServed

  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', BASE_SANDBOX.join(' '))
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'

  const settled = new Promise(resolve => {
    const done = value => { clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => done(false), 8000)

    frame.addEventListener('load', () => {
      // Attaching a frame to the document fires `load` for its initial
      // about:blank, before the real navigation has happened at all. Answering
      // that one reports an empty body and concludes the worker did not serve
      // it — which is how this probe first managed to be wrong on Chrome, where
      // sandboxed frames work perfectly well. Only the probe's own URL counts.
      let here = ''
      try { here = frame.contentDocument?.URL ?? '' } catch { here = '' }
      if (here === 'about:blank' || here === '') return

      try {
        // Same-origin is granted, so the document is readable. A worker-served
        // answer says "served"; anything else came from the network.
        done((frame.contentDocument?.body?.textContent ?? '').includes('served'))
      } catch {
        // Unreadable means the frame did not end up same-origin, which is the
        // failure this is looking for.
        done(false)
      }
    })
  })

  frame.src = probeURL
  document.body.append(frame)
  sandboxIsServed = await settled
  frame.remove()
  return sandboxIsServed
}

export class Viewer {
  /** @param {HTMLIFrameElement} frame */
  constructor (frame) {
    this.frame = frame
  }

  /**
   * A frame that never carried the attribute at all.
   *
   * Removing `sandbox` is not enough on WebKit: whether a frame can be
   * controlled appears to be settled when it is created, so an element that
   * started life sandboxed keeps going to the network however the attribute is
   * edited afterwards. Measured — the attribute was gone and the frame still
   * received the host's 404. Replacing the element is what actually changes
   * the answer.
   */
  withoutSandbox () {
    const fresh = document.createElement('iframe')
    fresh.id = this.frame.id
    fresh.className = this.frame.className
    fresh.title = this.frame.title
    fresh.hidden = this.frame.hidden
    this.frame.replaceWith(fresh)
    return fresh
  }

  /**
   * @param {string} url  worker-served URL of the site's entry page
   * @param {{ scripts: boolean }} policy
   * @returns {Promise<boolean>} whether the frame actually navigated
   */
  async show (url, policy) {
    const sandbox = [...BASE_SANDBOX]
    if (policy.scripts) sandbox.push('allow-scripts')

    // Drop the old document first, and wait for that to actually happen. The
    // sandbox flags are read when a load *starts*, so assigning `sandbox` and
    // `src` back-to-back against a frame that is still busy can leave the site
    // rendered under the previous policy — which is how "enable scripts" used
    // to silently do nothing until the reader navigated away and back.
    await this.clear()

    // On an engine that refuses to serve a sandboxed frame, the choice is
    // between showing the site without the attribute and not showing it at
    // all. The second layer, the Content-Security-Policy the worker attaches,
    // is untouched either way: no scripts, and no request that leaves the
    // torrent. What is given up is the sandbox's own protections, chiefly that
    // a click cannot navigate the gate away or open an outside tab. Scripts
    // are refused outright in this mode, because shared origin without even a
    // sandbox is not a trade worth offering.
    if (sandboxIsServed === false && this.frame.hasAttribute('sandbox')) {
      this.frame = this.withoutSandbox()
    }
    else this.frame.setAttribute('sandbox', sandbox.join(' '))

    // Watch the navigation rather than assume it. A viewer stuck on
    // `about:blank` is the worst failure this app has: the reader sees an empty
    // page, the console says nothing, and every other indicator reads healthy.
    const settled = new Promise(resolve => {
      let timer
      const finish = () => { clearTimeout(timer); resolve() }
      timer = setTimeout(finish, LOAD_TIMEOUT_MS)
      this.frame.addEventListener('load', finish, { once: true })
    })

    this.frame.src = url
    this.frame.hidden = false

    await settled
    return this.landedOn(url)
  }

  /**
   * Show a site through its own origin's relay (content isolation on).
   *
   * The frame here is relay.html on the site's origin, which frames the site.
   * It needs scripts to do that, so it is sandboxed with scripts and its own
   * origin; the site inside gets its own, narrower, flags from the relay, and
   * flags only ever narrow on the way down. Where the engine will not serve a
   * sandboxed frame at all, neither frame carries one — the same fallback, and
   * the same question to the reader, as the shared-origin viewer.
   *
   * Arrival cannot be checked by reading the frame, which is cross-origin now,
   * so this waits for the relay to say — see `relayReported`.
   *
   * @param {string} url  from isolation.js's `relayURL`
   * @returns {Promise<boolean>} whether the site actually arrived
   */
  async showRelay (url) {
    await this.clear()

    if (sandboxIsServed === false && this.frame.hasAttribute('sandbox')) {
      this.frame = this.withoutSandbox()
    } else if (sandboxIsServed !== false) {
      this.frame.setAttribute('sandbox', 'allow-same-origin allow-scripts')
    }

    const settled = new Promise(resolve => {
      const pending = {
        url,
        finish: arrived => {
          clearTimeout(timer)
          if (this.pending === pending) this.pending = null
          resolve(arrived)
        }
      }
      // The relay's own clock is LOAD_TIMEOUT_MS from when it frames the site;
      // starting its worker comes first, so allow for that too.
      const timer = setTimeout(() => pending.finish(false), LOAD_TIMEOUT_MS * 2)
      this.pending?.finish(false)
      this.pending = pending
    })

    this.frame.src = url
    this.frame.hidden = false
    return settled
  }

  /** The relay's word on whether its site arrived. Stale reports are ignored. */
  relayReported (relay, arrived) {
    if (this.pending?.url === relay) this.pending.finish(arrived === true)
  }

  /**
   * Did the frame really end up showing that page?
   *
   * The `load` event is not the answer on its own: a navigation the browser
   * refuses still fires it, having put an error page — or nothing — in the
   * frame. The document's own URL is the honest signal. Sites are served from
   * this origin (see above), so the frame is readable from here.
   */
  landedOn (url) {
    let document
    try {
      document = this.frame.contentDocument
    } catch {
      return true // cross-origin somehow: no view, so no accusation
    }
    if (!document) return false
    if (document.URL !== url) return false
    return (document.body?.childElementCount ?? 0) > 0 ||
      (document.body?.textContent ?? '').trim().length > 0
  }

  /** @returns {Promise<void>} resolves when the frame holds nothing */
  clear () {
    this.frame.hidden = true
    if (this.frame.src === 'about:blank' || !this.frame.src) return Promise.resolve()

    return new Promise(resolve => {
      // Never hang on this: a frame that will not unload should not wedge the
      // gate, and the navigation below replaces it either way.
      let timer
      const finish = () => { clearTimeout(timer); resolve() }
      timer = setTimeout(finish, 1000)
      this.frame.addEventListener('load', finish, { once: true })
      this.frame.src = 'about:blank'
    })
  }
}
