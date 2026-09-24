/**
 * What state is this browser actually in?
 *
 * Spore depends on a service worker and, optionally, on IndexedDB. Both can be
 * switched off by a browser setting, and a service worker can outlive the code
 * that installed it. When that happens the gate simply does not work, and the
 * reader has no way to tell which of those it is — so this reports it, and
 * offers the one repair that fixes a profile left in a bad state.
 */

import { DEFAULT_TRACKERS, EXPECTED_WORKER_VERSION } from './config.js'

/** Ask the running worker which build it is. Silence means it cannot answer. */
function workerVersion (worker) {
  return new Promise(resolve => {
    const { port1, port2 } = new MessageChannel()
    const timer = setTimeout(() => resolve(null), 1500)
    port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(data?.version ?? null) }
    worker.postMessage({ type: 'spore/version' }, [port2])
  })
}

export async function collectDiagnostics () {
  const rows = []
  const add = (label, value, ok) => rows.push({ label, value, ok })

  add('Page origin', location.origin, null)
  add('Secure context', window.isSecureContext
    ? 'yes'
    : 'NO — this is why Spore cannot display sites', window.isSecureContext)

  if (!('serviceWorker' in navigator)) {
    // Browsers hide the whole API on an insecure origin, so "not supported"
    // would blame the browser for what is really the address bar's fault.
    add('Service worker', window.isSecureContext
      ? 'not supported by this browser'
      : `unavailable because ${location.origin} is not a secure origin — ` +
        'serve Spore over HTTPS, or reach it on localhost', false)
  } else {
    const controller = navigator.serviceWorker.controller
    add('Worker controlling', controller ? 'yes' : 'NO — sites cannot be displayed', !!controller)
    if (controller) add('Worker script', controller.scriptURL.replace(location.origin, ''), null)

    try {
      const registrations = await navigator.serviceWorker.getRegistrations()
      if (registrations.length === 0) {
        add('Registrations', 'none', false)
      }
      for (const registration of registrations) {
        // Which of the three slots the worker sits in is the difference between
        // "installed and idle", "queued behind an old one" and "failed to
        // start" — three very different problems that all look identical from
        // the page when it is left uncontrolled.
        const state = ['installing', 'waiting', 'active']
          .filter(slot => registration[slot])
          .map(slot => `${slot}=${registration[slot].state}`)
          .join(', ') || 'no worker in any slot'
        add(`Registration ${registration.scope.replace(location.origin, '') || '/'}`,
          state, !!registration.active)
      }
    } catch (err) {
      add('Registrations', `unreadable: ${err.message}`, false)
    }

    if (controller) {
      const running = await workerVersion(controller)
      const current = running === EXPECTED_WORKER_VERSION
      add('Worker version', running === null
        ? 'no answer — this worker predates version reporting, so it is stale'
        : `${running}${current ? '' : ` — STALE, this page expects ${EXPECTED_WORKER_VERSION}`}`,
      current)
      if (!current) add('Fix', 'press Reset below, then reload', false)
    }
  }

  try {
    const { sandboxWorks } = await import('./viewer.js')
    const works = sandboxWorks()
    add('Sandboxed frames', works === null
      ? 'not determined yet'
      : works
        ? 'served by the worker'
        : 'NOT served — sites are shown without the sandbox attribute', works)

    if (works === false) {
      let decision = null
      try { decision = localStorage.getItem('spore.reduced-isolation') } catch { /* unreadable */ }
      add('Reduced isolation', decision === 'yes'
        ? 'accepted: a link you click can open an outside tab'
        : decision === 'no' ? 'declined: sites are not shown' : 'not decided yet',
      decision === 'yes' ? null : false)
    }
  } catch {
    // The viewer module not loading is somebody else's problem, reported
    // elsewhere; not knowing this is better than failing the whole panel.
  }

  await reportGateVersion(add)

  const { isolation, isolationProblem } = await import('./isolation.js')
  add('Content isolation', isolationProblem
    ? isolationProblem.message
    : isolation
      ? `on — each site at <infohash>.${isolation.content}`
      : 'off — sites share this gate\'s origin', isolationProblem ? false : null)

  // What the viewer is pointed at, and what the worker actually returns for it.
  // "Nothing displays" is usually one of these two lines disagreeing with the
  // other: a frame with no source, or a source the worker will not serve.
  const frame = document.getElementById('viewer')
  if (frame && !frame.hidden && frame.src && frame.src !== 'about:blank' && isolation) {
    // On the site's own origin, which this page may not fetch from — that is
    // the point. Its relay reports whether the site arrived instead.
    add('Viewer', frame.src, null)
    const { relayReport } = await import('./viewer.js')
    const report = relayReport()
    add('Viewer response', report === null
      ? 'on the site\'s own origin; its relay has not reported yet'
      : report.arrived
        ? 'on the site\'s own origin; its relay reports the page arrived'
        : `on the site's own origin; its relay reports it did not arrive: ${report.reason ?? 'no reason given'}`,
    report === null ? null : report.arrived)
  } else if (frame && !frame.hidden && frame.src && frame.src !== 'about:blank') {
    add('Viewer', frame.src.replace(location.origin, ''), null)
    try {
      const res = await fetch(frame.src)
      const body = await res.text()
      add('Viewer response', `${res.status} ${res.headers.get('content-type') ?? '?'}, ${body.length} bytes`,
        res.ok && body.length > 0)
    } catch (err) {
      add('Viewer response', `could not be fetched: ${err.message}`, false)
    }
  } else {
    add('Viewer', 'nothing open', null)
  }

  try {
    const { openDatabase } = await import('./idb.js')
    await openDatabase()
    add('Offline storage', 'available', true)
  } catch (err) {
    add('Offline storage', `unavailable — ${err.message}`, false)
  }

  try {
    localStorage.setItem('spore.probe', '1')
    localStorage.removeItem('spore.probe')
    add('Site data', 'writable', true)
  } catch {
    add('Site data', 'blocked — this browser is refusing to store anything', false)
  }

  add('WebRTC', typeof RTCPeerConnection === 'function'
    ? 'available' : 'missing — no peers can be reached',
  typeof RTCPeerConnection === 'function')

  // Browsers reach peers only through `wss://` trackers, and those hostnames
  // are exactly the sort of thing a content blocker or a network filter drops.
  // When that happens a site never finds a peer and simply never appears, with
  // every other line on this panel reading healthy.
  const reachable = await Promise.all(DEFAULT_TRACKERS.map(probeTracker))
  const working = reachable.filter(r => r.ok)
  add('Trackers', working.length
    ? `${working.length} of ${reachable.length} reachable`
    : 'NONE reachable — no peers can be found, so no site will ever load',
  working.length > 0)
  for (const result of reachable.filter(r => !r.ok)) {
    add('  unreachable', `${result.url} — ${result.why}`, false)
  }

  return rows
}

/** Open and immediately close a tracker socket, just to see whether we may. */
function probeTracker (url) {
  return new Promise(resolve => {
    let socket
    const done = (ok, why) => {
      clearTimeout(timer)
      try { socket?.close() } catch { /* already gone */ }
      resolve({ url: url.replace('wss://', ''), ok, why })
    }
    const timer = setTimeout(() => done(false, 'no response in 5s'), 5000)

    try {
      socket = new WebSocket(url)
    } catch (err) {
      return done(false, err.message)
    }
    socket.onopen = () => done(true, '')
    socket.onerror = () => done(false, 'blocked or unreachable')
  })
}

/**
 * Unregister the worker and delete everything Spore has stored here.
 *
 * This is the escape hatch for a profile carrying a stale worker or a wedged
 * database. It is destructive within Spore's own origin and touches nothing
 * else, which is why it asks first and says exactly what it removes.
 */
export async function resetBrowserState () {
  const problems = []

  try {
    const registrations = await navigator.serviceWorker?.getRegistrations() ?? []
    await Promise.all(registrations.map(r => r.unregister()))
  } catch (err) {
    problems.push(`service worker: ${err.message}`)
  }

  try {
    const names = await caches?.keys() ?? []
    await Promise.all(names.map(name => caches.delete(name)))
  } catch (err) {
    problems.push(`caches: ${err.message}`)
  }

  try {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('spore')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
      request.onblocked = resolve // other tabs hold it; the reload below clears them
      setTimeout(resolve, 3000)
    })
  } catch (err) {
    problems.push(`database: ${err.message}`)
  }

  try {
    localStorage.removeItem('spore.scripts-allowed')
  } catch { /* already unwritable, so nothing to remove */ }

  return problems
}

/**
 * Which build of the gate is running, and whether a newer one is deployed.
 *
 * Asked directly, and it had no answer: Diagnostics reported the service
 * worker's version but nothing about the page's own code. A browser holding a
 * cached bundle looked identical to one running the current release, which is
 * how a fixed bug gets reported as still broken — accurately, by someone whose
 * browser never received the fix.
 *
 * The deployed copy is fetched with `cache: 'no-store'` so the comparison is
 * against what the origin serves now, not against the same cache that may be
 * the problem.
 */
async function reportGateVersion (add) {
  const { GATE_VERSION } = await import('./config.js')
  add('Gate version', GATE_VERSION, null)

  let deployed = null
  try {
    const response = await fetch(new URL('./config.js', import.meta.url), { cache: 'no-store' })
    if (response.ok) {
      deployed = /GATE_VERSION\s*=\s*'([^']+)'/.exec(await response.text())?.[1] ?? null
    }
  } catch {
    // Offline, or the origin is unreachable. Not knowing is a fine answer; a
    // wrong one would send somebody looking for a problem that is not there.
  }

  if (!deployed) {
    return add('Deployed gate', 'could not be checked from here', null)
  }
  if (deployed === GATE_VERSION) {
    return add('Deployed gate', `${deployed} — this page is current`, true)
  }

  add('Deployed gate', `${deployed} — this page is running ${GATE_VERSION}`, false)
  add('Fix', 'reload with a hard refresh, or press Reset below', false)
}
