/**
 * Wiring: URL fragment and user input in, rendered site out.
 *
 * The gate is one static page. Navigating between sites only rewrites the
 * fragment — the gate itself is never reloaded, and the fragment is never sent
 * to whichever host is serving this bundle.
 */

import { TORRENT_PATH, VERIFY_WITHOUT_ASKING_BYTES } from './config.js'
import { collectDiagnostics, resetBrowserState } from './diagnostics.js'
import { openDatabase, usage } from './idb.js'
import { KEEP_WARNING, forget, isKept, keep, keptSites, restoreAll, restoreOne } from './keep.js'
import { InvalidSiteRef, magnetFor, parseSiteRef, webSeedHosts } from './magnet.js'
import { scriptsAllowed, servePolicyQueries, setScriptsAllowed } from './policy.js'
import {
  checkPublishable, filesFromDrop, filesFromInput, filesFromPicker, publish
} from './publish.js'
import {
  REMEMBER_WARNING, knownKey, labelFor, lastPublished, me, mostRecentKey, nextSeq,
  publicNameFor, publishedSeries, recordPublished, rememberKeyOnDevice,
  restoreRememberedKey, signIn, signOut, useIdentity
} from './me.js'
import { signUpdate } from './record.js'
import {
  MAX_KEY_BYTES, avatar, fingerprint, formatSporePub, normalizeSite, parseSporePub, saltFor
} from './identity.js'
import {
  MAX_MANIFEST_BYTES, SIGNATURE_FILE, checkFile, manifestEntries, manifestWouldExceed,
  missingFrom, signManifest, unlistedIn, verifyManifest
} from './manifest.js'
import {
  asSite, dropJunk, entryFor, entryURL, filePaths, findEntry, pathOf, readManifest, readSporePub
} from './site.js'
import { SiteNotFound, getClient, openTorrent, startClient, startWorker } from './swarm.js'
import { watchForUpdates } from './updates.js'
import {
  author, forgetAuthor, knownSeq, petname, rememberAuthor, rememberVersion, setPetname
} from './authors.js'
import { Viewer, probeSandbox, sandboxWorks } from './viewer.js'

const el = id => document.getElementById(id)

const ui = {
  address: el('address'),
  addressForm: el('address-form'),
  visit: el('visit'),
  visitForm: el('visit-form'),
  viewer: new Viewer(el('viewer')),
  welcome: el('welcome'),
  notice: el('notice'),
  status: el('status'),
  peers: el('peers'),
  progress: el('progress'),
  scripts: el('scripts-toggle'),
  scriptsLabel: el('scripts-label'),
  keep: el('keep-toggle'),
  keepLabel: el('keep-label'),
  kept: el('kept'),
  keptList: el('kept-list'),
  keptUsage: el('kept-usage'),
  share: el('share'),
  shareIntro: el('share-intro'),
  shareNote: el('share-note'),
  shareOpen: el('share-open'),
  shareSuccessor: el('share-successor'),
  shareUnsigned: el('share-unsigned'),
  shareLink: el('share-link'),
  copy: el('copy'),
  shareDismiss: el('share-dismiss'),
  home: el('home'),
  update: el('update'),
  updateAvatar: el('update-avatar'),
  updateTitle: el('update-title'),
  updateDetail: el('update-detail'),
  updateOpen: el('update-open'),
  updateDismiss: el('update-dismiss'),
  error: el('error'),
  errorCode: el('error-code'),
  errorTitle: el('error-title'),
  errorDetail: el('error-detail'),
  errorRef: el('error-ref'),
  errorRetry: el('error-retry'),
  errorHome: el('error-home'),
  filesInput: el('files-input'),
  noEntryDialog: el('no-entry-dialog'),
  noEntryFiles: el('no-entry-files'),
  noEntryAccept: el('no-entry-accept'),
  noEntryCancel: el('no-entry-cancel'),
  listing: el('listing'),
  listingName: el('listing-name'),
  listingSummary: el('listing-summary'),
  listingFiles: el('listing-files'),
  saveTorrent: el('save-torrent'),
  authorChip: el('author'),
  authorChipAvatar: el('author-chip-avatar'),
  authorChipName: el('author-chip-name'),
  authorDialog: el('author-dialog'),
  authorAvatar: el('author-avatar'),
  authorPetname: el('author-petname'),
  authorFingerprint: el('author-fingerprint'),
  authorFacts: el('author-facts'),
  authorLabel: el('author-label'),
  authorForget: el('author-forget'),
  authorClose: el('author-close'),
  authorDismiss: el('author-dismiss'),
  diagnose: el('diagnose'),
  diagnostics: el('diagnostics'),
  diagnosticsBody: el('diagnostics-body'),
  diagnosticsReset: el('diagnostics-reset'),
  diagnosticsClose: el('diagnostics-close'),
  diagnosticsDismiss: el('diagnostics-dismiss'),
  isolationDialog: el('isolation-dialog'),
  isolationAccept: el('isolation-accept'),
  isolationRefuse: el('isolation-refuse'),
  dropzone: el('dropzone'),
  signedIn: el('signed-in'),
  meAvatar: el('me-avatar'),
  meName: el('me-name'),
  meFingerprint: el('me-fingerprint'),
  meHistory: el('me-history'),
  signout: el('signout'),
  signinDialog: el('signin-dialog'),
  signinTitle: el('signin-title'),
  signinWhat: el('signin-what'),
  stepChoose: el('signin-step-choose'),
  stepEnter: el('signin-step-enter'),
  stepConfirm: el('signin-step-confirm'),
  knownAvatar: el('signin-known-avatar'),
  knownLabel: el('signin-known-label'),
  knownFingerprint: el('signin-known-fingerprint'),
  signinOther: el('signin-other'),
  signinSkipKnown: el('signin-skip-known'),
  signinUseKnown: el('signin-use-known'),
  signinSeries: el('signin-series'),
  signinNewSeriesField: el('signin-new-series-field'),
  signinNewSeries: el('signin-new-series'),
  signinSeriesError: el('signin-series-error'),
  passphrase: el('signin-passphrase'),
  reveal: el('signin-reveal'),
  signinError: el('signin-error'),
  signinCancel: el('signin-cancel'),
  signinSkip: el('signin-skip'),
  signinContinue: el('signin-continue'),
  signinAvatar: el('signin-avatar'),
  signinRecognised: el('signin-recognised'),
  signinFingerprint: el('signin-fingerprint'),
  signinLabel: el('signin-label'),
  signinRemember: el('signin-remember'),
  signinDismiss: el('signin-dismiss'),
  signinRisk: el('signin-risk'),
  signinBack: el('signin-back'),
  signinUse: el('signin-use'),
  folder: el('folder-input')
}

/** The site on screen, or null. @type {{torrent: object, ref: string}|null} */
let current = null
let statsTimer = null
/** True once the swarm client exists; until then there is nothing to publish to. */
let ready = false

// Declared here, with the rest of the module state, rather than beside the
// function that reads them. `boot()` runs while this module is still being
// evaluated, so a `const` further down is in its temporal dead zone and the
// whole gate fails to start. That is twice today; the rule is that anything
// boot touches is declared above boot.
/** How often to check that the browser has not taken the worker away. */
const WORKER_CHECK_MS = 10_000
let restoringWorker = false

/** Infohashes kept on this device, refreshed whenever the list changes. */
let keptHashes = new Set()

/**
 * The author of the site on screen and the successor it has offered, if any.
 * @type {{key: object, stop: () => void, offered: object|null}|null}
 */
let authorship = null

boot()

async function boot () {
  servePolicyQueries()

  // Wired before anything is awaited. If the worker is slow to take over, or
  // never does, the page still responds — and a dropped folder is still caught
  // rather than handed to the browser, which would navigate away from Spore.
  window.addEventListener('hashchange', () => route())
  // pushState does not fire hashchange, and going home uses it so the URL is
  // left clean rather than trailing a bare '#'. Back and forward need this too.
  window.addEventListener('popstate', () => route())
  ui.home.addEventListener('click', goHome)
  ui.errorHome.addEventListener('click', goHome)
  ui.errorRetry.addEventListener('click', () => { current = null; route() })
  ui.addressForm.addEventListener('submit', onAddressSubmit)
  ui.visitForm.addEventListener('submit', onAddressSubmit)
  ui.scripts.addEventListener('change', onScriptsToggle)
  ui.keep.addEventListener('change', onKeepToggle)
  ui.copy.addEventListener('click', onCopy)
  ui.shareDismiss.addEventListener('click', () => { ui.share.hidden = true })
  ui.signout.addEventListener('click', onSignOut)
  ui.reveal.addEventListener('change', () => {
    ui.passphrase.type = ui.reveal.checked ? 'text' : 'password'
  })
  ui.signinRisk.addEventListener('click', () => alert(REMEMBER_WARNING))
  ui.updateOpen.addEventListener('click', onUpdateOpen)
  ui.updateDismiss.addEventListener('click', onUpdateDismiss)
  ui.authorChip.addEventListener('click', showAuthor)
  ui.authorClose.addEventListener('click', () => ui.authorDialog.close())
  ui.authorDismiss.addEventListener('click', () => ui.authorDialog.close())
  // Saved on the way out however it is closed — Done, the ✕, or Esc. A name
  // typed and then lost to the wrong exit is exactly the kind of small
  // betrayal that stops people bothering to name anything.
  ui.authorDialog.addEventListener('close', onAuthorClose)
  ui.authorForget.addEventListener('click', onForgetAuthor)
  ui.shareOpen.addEventListener('click', onShare)
  ui.saveTorrent.addEventListener('click', onSaveTorrent)
  ui.diagnose.addEventListener('click', showDiagnostics)
  ui.diagnosticsClose.addEventListener('click', () => ui.diagnostics.close())
  ui.diagnosticsDismiss.addEventListener('click', () => ui.diagnostics.close())
  ui.diagnosticsReset.addEventListener('click', onReset)
  wireDropTarget()
  watchTheWorker()

  try {
    const registration = await startWorker()
    startClient(registration)
  } catch (err) {
    return fail(err)
  }
  ready = true

  // Asked before any site is shown, because the answer decides how it is shown.
  // Not awaited on the critical path: a browser that never answers is treated
  // as the ordinary case, and the site is still opened.
  probeSandbox(new URL(`./${TORRENT_PATH}/probe/`, document.baseURI).href)
    .then(works => { if (!works) noteSandboxFallback() })
    .catch(() => {})

  // Storage being unavailable is survivable — keeping sites offline is not —
  // but the reader should know, because it also explains a lot of odd
  // behaviour in a browser that is blocking site data.
  if (!(await storageWorks())) {
    console.warn('Spore: IndexedDB is unavailable, so sites cannot be kept offline.')
    ui.keepLabel.title = 'Unavailable: this browser is blocking site data.'
  }

  // Deliberately not awaited. Restoring kept sites is a convenience; reading
  // the site in the URL is the point. Blocking one on the other meant that a
  // browser with unhealthy storage never got as far as opening anything, which
  // reads as "Spore is broken" rather than "offline storage is unavailable".
  //
  // The cost is a race: landing directly on a kept site can add a second,
  // memory-backed copy of a torrent already being restored. WebTorrent returns
  // the existing torrent for a duplicate infohash, so the loser is discarded.
  // Storage can fail in ways that are not our doing — Safari throwing
  // UnknownError under pressure, a private window, a browser blocking site
  // data. Unhandled, that was an uncaught rejection at boot and a silent loss
  // of every kept site.
  restoreKept().catch(err =>
    console.warn('Spore: kept sites could not be restored:', err))

  // Same reasoning: a key kept on this device is a convenience for publishing,
  // and nothing on the reading path waits for it.
  restoreIdentity().catch(err =>
    console.warn('Spore: could not restore the key kept on this device:', err))

  route()
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

function currentRef () {
  return decodeURIComponent(location.hash.replace(/^#/, ''))
}

/** Navigate by rewriting the fragment; `route` does the work on the way back. */
function navigate (ref) {
  const encoded = `#${ref}`
  if (location.hash === encoded) route()
  else location.hash = encoded
}

/**
 * Back to the start, from the logo or from a missing-site page.
 *
 * `pushState` rather than clearing `location.hash`, which would leave a bare
 * '#' hanging off the URL. It does not fire `hashchange`, so routing is called
 * directly; `popstate` is wired so the browser's own back button still works.
 */
function goHome () {
  // Routed even with no fragment to clear. A publish that is refused shows the
  // error page without ever setting one, and returning early left its only way
  // out — a button reading "Publish a site instead" — doing nothing at all.
  if (location.hash) history.pushState(null, '', location.pathname + location.search)
  route()
}

/** The reference currently being opened, if any. */
let opening = null

/**
 * Routing has to tolerate being called twice for the same address.
 *
 * A single hash change can reach here more than once — `hashchange` and
 * `popstate` both fire for one — and `open` is asynchronous, so two calls
 * could each look for the torrent, each find nothing, and each add it. The
 * second add fails with "Cannot add duplicate torrent", which surfaced as a
 * generic error instead of the site, or instead of an honest 404.
 */
async function route () {
  const ref = currentRef()
  if (!ref) return showWelcome()
  if (current?.ref === ref || opening === ref) return

  opening = ref
  try {
    await open(ref)
  } finally {
    if (opening === ref) opening = null
  }
}

async function open (ref) {
  let parsed
  try {
    parsed = parseSiteRef(ref)
  } catch (err) {
    return fail(err)
  }

  ui.address.value = ref
  stopWatchingAuthor()
  busy('Looking for peers…')

  try {
    // Disk before swarm. A site kept on this device must come back from
    // storage even when nobody at all is seeding it — that is the entire point
    // of keeping it — and asking the swarm first would race the background
    // restore and often win, leaving the stored copy untouched.
    // The same hook on both paths. A kept site is added to the client by the
    // restore, so attaching only in openTorrent's callback would attach after
    // its peers had already handshaked, and a site kept offline would never
    // hear that a new version exists.
    const join = joined => {
      watchJoining(joined)
      watchAuthor(joined)
    }

    if (parsed.infoHash) await restoreOne(getClient(), parsed.infoHash, join)

    const torrent = await openTorrent(parsed.magnetURI, join)
    stopJoining()

    const entry = findEntry(torrent)

    // Without a controller the iframe's request never reaches the worker and
    // the reader gets the host's 404 instead of the site. Better to say so.
    if (!navigator.serviceWorker.controller) {
      throw new Error(
        'Spore found the site but cannot display it: the service worker is not ' +
        'running. Reload the page. (Service workers need HTTPS, and are ' +
        'disabled in Firefox private windows.)')
    }

    current = { torrent, ref }
    watchForTrouble(torrent, ref)

    // A torrent without an index.html is not a broken site, it is not a site.
    // Refusing it outright made a whole category of torrent — an archive, an
    // album, a dataset — a dead end, when its contents are perfectly readable.
    if (entry) await render(torrent, entry)
    else { showListing(torrent); nameAuthor(torrent, null) }
  } catch (err) {
    stopJoining()
    fail(err)
  }
}

/**
 * A torrent can fail after it is open, and until now nothing said so.
 *
 * `withMetadata` listens for `error` only until metadata arrives, then drops
 * the listener. Anything that goes wrong afterwards — a storage layer refusing
 * to write, a store that cannot be read back — left the reader with an empty
 * frame, a healthy-looking status bar and green diagnostics, which is an
 * unreportable failure. It was reported exactly that way from an iPhone.
 *
 * The message is shown verbatim rather than translated into something
 * reassuring: the whole value of it is that the reader can quote it back.
 */
function watchForTrouble (torrent, ref) {
  const onError = err => {
    if (current?.ref !== ref) return

    const message = String(err?.message ?? err)
    console.error('Spore: the torrent failed after it was open:', err)

    ui.notice.textContent =
      `This site stopped working after it loaded: ${message}. ` +
      'That is a failure inside the browser rather than the swarm, so ' +
      'Diagnostics will probably look healthy. The message above is the useful part.'
    ui.notice.className = 'notice notice--error'
    ui.notice.hidden = false
  }

  torrent.on('error', onError)
}

/**
 * Say what is actually happening while waiting for a swarm.
 *
 * "Looking for peers…" on its own is indistinguishable from a hung page, a
 * dead tracker and a site nobody is seeding — all three of which look like
 * "it doesn't work". Peer counts, elapsed time and tracker complaints tell
 * those three apart without opening a console.
 */
let joiningTimer = null

function watchJoining (torrent) {
  stopJoining()
  const startedAt = Date.now()
  const trackerProblems = new Set()

  const onWarning = err => {
    const message = String(err?.message ?? err)
    const tracker = /(wss?:\/\/[^\s/]+)/.exec(message)
    if (tracker) trackerProblems.add(tracker[1])
  }
  torrent.on('warning', onWarning)

  const tick = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const found = torrent.numPeers === 1 ? '1 peer' : `${torrent.numPeers} peers`
    const trouble = trackerProblems.size > 0
      ? ` · ${trackerProblems.size} tracker${trackerProblems.size === 1 ? '' : 's'} unreachable`
      : ''
    // A connected peer is not progress. It can be another reader waiting for
    // the same thing, which is exactly the case that used to look like a dead
    // site — so say what is being waited for rather than let a peer count
    // imply the site is on its way.
    const stalled = seconds >= 10 && torrent.numPeers > 0
      ? ' · connected, but nobody has sent the site yet — asking for more peers'
      : ''

    busy(`Looking for peers… ${found} after ${seconds}s${trouble}` +
      (seconds >= 8 && torrent.numPeers === 0 ? ' · nobody has answered yet' : stalled))
    ui.peers.textContent = found
  }
  tick()

  joiningTimer = setInterval(tick, 1000)
  torrent.once('metadata', stopJoining)
}

function stopJoining () {
  clearInterval(joiningTimer)
  joiningTimer = null
}

async function render (torrent, entry) {
  // Asked before anything is shown, not after. On an engine that cannot serve
  // a sandboxed frame the reader is accepting a real, if narrow, loss, and
  // showing them the site first would be presenting it as a formality.
  if (sandboxWorks() === false && !(await askAboutIsolation())) {
    return showIsolationRefused(torrent)
  }

  const allowed = scriptsAllowed(torrent.infoHash)

  ui.scripts.checked = allowed
  ui.scripts.disabled = false
  ui.scriptsLabel.hidden = false
  ui.keep.checked = await isKept(torrent.infoHash)
  ui.keep.disabled = false
  ui.keepLabel.hidden = false
  ui.saveTorrent.hidden = false
  ui.shareOpen.hidden = false
  const shown = ui.viewer.show(entryURL(torrent.infoHash, entry), { scripts: allowed })
  ui.welcome.hidden = true
  ui.notice.hidden = true
  ui.error.hidden = true
  ui.status.textContent = torrent.name ?? torrent.infoHash

  watchStats(torrent)
  nameAuthor(torrent, entry)

  // Awaited last, deliberately: this only reports a frame that never navigated
  // and must not hold up one that does.
  if (!(await shown)) warnViewerStuck()
}

/* -------------------------------------------------------------------------- */
/* Signing in                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ask, once per publication, whether to sign it.
 *
 * At publish time rather than as a login, because that is when the question is
 * a real one: signing is what makes a *later* version reachable from this one,
 * and a site published without a key is a perfectly good site that simply can
 * never be updated. Asking up front turned it into an account to create before
 * you were allowed to do anything, which it is not.
 *
 * @returns {Promise<{sign: boolean}|null>} null if the publisher backed out
 */
function askAboutSigning (what) {
  ui.signinWhat.textContent = what ?? 'these files'
  ui.passphrase.value = ''

  // Offered back rather than asked for again. A publisher who named their key
  // once should not have to remember what they called it, and a blank field
  // reads as "this was not saved".
  const recent = mostRecentKey()
  ui.signinLabel.value = recent?.label ?? ''
  ui.reveal.checked = false
  ui.passphrase.type = 'password'
  ui.signinError.hidden = true
  ui.signinSeriesError.hidden = true
  ui.signinRemember.checked = false

  const known = me()
  if (known) showChooseStep(known)
  else showStep(ui.stepEnter, 'Sign this site?')

  ui.signinDialog.showModal()

  return new Promise(resolve => {
    /** The identity this dialog will sign with, once one is settled on. */
    let chosen = known
    /** Derived in this dialog and not yet confirmed. */
    let derived = null

    const finish = answer => {
      ui.signinDialog.close()
      cleanup()
      resolve(answer)
    }

    const onContinue = async () => {
      const passphrase = ui.passphrase.value
      if (!passphrase) {
        ui.signinError.textContent = 'A passphrase is needed to sign.'
        ui.signinError.hidden = false
        return
      }

      // Deriving is ~1.2M PBKDF2 iterations and is meant to be slow, so say so
      // rather than leaving a dead button for a second.
      ui.signinContinue.disabled = true
      ui.signinContinue.textContent = 'Deriving…'
      ui.signinError.hidden = true
      try {
        derived = await signIn(passphrase)
        await showConfirmStep(derived)
      } catch (err) {
        ui.signinError.textContent = err.message
        ui.signinError.hidden = false
      } finally {
        ui.signinContinue.disabled = false
        ui.signinContinue.textContent = 'Continue'
      }
    }

    // Confirming the key does not publish: which of this author's sites the
    // folder belongs to is still unanswered, and it is the question that stops
    // a new page being announced as the successor to an old blog.
    const onConfirmed = async () => {
      if (!derived) return
      useIdentity(derived, ui.signinLabel.value)

      if (ui.signinRemember.checked) {
        try {
          await rememberKeyOnDevice(derived)
        } catch (err) {
          // Refusing to publish over this would be absurd: the key works, it
          // just will not survive the reload.
          console.warn('Spore: could not keep the key on this device:', err)
        }
      }

      chosen = derived
      await showSignedIn(derived)
      await showChooseStep(derived)
    }

    const onSign = () => {
      let site
      try {
        site = selectedSeries()
      } catch (err) {
        ui.signinSeriesError.textContent = err.message
        ui.signinSeriesError.hidden = false
        return
      }
      finish({ sign: true, site, identity: chosen })
    }

    const onSeriesChange = () => {
      ui.signinNewSeriesField.hidden = ui.signinSeries.value !== NEW_SERIES
      ui.signinSeriesError.hidden = true
      if (!ui.signinNewSeriesField.hidden) ui.signinNewSeries.focus()
    }

    const onOther = () => showStep(ui.stepEnter, 'Sign with a different key')
    const onBack = () => showStep(ui.stepEnter, 'Sign this site?')
    const onSkip = () => finish({ sign: false })
    const onCancel = () => finish(null)

    // Esc closes a dialog without any button being pressed, and that is the
    // same intent as Cancel: publish nothing.
    const onClose = () => { cleanup(); resolve(null) }

    ui.signinContinue.addEventListener('click', onContinue)
    ui.signinUse.addEventListener('click', onConfirmed)
    ui.signinUseKnown.addEventListener('click', onSign)
    ui.signinSeries.addEventListener('change', onSeriesChange)
    ui.signinOther.addEventListener('click', onOther)
    ui.signinBack.addEventListener('click', onBack)
    ui.signinSkip.addEventListener('click', onSkip)
    ui.signinSkipKnown.addEventListener('click', onSkip)
    ui.signinCancel.addEventListener('click', onCancel)
    ui.signinDismiss.addEventListener('click', onCancel)
    ui.signinDialog.addEventListener('close', onClose)

    function cleanup () {
      ui.signinContinue.removeEventListener('click', onContinue)
      ui.signinUse.removeEventListener('click', onConfirmed)
      ui.signinUseKnown.removeEventListener('click', onSign)
      ui.signinSeries.removeEventListener('change', onSeriesChange)
      ui.signinOther.removeEventListener('click', onOther)
      ui.signinBack.removeEventListener('click', onBack)
      ui.signinSkip.removeEventListener('click', onSkip)
      ui.signinSkipKnown.removeEventListener('click', onSkip)
      ui.signinCancel.removeEventListener('click', onCancel)
      ui.signinDismiss.removeEventListener('click', onCancel)
      ui.signinDialog.removeEventListener('close', onClose)
    }
  })
}



/**
 * Hand the screen back after a publish that did not happen.
 *
 * A site that was already open is left where it is: the reader was reading it,
 * and backing out of publishing something else is not a reason to close it.
 */
function backOut () {
  ui.notice.hidden = true
  restoreStage()
}

/**
 * Put back whatever the publish attempt covered up.
 *
 * `busy()` hides the landing page *and* the file listing, and a listing is not
 * drawn in the viewer, so nothing else brings it back: for a torrent with no
 * entry page, "there is still a site open" and "there is still something on
 * screen" were two different questions, and only the first was being asked.
 */
function restoreStage () {
  if (!current) return showWelcome()
  if (!findEntry(current.torrent)) showListing(current.torrent)
}

/**
 * A publish that failed, reported without destroying what is on screen.
 *
 * Drops are wired to the whole window, so a corrupt archive can land while
 * somebody is reading a site. `fail()` clears `current` and replaces the viewer
 * with an error page, which for a refused archive means the reader loses the
 * site they were on because of a file they dropped by accident.
 */
function failToPublish (error) {
  if (!current) return fail(new PublishFailed(error))

  // Before the notice, because showing a listing clears it.
  restoreStage()
  ui.notice.textContent = `That could not be published: ${error.message}`
  ui.notice.className = 'notice notice--error'
  ui.notice.hidden = false
}


/** A list of paths, with a tail when there are more than a dialog should show. */
function listItems (paths, limit = 12) {
  const items = paths.sort((a, b) => a.localeCompare(b)).slice(0, limit).map(path => {
    const item = document.createElement('li')
    item.textContent = path
    return item
  })
  if (paths.length > limit) {
    const more = document.createElement('li')
    more.className = 'muted'
    more.textContent = `and ${paths.length - limit} more`
    items.push(more)
  }
  return items
}

/**
 * Tell an author their files will open as a list, and let them go back.
 *
 * Deliberately a question and not an error: `entryFor` is the same rule the
 * viewer uses, so this is Spore reporting what a reader will actually land on,
 * which is a thing the author is in a position to change and nobody else is.
 *
 * @returns {Promise<boolean>} whether to publish it anyway
 */
function askAboutMissingEntry (files) {
  ui.noEntryFiles.replaceChildren(...listItems(files.map(file => file.fullPath || file.name)))
  ui.noEntryDialog.showModal()

  return new Promise(resolve => {
    const answer = publishAnyway => {
      ui.noEntryDialog.close()
      cleanup()
      resolve(publishAnyway)
    }

    const onAccept = () => answer(true)
    const onCancel = () => answer(false)
    // Dismissing is going back, not agreeing.
    const onClose = () => { cleanup(); resolve(false) }

    ui.noEntryAccept.addEventListener('click', onAccept)
    ui.noEntryCancel.addEventListener('click', onCancel)
    ui.noEntryDialog.addEventListener('close', onClose)

    function cleanup () {
      ui.noEntryAccept.removeEventListener('click', onAccept)
      ui.noEntryCancel.removeEventListener('click', onCancel)
      ui.noEntryDialog.removeEventListener('close', onClose)
    }
  })
}

/** Sentinel for "not one of the sites I have published before". */
const NEW_SERIES = '\u0000new'

/** @returns {string|null} the series name, or null for the default series */
function selectedSeries () {
  if (ui.signinSeries.value !== NEW_SERIES) return ui.signinSeries.value || null

  // normalizeSite throws with a message written for whoever typed it.
  const site = normalizeSite(ui.signinNewSeries.value)
  if (!site) throw new SyntaxError('Give this site a short name, like "blog".')
  return site
}

function showStep (step, title) {
  for (const section of [ui.stepChoose, ui.stepEnter, ui.stepConfirm]) {
    section.hidden = section !== step
  }
  ui.signinTitle.textContent = title
  if (step === ui.stepEnter) ui.passphrase.focus()
}

async function showChooseStep (identity) {
  const label = labelFor(identity.hex)
  ui.knownAvatar.replaceChildren(await avatarNode(identity.publicKey))
  ui.knownLabel.textContent = label ?? 'Your key'
  ui.knownFingerprint.textContent = await fingerprint(identity.publicKey)

  // Sites already published under this key, so the usual case — another
  // version of something that exists — is a single click and no typing.
  const series = publishedSeries(identity.hex)
  ui.signinSeries.replaceChildren(
    ...series.map(entry => {
      const option = document.createElement('option')
      option.value = entry.site ?? ''
      option.textContent = entry.site ?? 'the default site'
      return option
    }),
    Object.assign(document.createElement('option'),
      { value: NEW_SERIES, textContent: series.length ? 'a new site…' : 'a new site' })
  )
  ui.signinSeries.value = series.length ? (series[0].site ?? '') : NEW_SERIES
  ui.signinNewSeriesField.hidden = ui.signinSeries.value !== NEW_SERIES
  ui.signinNewSeries.value = ''

  showStep(ui.stepChoose, 'Sign this site?')
}

/**
 * The step that does the actual work.
 *
 * There is no account to be wrong at, so a mistyped passphrase yields a
 * different valid identity rather than an error, and nothing can detect that
 * for you. Showing the key — large enough to recognise — is the only check
 * that exists, and it is the same check a reader performs at the other end.
 */
async function showConfirmStep (derived) {
  const known = knownKey(derived.hex)
  ui.signinAvatar.replaceChildren(await avatarNode(derived.publicKey))
  ui.signinFingerprint.textContent = await fingerprint(derived.publicKey)

  // A key already known here keeps the name it was given, whatever was typed
  // into the field this time — renaming should be deliberate, not a side effect
  // of a password manager filling in something else.
  ui.signinRecognised.textContent = known
    ? `Recognised — ${known.label ?? 'you have used this key here before'}`
    : 'New to this browser'
  ui.signinRecognised.className = known ? 'recognised' : 'recognised recognised--new'

  // The prefill was a guess from the most recent key; now the key is known, use
  // what was actually stored for it.
  if (known?.label) ui.signinLabel.value = known.label

  showStep(ui.stepConfirm, known ? 'Welcome back' : 'Is this your key?')
}

async function onSignOut () {
  await signOut()
  ui.signedIn.hidden = true
}

async function showSignedIn (identity) {
  const label = labelFor(identity.hex)
  const series = publishedSeries(identity.hex)

  ui.meAvatar.replaceChildren(await avatarNode(identity.publicKey))
  ui.meName.textContent = label ? `Signing as ${label}` : 'Signing as'
  ui.meFingerprint.textContent = await fingerprint(identity.publicKey)
  ui.meHistory.textContent = series.length
    ? `${series.length} site${series.length === 1 ? '' : 's'} published from this browser. `
    : ''
  ui.signedIn.hidden = false
}

/**
 * A key kept on this device comes back on load, so publishing needs no
 * passphrase. Failing is unremarkable — nothing was kept, or storage is
 * unavailable — and simply means the next publish asks.
 */
async function restoreIdentity () {
  const identity = await restoreRememberedKey()
  if (identity) await showSignedIn(identity)
}

/* -------------------------------------------------------------------------- */
/* Authorship and updates                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Listen for a signed successor to the site on screen.
 *
 * A site is updatable only if it says so itself, by shipping a `spore.pub`
 * beside its index. The key in that file is the only key whose records this
 * site will accept — which is what makes an update an update rather than a
 * redirect: the new version is published by whoever published the old one, and
 * nothing else can take its place.
 *
 * Peers are the only delivery route available. BEP 46 resolves successors
 * through the DHT, which speaks UDP, which a browser cannot open at all — so
 * the record travels over the wire between peers instead. Same record, same
 * signature, different envelope. See spec/mutable-sites.md.
 */
/**
 * Records this browser can pass on, keyed by `<key hex>/<site>`.
 *
 * A reader who has been told is the cheapest source for the next reader, and
 * frequently the only reachable one: a swarm's publisher is a single peer among
 * many, and a reader holding a complete copy is rarely introduced to it. Until
 * this existed the news had exactly one source, which is not what a peer to
 * peer design is for.
 */
const knownRecords = new Map()

/** One watcher per torrent, kept for the torrent's life rather than the page's. */
const watchers = new Map()

const seriesOf = key => `${key.hex}/${key.site ?? ''}`

/**
 * Listen for successors on a torrent, and pass on anything heard.
 *
 * Deliberately outlives the view. Navigating away used to tear this down, so a
 * reader who took an update immediately stopped telling anybody else about it
 * while still seeding the version it superseded. Exactly backwards: having been
 * told is what qualifies you to tell.
 */
function watchTorrentForUpdates (torrent) {
  if (watchers.has(torrent)) return watchers.get(torrent)

  let announceKey
  const entry = { key: null, announceKey: null }
  const ready = new Promise(resolve => { announceKey = resolve })

  entry.announceKey = key => {
    entry.key = key
    announceKey(key)
  }

  entry.stop = watchForUpdates(torrent, {
    publicKey: () => ready.then(k => k?.publicKey ?? null),
    salt: () => ready.then(k => k?.salt ?? null),

    // Synchronous, because it is answered during the handshake. Whatever this
    // browser has been told about this series, it offers.
    offer: () => entry.key ? knownRecords.get(seriesOf(entry.key))?.record ?? null : null,

    knownSeq: () => entry.key ? knownSeq(entry.key.hex, entry.key.site) : undefined,
    currentInfoHash: () => torrent.infoHash,
    onRejected: reason => console.debug('Spore: refused an update —', reason),

    onUpdate: update => {
      if (!entry.key) return
      const series = seriesOf(entry.key)
      const held = knownRecords.get(series)
      if (!held || update.seq >= held.seq) knownRecords.set(series, update)

      // Only the site actually on screen gets to interrupt the reader.
      if (authorship?.torrent === torrent) offerUpdate(entry.key, update)
    }
  })

  watchers.set(torrent, entry)
  torrent.once('close', () => watchers.delete(torrent))
  return entry
}

function watchAuthor (torrent) {
  if (authorship?.torrent === torrent) return

  stopWatchingAuthor()

  // The listening is the torrent's, not the view's: `watchTorrentForUpdates`
  // attaches once, before any handshake, and keeps going after the reader has
  // moved on. This only records which torrent the chrome is currently about.
  watchTorrentForUpdates(torrent)
  authorship = { torrent, key: null, offered: null }
}

/**
 * Now that the files are readable, say who — if anyone — this site trusts.
 *
 * Resolving with null is a real answer, not a failure: it releases any record
 * already waiting to be checked, which is then refused because a site that
 * declares no key can have no successor.
 */
async function nameAuthor (torrent, entry) {
  if (!authorship || current?.torrent !== torrent) return

  const key = entry ? await readSporePub(torrent, entry) : null
  if (!authorship || current?.torrent !== torrent) return

  authorship.key = key
  watchTorrentForUpdates(torrent).announceKey(key)

  // Said out loud, because a missing chip and a chip that has not loaded look
  // identical — and "unsigned" is a real answer to "who published this", not
  // the absence of one. An unsigned site can never be updated either, which is
  // worth knowing before bookmarking it.
  if (!key) {
    ui.authorChipAvatar.replaceChildren()
    ui.authorChipName.textContent = 'unsigned'
    ui.authorChip.title =
      'Nobody signed this site, so there is no author to check and no newer ' +
      'version it could ever be replaced by.'
    ui.authorChip.disabled = true
    ui.authorChip.hidden = false
    return
  }
  ui.authorChip.disabled = false

  // Meeting an author is worth remembering even when no update ever arrives:
  // it is what makes the next meeting recognisable as the same person.
  rememberAuthor(key.hex, { claimed: key.claimedName, infoHash: torrent.infoHash })
  await showAuthorChip(key)

  // The torrent identifies what is being verified, not the address it was
  // reached by: `ref` is not in scope here, and a bare infohash and a magnet
  // for the same site are the same thing to verify.
  verifyContent(torrent, entry, key)
}

/**
 * Check the site's own bytes against what its key signed.
 *
 * Three states, and the middle one is the one that was missing. A site can
 * declare a key without holding it — copying somebody's `spore.pub` is free —
 * so "declares a key" and "proved it" are different claims and readers are
 * entitled to see which they are looking at.
 *
 * Not awaited by the caller: the page is readable while this runs, and hashing
 * a large site should never be what stands between a reader and the text.
 */
async function verifyContent (torrent, entry, key) {
  const settle = state => {
    if (current?.torrent !== torrent || authorship?.key?.hex !== key.hex) return
    authorship.verified = state
    showAuthorChip(key)
  }

  settle({ status: 'checking' })

  const manifest = await readManifest(torrent, entry)
  if (!manifest) {
    return settle({ status: 'unverified', reason: `this site ships no ${SIGNATURE_FILE}` })
  }

  const result = await verifyManifest(manifest.contents, key.hex)
  if (!result.ok) return settle({ status: 'broken', reason: result.reason })

  // Checking means hashing, and hashing means downloading. Since the digest
  // learned to stream, nothing stops this from pulling a four-gigabyte film off
  // the swarm in the background to fill in a chip — so there is a budget, and
  // above it the honest answer is that the site was not checked here rather
  // than a quiet hour of someone else's bandwidth.
  const weight = torrent.files
    .filter(file => file.path.replace(/\\/g, '/').startsWith(manifest.root))
    .reduce((total, file) => total + file.length, 0)

  if (weight > VERIFY_WITHOUT_ASKING_BYTES) {
    return settle({
      status: 'unverified',
      reason: `checking this would download ${formatBytes(weight)} of it`
    })
  }

  const present = filePaths(torrent, manifest.root)
  const extra = unlistedIn(result.manifest, present)
  if (extra.length > 0) {
    return settle({ status: 'broken', reason: `${extra[0]} is not covered by the signature` })
  }
  const absent = missingFrom(result.manifest, present)
  if (absent.length > 0) {
    return settle({ status: 'broken', reason: `${absent[0]} is signed for but missing` })
  }

  // Every file, not a sample: a signature that covers only what somebody
  // happened to look at is not a signature over the site.
  for (const file of torrent.files) {
    if (current?.torrent !== torrent) return
    const path = file.path.replace(/\\/g, '/')
    if (!path.startsWith(manifest.root)) continue

    const relative = path.slice(manifest.root.length)
    if (relative === SIGNATURE_FILE) continue

    // The file itself rather than its bytes. `checkFile` digests it whole where
    // it fits and streams it where it does not, so a film is checked without a
    // film ever being in memory. There is no size above which a site stops
    // being checkable, and so none above which its author is wrongly told it
    // has been altered.
    let check
    try {
      check = await checkFile(result.manifest, relative, file)
    } catch (err) {
      // A file that could not be *read* is not a file that failed its hash.
      return settle({
        status: 'unverified',
        reason: `${relative} could not be read here: ${err.message}`
      })
    }
    if (!check.ok) return settle({ status: 'broken', reason: check.reason })
  }

  settle({ status: 'verified', files: result.manifest.entries.length })
}

/**
 * The chip in the status bar: who signed this, and a way to look closer.
 *
 * It shows the reader's own name for the key when they have given one, and
 * falls back to the key's own claim about itself — visibly quoted, because
 * those two things carry completely different weight and the difference is the
 * whole point.
 */
async function showAuthorChip (key) {
  const mine = petname(key.hex)
  const name = mine ?? (key.claimedName ? `“${key.claimedName}”` : 'a key')
  const state = authorship?.verified?.status ?? 'checking'

  ui.authorChipAvatar.replaceChildren(await avatarNode(key.publicKey))

  // A mark for the state, because "declares a key" and "proved it" read
  // identically otherwise, and the difference is the whole point of spore.sig.
  const mark = { verified: '\u2713', broken: '\u2717', checking: '\u2026' }[state] ?? '?'
  ui.authorChipName.textContent = `${mark} ${name}`
  ui.authorChip.dataset.state = state

  ui.authorChip.title = {
    verified: `Every file signed by ${name}. Click to check who that is.`,
    unverified: `${name} is declared but nothing proves it. Click for what that means.`,
    broken: `This site does not match its own signature. Click for details.`,
    checking: 'Checking the signature over this site...'
  }[state]
  ui.authorChip.hidden = false
}

/**
 * Everything this browser can honestly say about the key that signed the site
 * on screen.
 *
 * The reader asked to check, so the answer has to include the parts that do not
 * flatter: what a signature actually proves, that the declared name is the
 * key's own claim, and whether this key has ever been seen here before.
 */
async function showAuthor () {
  const key = authorship?.key
  if (!key) return

  const mine = petname(key.hex)
  const met = author(key.hex)
  const seenSeq = knownSeq(key.hex, key.site)

  ui.authorAvatar.replaceChildren(await avatarNode(key.publicKey))
  ui.authorPetname.textContent = mine ?? 'You have not named this author'
  ui.authorPetname.className = mine ? 'recognised' : 'recognised recognised--new'
  ui.authorFingerprint.textContent = await fingerprint(key.publicKey)
  ui.authorLabel.value = mine ?? ''
  ui.authorForget.hidden = !met && !mine

  const verified = authorship?.verified
  const signature = {
    verified: `yes, all ${verified?.files ?? '?'} files match what this key signed`,
    unverified: `no. ${verified?.reason ?? 'nothing was checked'}`,
    broken: `NO. ${verified?.reason ?? 'the site does not match its signature'}`,
    checking: 'still checking'
  }[verified?.status ?? 'checking']

  const facts = [
    ['Content signed', signature],
    ['Calls itself', key.claimedName ? `“${key.claimedName}” — their own claim` : 'nothing'],
    ['Site', key.site ? key.site : 'the author’s default site'],
    ['Public key', key.hex, 'mono'],
    ['Version you are reading', seenSeq ? describeVersion(seenSeq) : 'not recorded'],
    ['Seen here before', met
      ? `yes, first on ${new Date(met.seenAt).toLocaleDateString()}`
      : 'no — this is the first time']
  ]

  ui.authorFacts.replaceChildren(...facts.flatMap(([term, value, className]) => {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    if (className) dd.className = className
    return [dt, dd]
  }))

  ui.authorDialog.showModal()
}

/** The name is the reader's own note, so it is saved by closing, not by asking. */
async function onAuthorClose () {
  const key = authorship?.key
  if (!key) return

  setPetname(key.hex, ui.authorLabel.value)
  await showAuthorChip(key)
}

async function onForgetAuthor () {
  const key = authorship?.key
  if (!key) return ui.authorDialog.close()

  forgetAuthor(key.hex)
  ui.authorDialog.close()
  await showAuthorChip(key)
}

/**
 * Forget what the chrome is showing. The swarm listening continues.
 *
 * These used to be the same act, which meant that taking an update stopped you
 * telling anyone else about it, while you went on seeding the version it
 * replaced. A reader who has been told is the best source there is.
 */
function stopWatchingAuthor () {
  authorship = null
  ui.update.hidden = true
  ui.authorChip.hidden = true
  delete ui.authorChip.dataset.state
}

/**
 * Offer the successor. Never take it.
 *
 * The signature proves who wrote the new version, not that the reader wants to
 * be moved to it. Following it silently would mean a page could be swapped
 * under someone mid-read by anyone who once held the key — including a key that
 * has since been stolen. So the record is verified automatically and acted on
 * manually, which is the same shape as the scripts toggle.
 */
async function offerUpdate (key, update) {
  // The first record to arrive wins until it is acted on; a later, higher one
  // replaces it, because there is no point offering a version that is already
  // stale by the time the reader clicks.
  if (authorship?.offered && authorship.offered.seq >= update.seq) return
  if (!authorship) return

  authorship.offered = update

  const known = author(key.hex)
  const claimed = key.claimedName ? `“${key.claimedName}”` : 'the author'
  const returning = known?.seq !== undefined

  ui.updateAvatar.replaceChildren(await avatarNode(key.publicKey))
  ui.updateTitle.textContent = `${claimed} has published a newer version.`
  ui.updateDetail.textContent =
    `${describeVersion(update.seq)}, signed by ${await fingerprint(key.publicKey)}` +
    (returning
      ? ' — the same key as the version you are reading.'
      : ' — the key this site declares. A name is a claim; the key is not.')
  ui.update.hidden = false
}

/**
 * How to say which version this is.
 *
 * Spore numbers versions with the clock, so a sequence number is a millisecond
 * timestamp and reads as noise. Rendered as a date it says something a reader
 * can act on — "is this newer than what I am looking at, and by how long".
 *
 * Small numbers are left as numbers. BEP 44 says nothing about what a seq
 * means, another implementation may well count from 1, and printing 1970 for
 * version 3 would be worse than printing 3.
 */
function describeVersion (seq) {
  // Roughly 2001; below this a value is a counter, not a clock.
  if (seq < 1_000_000_000_000) return `Version ${seq}`

  const when = new Date(seq)
  const sameDay = new Date().toDateString() === when.toDateString()
  return sameDay
    ? `Published today at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : `Published ${when.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}`
}

/**
 * The avatar is built from the key, so two keys claiming one name never look
 * alike. Parsed rather than assigned as markup: it is derived from bytes a
 * stranger chose, and this element sits in the gate's own chrome.
 */
async function avatarNode (publicKey) {
  const doc = new DOMParser().parseFromString(await avatar(publicKey), 'image/svg+xml')
  return document.importNode(doc.documentElement, true)
}

/** Taking the offer is ordinary navigation, so the address bar and back button work. */
function onUpdateOpen () {
  const update = authorship?.offered
  if (!update) return

  // Only now, when the reader has said yes, does this become the version this
  // browser knows about — so declining leaves an older record still offerable.
  rememberVersion(authorship.key.hex, {
    site: authorship.key.site,
    seq: update.seq,
    infoHash: update.infoHash,
    claimed: authorship.key.claimedName
  })

  ui.update.hidden = true

  // No display name. The record names an infohash and nothing else — the new
  // version's own name is inside metadata we have not fetched yet, and putting
  // the author's name there instead would label the site with the wrong thing.
  navigate(magnetFor(update.infoHash))
}

function onUpdateDismiss () {
  ui.update.hidden = true
}

/**
 * Say, once, that this browser cannot isolate sites the usual way.
 *
 * WebKit will not let the service worker serve a sandboxed frame, so on iOS the
 * choice is between showing sites without that attribute and not showing them
 * at all. Readers are told rather than quietly given less, and the scripts
 * toggle is withdrawn: the shared origin it already costs is defensible behind
 * a sandbox and is not without one.
 */
const ISOLATION_KEY = 'spore.reduced-isolation'

/**
 * Ask before showing anything on an engine that cannot sandbox a frame.
 *
 * Measured rather than assumed, because the answer decides what to tell the
 * reader. Clicking `target="_blank"` inside a site, with and without the
 * attribute:
 *
 *   with sandbox      no tab opened, the third party is never contacted
 *   without sandbox   a tab opens on it, and it sees the reader's IP
 *
 * Everything else survives: scripts stay impossible, requests stay inside the
 * torrent, and a site still cannot navigate itself elsewhere — that last one is
 * held by the gate's own `frame-src 'self'`, not by the sandbox, which is why
 * it does not move.
 *
 * So the honest question is narrow, and it is the reader's: one deliberate
 * click can reveal your address to somebody. Spore asks before running scripts
 * and before writing to disk; this is larger than either.
 */
function noteSandboxFallback () {
  ui.scripts.disabled = true
  ui.scripts.checked = false
  ui.scripts.title =
    'Unavailable in this browser: it cannot isolate a site in a sandboxed frame.'
}

/**
 * The reader said no. Say what that means and leave the decision reversible.
 *
 * Not an error page: nothing failed. They declined a trade, and the site is
 * still there, still verifiable, still readable in a browser that can sandbox
 * a frame.
 */
function showIsolationRefused (torrent) {
  stopJoining()
  ui.viewer.clear()
  ui.welcome.hidden = true
  ui.listing.hidden = true
  ui.error.hidden = true

  ui.notice.innerHTML = ''
  const text = document.createElement('p')
  text.textContent =
    `“${torrent.name ?? torrent.infoHash}” was downloaded and verified, and is ` +
    'not being shown, because this browser cannot isolate it in a sandboxed ' +
    'frame and you chose not to accept that. Nothing is wrong with the site. ' +
    'It will display normally in a browser that can, and the same link works ' +
    'there.'

  const again = document.createElement('button')
  again.type = 'button'
  again.className = 'link'
  again.textContent = 'Change that decision'
  again.addEventListener('click', () => {
    try { localStorage.removeItem(ISOLATION_KEY) } catch { /* nothing kept */ }
    current = null
    route()
  })

  ui.notice.append(text, again)
  ui.notice.className = 'notice'
  ui.notice.hidden = false
  ui.status.textContent = `${torrent.name ?? torrent.infoHash} — not shown`
}

/** @returns {'yes'|'no'|null} what this browser was told last time */
function isolationChoice () {
  try {
    return localStorage.getItem(ISOLATION_KEY)
  } catch {
    return null // unreadable storage: ask again rather than assume consent
  }
}

/**
 * @returns {Promise<boolean>} whether sites may be shown in this browser
 */
function askAboutIsolation () {
  const decided = isolationChoice()
  if (decided) return Promise.resolve(decided === 'yes')

  ui.isolationDialog.showModal()

  return new Promise(resolve => {
    const answer = allowed => {
      try {
        localStorage.setItem(ISOLATION_KEY, allowed ? 'yes' : 'no')
      } catch {
        // The decision still stands for this session; it will be asked again.
      }
      ui.isolationDialog.close()
      cleanup()
      resolve(allowed)
    }

    const onAccept = () => answer(true)
    const onRefuse = () => answer(false)
    // Dismissing without choosing is not consent.
    const onClose = () => { cleanup(); resolve(false) }

    ui.isolationAccept.addEventListener('click', onAccept)
    ui.isolationRefuse.addEventListener('click', onRefuse)
    ui.isolationDialog.addEventListener('close', onClose)

    function cleanup () {
      ui.isolationAccept.removeEventListener('click', onAccept)
      ui.isolationRefuse.removeEventListener('click', onRefuse)
      ui.isolationDialog.removeEventListener('close', onClose)
    }
  })
}

/**
 * Notice when the browser takes the service worker away.
 *
 * Spore checked for a controller once, when opening a site, and never again.
 * That held on desktop and does not on iOS: WebKit evicts registrations under
 * memory pressure, mid-session, without telling the page. Reported from an
 * iPhone that had been working minutes earlier and then showed
 *
 *     Worker controlling   NO
 *     Registrations        none
 *     Viewer response      404, 9379 bytes
 *
 * which is the host's own 404, because with nothing intercepting it the
 * iframe's request goes to the network. From the reader's side: a white page,
 * and every other indicator green.
 *
 * `controllerchange` is not enough on its own, since a registration can be
 * dropped while the page stays nominally controlled, so the registration list
 * is what is actually watched.
 */
function watchTheWorker () {
  if (!navigator.serviceWorker) return

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!navigator.serviceWorker.controller) restoreWorker()
  })

  setInterval(async () => {
    if (!current || restoringWorker) return

    let registrations = []
    try {
      registrations = await navigator.serviceWorker.getRegistrations()
    } catch {
      return // a browser blocking site data: nothing to do about it from here
    }

    if (registrations.length === 0 || !navigator.serviceWorker.controller) {
      await restoreWorker()
    }
  }, WORKER_CHECK_MS)
}

/**
 * Re-register, then show the site again.
 *
 * Reloading the frame matters as much as re-registering: whatever it is showing
 * was fetched while nothing was serving, so it is the host's 404 rather than
 * the site, and it will not correct itself.
 */
async function restoreWorker () {
  if (restoringWorker || !current) return

  // Not while something is being published. The last step of putting a worker
  // back is unregistering it and reloading the page, and a reload in the middle
  // of hashing and seeding loses the publication — for a site that is, by
  // definition, on screen and therefore already being served.
  if (publishing) return

  restoringWorker = true

  ui.notice.textContent =
    'This browser dropped Spore\u2019s service worker, which is what serves sites ' +
    'from the swarm. Putting it back\u2026'
  ui.notice.className = 'notice'
  ui.notice.hidden = false

  try {
    await startWorker()

    // Re-open rather than just re-point the frame: the torrent is already in
    // the client, so this costs nothing and goes through the same path as a
    // first open, including the check that there is a controller at all.
    const ref = current.ref
    current = null
    ui.notice.hidden = true
    await route()
    console.warn('Spore: the service worker was dropped and has been restored for', ref)
  } catch (err) {
    ui.notice.textContent =
      'This browser dropped Spore\u2019s service worker and will not register it ' +
      `again (${err.message}). Sites cannot be displayed until it does. ` +
      'Reloading the page usually fixes it.'
    ui.notice.className = 'notice notice--error'
    ui.notice.hidden = false
  } finally {
    restoringWorker = false
  }
}

/**
 * The viewer never left `about:blank`.
 *
 * Nothing else notices this — the torrent is complete, the worker is running,
 * every indicator reads healthy, and the reader is looking at an empty frame
 * with nothing in the console. It was reported exactly that way. Say it out
 * loud, and put the whole diagnostic picture where a reader will copy it from.
 */
async function warnViewerStuck () {
  // The message goes up first: collecting diagnostics probes the network and
  // takes seconds, and the reader is already staring at an empty rectangle.
  ui.notice.textContent =
    'The site downloaded but the viewer stayed blank. Open Diagnostics in the ' +
    'status bar — the "Viewer response" line says what the service worker ' +
    'returned for it. The full picture is in the browser console too.'
  ui.notice.className = 'notice notice--error'
  ui.notice.hidden = false

  console.warn('Spore: the viewer never navigated. Full diagnostics follow.')
  try {
    console.table(await collectDiagnostics())
  } catch (err) {
    console.warn('Spore: diagnostics could not be collected:', err)
  }
}

const SCRIPTS_WARNING = `Run this site's scripts?

Spore has to serve sites from its own origin — a service worker cannot reach a
sandboxed frame — so a site with scripts enabled can also tamper with Spore's
own address bar and controls. It still cannot reach the network outside its
torrent, and this does not apply to any other site.

Only enable this for a site you trust.`

/**
 * Flipping the switch reloads the site: the policy travels on response headers,
 * so the document has to be fetched again to be governed by the new one.
 * Reloading also discards whatever the previous, script-less document did.
 */
async function onScriptsToggle () {
  if (!current) return
  if (sandboxWorks() === false) {
    ui.scripts.checked = false
    return
  }
  const { torrent } = current

  // Granting scripts is the one decision in the gate that gives something up,
  // so it is the one that asks. Turning them back off never does.
  if (ui.scripts.checked && !confirm(SCRIPTS_WARNING)) {
    ui.scripts.checked = false
    return
  }

  setScriptsAllowed(torrent.infoHash, ui.scripts.checked)

  const entry = findEntry(torrent)
  const shown = await ui.viewer.show(entryURL(torrent.infoHash, entry), { scripts: ui.scripts.checked })
  if (!shown) warnViewerStuck()
}

/* -------------------------------------------------------------------------- */
/* Keeping sites on this device                                                */
/* -------------------------------------------------------------------------- */

/**
 * The other decision that gives something up, so it asks too. Turning it off
 * deletes the data and never asks — undoing a choice should not be a negotiation.
 */
async function onKeepToggle () {
  if (!current) return
  const { torrent } = current

  if (!ui.keep.checked) {
    await forget(torrent.infoHash)
    await refreshKeptList()
    return
  }

  if (!confirm(KEEP_WARNING)) {
    ui.keep.checked = false
    return
  }

  ui.keep.disabled = true
  try {
    await keep(torrent, (done, total) => {
      ui.progress.textContent = `keeping ${Math.round((done / total) * 100)}%`
    })
    await refreshKeptList()
  } catch (err) {
    ui.keep.checked = false
    fail(err)
  } finally {
    ui.keep.disabled = false
  }
}

/** Whether this browser will let us store anything at all. */
async function storageWorks () {
  try {
    await openDatabase()
    return true
  } catch {
    return false
  }
}

async function restoreKept () {
  try {
    const { failed } = await restoreAll(getClient())
    if (failed.length > 0) {
      console.warn(`Spore: ${failed.length} kept site(s) could not be restored:`, failed)
    }
  } catch (err) {
    // Storage can be unavailable outright (private mode, blocked cookies).
    // That costs the reader the kept sites, not the gate.
    console.warn('Spore: offline storage is unavailable.', err)
  }
  await refreshKeptList()
}

async function refreshKeptList () {
  let sites
  try {
    sites = await keptSites()
  } catch {
    return
  }

  keptHashes = new Set(sites.map(site => site.infoHash))
  ui.kept.hidden = sites.length === 0
  ui.keptList.replaceChildren(...sites.map(renderKeptSite))
  if (!ui.welcome.hidden) showSeedingCount()

  const { usage: used, quota } = await usage()
  ui.keptUsage.textContent = quota
    ? `${formatBytes(used)} used of roughly ${formatBytes(quota)} this browser allows.`
    : ''
}

function renderKeptSite (site) {
  const item = document.createElement('li')

  const link = document.createElement('a')
  // The magnet it was kept with, not a bare infohash rebuilt from the hash: an
  // infohash on its own names the content and says nothing about where to ask
  // for it, so it opens here — where the bytes are already on disk — and is
  // useless to anyone else.
  link.href = `#${site.magnetURI ?? magnetFor(site.infoHash, site.name)}`
  link.textContent = site.name || site.infoHash
  item.append(link)

  const size = document.createElement('span')
  size.className = 'muted'
  size.textContent = formatBytes(site.length)
  item.append(size)

  const drop = document.createElement('button')
  drop.type = 'button'
  drop.textContent = 'Forget'
  drop.addEventListener('click', async () => {
    await forget(site.infoHash)
    if (current?.torrent.infoHash === site.infoHash) ui.keep.checked = false
    await refreshKeptList()
  })
  item.append(drop)

  return item
}

/* -------------------------------------------------------------------------- */

/**
 * Show what is in a torrent that is not a website.
 *
 * Plenty of torrents are archives, albums, datasets — no `index.html`, and
 * nothing wrong with them. Rejecting those made Spore useless for a whole
 * category of content whose files it can serve perfectly well, so it lists
 * them instead and lets the reader open one.
 *
 * Each file opens in the same sandboxed viewer a site would, under the same
 * policy, so a video plays and a text file renders without the torrent gaining
 * anything a site would not have.
 */
function showListing (torrent) {
  const files = [...torrent.files].sort((a, b) => a.path.localeCompare(b.path))

  ui.listingName.textContent = torrent.name ?? torrent.infoHash
  ui.listingSummary.textContent =
    `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(torrent.length)}`
  ui.listingFiles.replaceChildren(...files.map(file => listedFile(torrent, file)))

  ui.listing.hidden = false
  ui.notice.hidden = true
  ui.welcome.hidden = true
  ui.error.hidden = true
  ui.viewer.clear()

  ui.scripts.disabled = true
  ui.scriptsLabel.hidden = true
  // Asked rather than assumed. This used to run only on a fresh open, where
  // "not kept" was true by construction; it is now also how the stage is put
  // back after a publish is refused, and a reader who had kept the listing
  // watched the tick disappear while the site stayed on disk.
  isKept(torrent.infoHash).then(kept => {
    if (current?.torrent === torrent) ui.keep.checked = kept
  }).catch(() => {})
  ui.keepLabel.hidden = false
  ui.keep.disabled = false
  ui.saveTorrent.hidden = false
  ui.shareOpen.hidden = false
  ui.status.textContent = torrent.name ?? torrent.infoHash

  watchStats(torrent)
}

function listedFile (torrent, file) {
  const path = file.path.replace(/\\/g, '/')

  const name = document.createElement('span')
  name.className = 'path'
  name.textContent = path

  const size = document.createElement('span')
  size.className = 'size'
  size.textContent = formatBytes(file.length)

  const open = document.createElement('button')
  open.type = 'button'
  open.append(name, size)
  // Never with scripts: nothing here has been opted in, and a file picked out
  // of a listing has had even less scrutiny than a site someone linked to.
  open.addEventListener('click', () => {
    ui.listing.hidden = true
    ui.viewer.show(entryURL(torrent.infoHash, path), { scripts: false })
  })

  const item = document.createElement('li')
  item.append(open)
  return item
}

/**
 * Hand the .torrent to something that can seed it around the clock.
 *
 * A browser stops seeding when its tab closes, so a site that should stay up
 * needs a seeder outside the browser (tools/seed.mjs is one). Re-creating the
 * torrent from the same folder does not reliably reproduce the same infohash,
 * and a different infohash is a different site with a different link — so the
 * exact torrent has to travel, not just the files.
 */
function onSaveTorrent () {
  if (!current) return
  const { torrent } = current

  const blob = new Blob([torrent.torrentFile], { type: 'application/x-bittorrent' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${torrent.name ?? torrent.infoHash}.torrent`
  link.click()
  URL.revokeObjectURL(url)
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

async function showDiagnostics () {
  ui.diagnosticsBody.replaceChildren()
  ui.diagnostics.showModal()

  for (const row of await collectDiagnostics()) {
    const term = document.createElement('dt')
    term.textContent = row.label
    const value = document.createElement('dd')
    value.textContent = row.value
    if (row.ok === true) value.className = 'good'
    if (row.ok === false) value.className = 'bad'
    ui.diagnosticsBody.append(term, value)
  }
}

async function onReset () {
  if (!confirm(
    'Reset Spore in this browser?\n\n' +
    "This unregisters Spore's service worker and deletes everything it has " +
    'stored here, including any sites kept offline. Nothing outside Spore is ' +
    'touched. The page will reload.')) return

  ui.diagnosticsReset.disabled = true
  const problems = await resetBrowserState()
  if (problems.length > 0) console.warn('Spore: reset left some state behind:', problems)
  location.reload()
}

/**
 * Shared by the address bar and the landing page's own field: the same action,
 * offered where a reader already is rather than only in the chrome.
 */
function onAddressSubmit (event) {
  event.preventDefault()
  const field = event.target === ui.visitForm ? ui.visit : ui.address
  const value = field.value.trim()
  if (value) navigate(value)
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

/** Does this drag carry files, as opposed to selected text or a link? */
function draggingFiles (event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}

/**
 * Publishing by drag and drop, handled across the whole window.
 *
 * Listening only on the dashed box was a bug worth naming: a folder dropped
 * anywhere else — which is most of the page — fell through to the browser,
 * which navigated away from Spore to open the file. From the reader's side
 * that is indistinguishable from "drag and drop does not work".
 *
 * So the window cancels every file drag it sees. Nothing is ever handed to the
 * browser's default handler, wherever it lands.
 */
function wireDropTarget () {
  // dragenter/dragleave fire for every element the pointer crosses, so count
  // depth rather than trusting a single leave to mean the drag is over.
  let depth = 0
  const highlight = on => {
    document.body.classList.toggle('is-dragging', on)
    ui.dropzone.classList.toggle('is-active', on)
  }

  window.addEventListener('dragenter', event => {
    if (!draggingFiles(event)) return
    event.preventDefault()
    depth++
    highlight(true)
  })

  window.addEventListener('dragover', event => {
    if (!draggingFiles(event)) return
    event.preventDefault() // without this the drop never fires at all
    event.dataTransfer.dropEffect = 'copy'
  })

  window.addEventListener('dragleave', event => {
    if (!draggingFiles(event)) return
    if (--depth <= 0) { depth = 0; highlight(false) }
  })

  window.addEventListener('drop', async event => {
    if (!draggingFiles(event)) return
    event.preventDefault()
    depth = 0
    highlight(false)

    // A dropped archive is unpacked here, and unpacking can refuse: corrupt,
    // encrypted, over a cap. Without this the rejection was unhandled and the
    // page simply did nothing, which is the worst of the available answers.
    try {
      const { files, name } = await filesFromDrop(event.dataTransfer)
      await seed(files, name)
    } catch (err) {
      failToPublish(err)
    }
  })

  ui.folder.addEventListener('change', async () => {
    const picked = [...ui.folder.files]
    ui.folder.value = '' // let the same folder be picked twice
    if (picked.length === 0) return

    // This one unpacks archives too, since `webkitdirectory` degrades to a file
    // picker where directories cannot be chosen — and on that device this is
    // the first button. Silence through inflating and checking a hundred
    // megabytes is the failure the other picker was fixed for.
    busy(picked.length === 1 && /\.zip$/i.test(picked[0].name)
      ? `Opening ${picked[0].name}…`
      : 'Reading…')
    // Awaited and caught like the other two. This one was left bare, and
    // `verifiesAsItStands` now lets a read error through on purpose, so a file
    // that became unreadable between being picked and being hashed made the
    // page do nothing at all — the exact failure the other two were fixed for.
    try {
      const { files, name } = await filesFromInput({ files: picked })
      await seed(files, name)
    } catch (err) {
      failToPublish(err)
    }
  })

  ui.filesInput.addEventListener('change', async () => {
    const picked = [...ui.filesInput.files]
    ui.filesInput.value = ''
    if (picked.length === 0) return

    // Unpacking happens before `seed`, and can fail on its own terms — a
    // damaged or refused archive is not a publishing error, it is an answer
    // about this file, and it should read as one.
    busy(picked.length === 1 && /\.zip$/i.test(picked[0].name)
      ? `Opening ${picked[0].name}…`
      : 'Reading…')
    try {
      const { files, name } = await filesFromPicker(picked)
      await seed(files, name)
    } catch (err) {
      failToPublish(err)
    }
  })
}

async function seed (files, name) {
  if (!ready) {
    return failToPublish(new Error('Spore is still starting up. Try that again in a moment.'))
  }

  // One at a time. Drops are wired to the whole window and an open `<dialog>`
  // does not make it inert, so a folder dropped on top of the signing question
  // started a second publish — which called `showModal()` on a dialog that was
  // already open, threw, and left the first publish waiting on a promise that
  // could never settle. Both publishes also shared the dialog's buttons, so the
  // answers could cross.
  if (publishing) {
    // The notice bar, not the error page: there is a dialog open, and replacing
    // the page underneath it would be answering a transient collision by
    // destroying what the person is in the middle of.
    // The stage first: the picker calls `busy()` before it gets here, which
    // hides the landing page, the listing and the error page alike. Saying "one
    // is already on its way" over a blank screen is not an improvement on
    // saying nothing.
    restoreStage()
    ui.notice.textContent =
      'One publication is already on its way. Finish or cancel that one first.'
    ui.notice.className = 'notice notice--error'
    ui.notice.hidden = false
    return
  }
  publishing = true
  try {
    await publishOne(files, name)
  } finally {
    publishing = false
  }
}

/** Whether a publication is between its first question and its magnet. */
let publishing = false

async function publishOne (files, name) {

  try {
    checkPublishable(files)
  } catch (err) {
    return failToPublish(err)
  }

  // Whatever an operating system left in the folder goes first, and goes here
  // rather than inside the torrent library, so that the files being signed and
  // the files being seeded are the same files.
  const cleaned = dropJunk(files)
  files = cleaned.files

  // Asked again, because the set just changed. A folder holding nothing but a
  // .DS_Store passed the check above and arrived at "Hashing 0 files…" with an
  // empty dialog on the way, which is the late failure the early check exists
  // to prevent.
  if (files.length === 0) {
    return failToPublish(new Error(
      `There is nothing to publish: ${cleaned.dropped.join(', ')} ` +
      `${cleaned.dropped.length === 1 ? 'is a file' : 'are files'} an operating ` +
      'system writes into a folder, and there is nothing else here.'))
  }

  // One page picked on a phone becomes the site, because that is what the
  // person meant.
  const site = asSite(files)
  files = site.files
  name = name ?? site.name

  const entry = entryFor(files)

  // Not a refusal. Files with no `index.html` in their root publish perfectly
  // well and render as a browsable list, which is occasionally the point — but
  // it is rarely what somebody means by "my site", and this is the last moment
  // before a magnet exists.

  // Two outcomes for a publication that arrives already signed, and no third.
  // Either it verifies exactly as it stands — in which case it is republished
  // untouched and stays its author's, which is what a mirror is — or its key
  // and signature are thrown away and the publisher signs their own. Anything
  // in between produces a site that accuses itself of having been altered.

  // Said out loud, because this reads and hashes every file: republishing a
  // large folder sat on an idle landing page for as long as it took, with
  // nothing to show the click had done anything. Every other slow step here
  // announces itself.
  if (entry) busy('Checking the signature it came with…')
  const mirror = entry ? await verifiesAsItStands(files) : false
  if (entry && !mirror) ui.notice.hidden = true

  const hadKey = !mirror && files.some(file => pathOf(file) === 'spore.pub')
  if (!mirror) files = stripSignature(files)

  // Asked after the signature has gone, so the list of what readers will browse
  // does not name two files that are not going to be published — directly above
  // a paragraph explaining that this goes out unsigned.
  if (!entry && !await askAboutMissingEntry(files)) {
    backOut()
    return
  }

  // A manifest is one line per file, and a reader refuses one too large to be
  // a manifest — it is reading a stranger's torrent. A site with thousands of
  // files can make one, so the question is not asked where the answer could
  // only produce a signature nobody will open.
  // Counting the key file too, because signing adds one and the check that
  // fits without it may not fit with it.
  const tooBigToSign = manifestWouldExceed(
    [...files.map(pathOf), 'spore.pub', SIGNATURE_FILE])

  const decision = entry && !mirror && !tooBigToSign
    ? await askAboutSigning(name)
    : { sign: false, site: null }

  if (!decision) {
    backOut()
    return
  }

  busy(`Hashing ${files.length} file${files.length === 1 ? '' : 's'}…`)
  try {
    const signed = decision.sign
      ? await signContent(withSporePub(files, decision.site), decision.site)
      : files

    const torrent = await publish(signed, name)
    const magnet = magnetFor(torrent.infoHash, torrent.name)
    showShareLink(magnet)
    noteWhatChanged({
      renamed: site.renamed,
      mirror,
      dropped: cleaned.dropped,
      discarded: hadKey && !decision.sign,
      replaced: hadKey && decision.sign,
      tooBigToSign: tooBigToSign && Boolean(entry)
    })

    // Announced before navigating: navigating replaces the site on screen, and
    // this has to happen whether or not the reader stays to watch it.
    const successor = decision.sign ? await announceSuccessor(torrent, decision.site) : null

    navigate(magnet)
    if (successor) showSuccessorNote(successor)
  } catch (err) {
    failToPublish(err)
  }
}

/**
 * Does this publication already verify, exactly as it arrived?
 *
 * Asked with the reader's own functions, deliberately. Every serious defect on
 * this branch came from the publisher and the reader answering one question
 * with two pieces of code; this is the same question, and there is one answer
 * because there is one implementation.
 */
async function verifiesAsItStands (files) {
  const at = path => files.find(file => pathOf(file) === path)

  const pub = at('spore.pub')
  const sig = at(SIGNATURE_FILE)
  if (!pub || !sig) return false

  // The reader's own limits, because this is the reader's own question. Without
  // them a publication with an oversized key or manifest verified here and was
  // republished untouched, while every reader — applying the limits — showed it
  // as unsigned. One question answered twice, which is the whole family of
  // defect this branch exists to remove.
  if (pub.size > MAX_KEY_BYTES || sig.size > MAX_MANIFEST_BYTES) return false

  let manifest
  try {
    const key = parseSporePub(await pub.text())
    const result = await verifyManifest(await sig.text(), key.hex)
    if (!result.ok) return false
    manifest = result.manifest
  } catch {
    // Unreadable or malformed: this publication declares nothing usable, which
    // is exactly how a reader treats it.
    return false
  }

  const present = files.map(pathOf)

  if (missingFrom(manifest, present).length > 0) return false
  if (unlistedIn(manifest, present).length > 0) return false

  // Deliberately outside the `try`. A file that cannot be *read* is not a
  // signature that failed, and swallowing it here threw away a real author's
  // key and told the publisher their site "arrived without a signature that
  // stands up" — which would be a lie about somebody else's work. Let it
  // propagate: a publish that cannot read its own files is not going to
  // succeed a moment later either.
  for (const file of files) {
    const path = pathOf(file)
    if (path === SIGNATURE_FILE) continue
    if (!(await checkFile(manifest, path, file)).ok) return false
  }
  return true
}

/**
 * Say what the gate did to the files, beside the share link where it survives.
 *
 * Renaming a page and republishing somebody else's signature are both things
 * the publisher did not ask for and would be entitled to be surprised by, and
 * the notice bar is not the place: `busy()` overwrites it and rendering the
 * site clears it, so a sentence put there appears and vanishes.
 */
function noteWhatChanged ({
  renamed, mirror, dropped, discarded, replaced, tooBigToSign
}) {
  const said = []

  if (renamed) {
    said.push(`${renamed.from} was published as index.html, so that it opens ` +
      'as the site rather than as a list with one file in it.')
  }
  if (dropped.length > 0) {
    said.push(`${dropped.join(', ')} ${dropped.length === 1 ? 'was' : 'were'} left ` +
      'out: files an operating system writes into a folder, which are not part ' +
      'of the site and cannot be signed as if they were.')
  }
  if (mirror) {
    // Deliberately not "byte for byte": the files are untouched, but a
    // torrent's name is part of its infohash and does not survive being picked
    // out of one swarm and handed back through a file picker.
    said.push('This was already signed, and it still verifies, so its files ' +
      'went out untouched \u2014 still its author\u2019s, not yours.')
  }
  if (replaced) {
    said.push('It arrived declaring somebody else\u2019s key, without a signature ' +
      'that stands up to checking, so that key was replaced by yours. It is ' +
      'published as your work, not theirs.')
  }
  if (discarded) {
    said.push('It arrived declaring a key, without a signature that stands up ' +
      'to checking, so the key was left out rather than published as a claim ' +
      'nobody can verify.')
  }

  if (tooBigToSign) {
    said.push('It has too many files to sign: the list of hashes would be ' +
      'larger than a reader will open, so a signature would have gone out that ' +
      'nobody could check. It is published unsigned instead.')
  }


  ui.shareUnsigned.textContent = said.join(' ')
  ui.shareUnsigned.hidden = said.length === 0
}


/**
 * Put the signed-in key in the site's root, so the site names its own author.
 *
 * Nothing is left in place here. Anything the incoming files called `spore.pub`
 * has already been thrown away by `stripSignature` unless it was part of a
 * publication that verified as it stood, and a publication that verified was
 * never handed to this function. So there is one key, it is this tab's, and it
 * sits where every reader looks.
 */
function withSporePub (files, site) {
  const identity = me()
  if (!identity) return files

  const contents = formatSporePub(identity.hex, publicNameFor(identity.hex), site)
  const file = new File([contents], 'spore.pub', { type: 'text/plain' })
  file.fullPath = 'spore.pub'
  return [...files, file]
}

/**
 * Throw away a signature that is not going to be honoured.
 *
 * A signature belongs to a set of bytes, and these are about to stop being
 * those bytes. Keeping somebody else's `spore.pub` while signing with this
 * tab's key produces a site that reads as **altered** to every reader, and
 * keeping a `spore.sig` that no longer matches produces the same thing. There
 * are two outcomes for republishing and this is the second one: either a
 * publication verifies exactly as it stands and is not touched at all, or its
 * key and its signature go and the publisher's own take their place.
 */
function stripSignature (files) {
  return files.filter(file =>
    pathOf(file) !== 'spore.pub' && pathOf(file) !== SIGNATURE_FILE)
}

/**
 * Sign every file, so that declaring a key stops being free.
 *
 * `spore.pub` alone proves nothing: anyone can copy someone else's public key
 * into a folder of their own text and publish it, and a reader checking the
 * fingerprint against the real person's would get a match. `spore.sig` lists
 * every other file with the hash of its bytes and signs the list, so the claim
 * becomes checkable offline, from the torrent alone, on a first read.
 *
 * Paths are relative to the site root, not to the torrent, because the
 * torrent's name is metadata: renaming a site should not invalidate what its
 * author signed.
 */
async function signContent (files, site) {
  const identity = me()
  if (!identity) return files

  const described = []
  for (const file of files) {
    const path = pathOf(file)
    if (path === SIGNATURE_FILE) continue
    // The File, not its bytes. `manifestEntries` reads one at a time and lets
    // each go; reading them here held the whole site at once, which a site
    // containing a film cannot survive — and which is precisely the ceiling
    // this branch removed from the archive reader.
    described.push({ path, bytes: file })
  }

  const contents = await signManifest(identity.privateKey, {
    key: identity.hex, site: site ?? null, entries: await manifestEntries(described)
  })

  const signature = new File([contents], SIGNATURE_FILE, { type: 'text/plain' })
  signature.fullPath = SIGNATURE_FILE

  // The old one goes. Appending beside it put two files at one path, which is
  // refused — so a site that had ever been signed could not be published again
  // at all, and that is exactly the folder somebody re-publishes: the one they
  // downloaded, or the one a seeder wrote its version of. A signature describes
  // a set of bytes, and these are not those bytes.
  return [...files.filter(file => pathOf(file) !== signature.fullPath), signature]
}

/**
 * Sign a successor to whatever was last published under this key, and start
 * offering it to the old version's swarm.
 *
 * This is the only way a reader ever hears about a new version, and it is worth
 * being plain about its limit: the offer travels from peers who hold it, so it
 * reaches people only while this tab, or some other holder, is in the old
 * swarm. Publishing an update and closing the tab tells nobody. A server-side
 * seeder holding the old version is what makes it durable, and putting the same
 * record in the DHT — which needs UDP, which a browser has none of — is what
 * makes it reach clients that never heard of Spore.
 *
 * @returns {Promise<{seq: number, reaching: boolean}|null>}
 */
async function announceSuccessor (torrent, site) {
  const identity = me()
  if (!identity) return null

  const previous = lastPublished(identity.hex, site)
  const seq = nextSeq()

  recordPublished(identity.hex, { site, seq, infoHash: torrent.infoHash, name: torrent.name })

  // A first version of a site has no predecessor to announce to. It is still
  // recorded, so the next version knows which swarm to reach.
  if (!previous || previous.infoHash === torrent.infoHash) return null

  const record = await signUpdate(
    identity.privateKey, identity.publicKey, torrent.infoHash, seq, saltFor(site))

  // Put it where everything else offers from, rather than attaching a second
  // watcher of its own. Publishing and having been told are the same thing from
  // the swarm's point of view: you hold a record and you hand it out.
  knownRecords.set(`${identity.hex}/${site ?? ''}`, {
    infoHash: torrent.infoHash, seq, record
  })

  const old = getClient().torrents.find(t => t.infoHash === previous.infoHash)
  if (old) {
    watchTorrentForUpdates(old).announceKey({
      hex: identity.hex,
      publicKey: identity.publicKey,
      site,
      salt: saltFor(site)
    })
  }

  return { site, reaching: Boolean(old) }
}

function showSuccessorNote ({ site, reaching }) {
  // Beside the share link, not in the notice bar. Publishing navigates to the
  // new site, and rendering a site clears the notice — so the one message that
  // explains what just happened to the *old* site would vanish a second after
  // appearing.
  const named = site ? `“${site}”` : 'this site'
  ui.shareSuccessor.textContent = reaching
    ? `Signed as the new version of ${named}. Anyone who opens the previous ` +
      'version while this tab is open will be offered this one. Close the tab ' +
      'and nobody is told — a seeder holding the old version is what makes ' +
      'that durable.'
    : `Signed as the new version of ${named}, but the previous version is not ` +
      'open in this tab, so there is no swarm to announce it to. Open the old ' +
      'magnet here, or keep it offline, and publish again to reach its readers.'
  ui.shareSuccessor.hidden = false
}

/**
 * @param {string} magnet
 * @param {boolean} justPublished  false when the reader asked for the link of a
 *   site already on screen, which needs different words: nothing was published.
 */
function showShareLink (magnet, justPublished = true) {
  ui.shareSuccessor.hidden = true
  ui.shareUnsigned.hidden = true

  ui.shareIntro.innerHTML = justPublished
    ? '<strong>Published.</strong> Share this link — it works from any Spore mirror.'
    : '<strong>Share this site.</strong> The link works from any Spore mirror.'
  ui.shareNote.hidden = !justPublished

  const link = new URL(location.href)
  link.hash = magnet
  ui.shareLink.value = link.href
  ui.share.hidden = false
}

/**
 * Hand over a link to whatever is on screen.
 *
 * Until now the only way to get one was to publish something, so a site
 * reopened later — from a kept copy, or from anyone's magnet — could be read
 * and not passed on. Taken from `torrent.magnetURI` rather than rebuilt from
 * the infohash, because that carries the trackers the site was actually
 * published with and its display name. A bare infohash is not shareable: a
 * friend's gate has nowhere to ask.
 */
function onShare () {
  if (!current) return
  showShareLink(current.torrent.magnetURI, false)
  ui.shareLink.select()
}

async function onCopy () {
  try {
    await navigator.clipboard.writeText(ui.shareLink.value)
    ui.copy.textContent = 'Copied'
  } catch {
    ui.shareLink.select() // no clipboard permission: let the user copy it
    ui.copy.textContent = 'Press ⌘/Ctrl+C'
  }
  setTimeout(() => { ui.copy.textContent = 'Copy link' }, 2000)
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                      */
/* -------------------------------------------------------------------------- */

function showWelcome () {
  current = null
  stopStats()
  stopWatchingAuthor()
  ui.viewer.clear()
  ui.welcome.hidden = false
  ui.notice.hidden = true
  ui.error.hidden = true
  ui.listing.hidden = true
  ui.address.value = ''
  ui.visit.value = ''
  ui.scripts.disabled = true
  ui.scriptsLabel.hidden = true
  ui.keep.disabled = true
  ui.keepLabel.hidden = true
  ui.saveTorrent.hidden = true
  ui.shareOpen.hidden = true
  ui.status.textContent = 'Nothing open'
  showSeedingCount()
  ui.progress.textContent = ''
}

/**
 * Kept sites are seeded from the moment the gate opens, so say so when idle.
 * Counted off the client rather than off the stored list: a site whose pieces
 * failed to verify is kept but is not being seeded, and claiming otherwise
 * would be a lie about availability.
 */
function showSeedingCount () {
  const seeding = getClient().torrents.filter(t => keptHashes.has(t.infoHash) && t.done).length
  ui.peers.textContent = seeding > 0 ? `seeding ${seeding} kept site${seeding === 1 ? '' : 's'}` : ''
}

function busy (message) {
  ui.notice.textContent = message
  ui.notice.className = 'notice'
  ui.notice.hidden = false
  ui.welcome.hidden = true
  ui.error.hidden = true
  ui.listing.hidden = true
}

/**
 * Something went wrong opening a site — show a page about it, not a red line.
 *
 * A site nobody is seeding is by far the commonest of these, and it is not a
 * malfunction: it is the swarm equivalent of a URL that no longer resolves. It
 * gets what a web server would give it, a 404 page that says what happened and
 * offers somewhere to go next.
 */
function fail (error) {
  current = null
  stopStats()
  ui.viewer.clear()

  const { code, title, detail, retry } = describe(error)
  ui.errorCode.textContent = code
  ui.errorTitle.textContent = title
  ui.errorDetail.textContent = detail
  ui.errorRef.textContent = currentRef() || ''
  ui.errorRef.parentElement.hidden = !currentRef()
  ui.errorRetry.hidden = !retry

  ui.error.hidden = false
  ui.notice.hidden = true
  ui.welcome.hidden = true
  ui.listing.hidden = true
  ui.scripts.disabled = true
  ui.scriptsLabel.hidden = true
  ui.keep.disabled = true
  ui.keepLabel.hidden = true
  ui.status.textContent = title
  ui.peers.textContent = ''
  ui.progress.textContent = ''
}

/** Turn a failure into something worth reading. */
function describe (error) {
  if (error instanceof SiteNotFound) {
    // Many public magnets carry an HTTP fallback. Spore declines it, and a
    // reader deserves to know that rather than conclude the gate is broken.
    const hosts = webSeedHosts(currentRef())
    const fallback = hosts.length === 0
      ? ''
      : ` This magnet also offers an HTTP copy at ${hosts.join(', ')}, which ` +
        'Spore does not use: fetching it would tell that host your address and ' +
        'what you are asking for, which is the thing Spore exists to avoid.'

    return {
      code: '404',
      title: 'This site could not be found',
      detail:
        'No peer answered for it. A site exists only while somebody is seeding ' +
        'it: the tab that published it has to stay open, and so does at least ' +
        'one tab that has it open. If everyone has closed theirs, the site is ' +
        'dormant until someone with a copy opens it again — the bytes are not ' +
        'lost, there is just nobody holding them right now.' + fallback,
      retry: true
    }
  }
  if (error instanceof InvalidSiteRef) {
    return {
      code: '???',
      title: 'That is not a site address',
      detail: error.message + ' A site address is a magnet link, or the 40-character ' +
        'infohash inside one.',
      retry: false
    }
  }
  if (error instanceof PublishFailed) {
    return {
      code: ':(',
      title: 'That could not be published',
      detail: error.message,
      retry: false
    }
  }
  return {
    code: ':(',
    title: 'This site could not be opened',
    detail: error instanceof Error ? error.message : String(error),
    retry: true
  }
}

/**
 * A failure that happened on the way out rather than on the way in.
 *
 * Publishing and reading share an error page, and it used to say "this site
 * could not be opened" over a refused archive — telling somebody who had just
 * dropped a file that a site they never asked for had failed to load.
 */
class PublishFailed extends Error {
  constructor (cause) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'PublishFailed'
  }
}

function watchStats (torrent) {
  stopStats()
  const tick = () => {
    ui.peers.textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`
    ui.progress.textContent = torrent.done
      ? `${formatBytes(torrent.length)} · seeding`
      : `${Math.round(torrent.progress * 100)}% of ${formatBytes(torrent.length)}`
  }
  tick()
  statsTimer = setInterval(tick, 1000)
}

function stopStats () {
  clearInterval(statsTimer)
  statsTimer = null
}

function formatBytes (bytes) {
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
