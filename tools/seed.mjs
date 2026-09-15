#!/usr/bin/env node
/**
 * Seed a Spore site from a server — every version of it, not just the newest.
 *
 * A browser peer can only talk to other WebRTC peers, so an ordinary
 * BitTorrent client — transmission, rtorrent, a NAS — cannot serve a Spore
 * site no matter how correctly it seeds the same infohash. It has to be a
 * WebRTC-speaking seeder, which in practice means Node with a WebRTC
 * implementation attached. That is one line: WebTorrent picks up
 * `globalThis.WRTC` and hands it to the tracker client.
 *
 *   npm install webtorrent node-datachannel
 *
 * ## Why every version
 *
 * Content is the address, so editing a site mints a new magnet and the old one
 * keeps serving the old bytes. A signed successor is what carries readers
 * across — but it travels between peers, and only a peer holding the *old*
 * version can hand it to someone still reading that version. A seeder that
 * drops the previous version the moment it publishes a new one has nobody left
 * to tell.
 *
 * So each version is frozen into `<data>/versions/<seq>/` and seeded from
 * there for as long as it is kept. That also makes each magnet permanent by
 * construction: the bytes behind it never change again, whatever happens to
 * the live folder.
 *
 * ## Configuration
 *
 * Everything comes from the environment, so a compose file needs no arguments
 * and secrets stay out of the command line — where they would be visible to
 * `docker inspect`, `ps`, and the shell history of whoever typed them.
 * Command-line flags still override, for one-off runs.
 *
 *   SPORE_SITE_NAME   what the site is called. Part of the infohash: change it
 *                     and it is a different site. Defaults to the folder name,
 *                     which under Docker is the mount point — so set it.
 *   SPORE_SITE        which of your sites this is: the series name, and the
 *                     BEP 44 salt. Defaults to SPORE_SITE_NAME.
 *   SPORE_NAME        the name your key claims for itself, shown to readers.
 *   SPORE_PASSPHRASE  your signing passphrase. Without it the site is
 *                     published unsigned and can never be updated.
 *   SPORE_CONTENT     folder to serve            (default /site)
 *   SPORE_DATA        where versions are kept    (default /data)
 *   SPORE_STATUS_PORT health endpoint            (default 8081, 0 disables)
 *   SPORE_WATCH_SECONDS  how often to look for edits (default 30, 0 disables)
 *   SPORE_KEEP_VERSIONS  how many to keep seeding  (default 10)
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { chown, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

import { DEFAULT_TRACKERS } from '../js/config.js'
import { formatSporePub, identityFromPassphrase, fingerprint, saltFor, normalizeSite }
  from '../js/identity.js'
import { signUpdate } from '../js/record.js'
import {
  SIGNATURE_FILE, manifestEntries, signManifest, skippedWhenWalking
} from '../js/manifest.js'
import { watchForUpdates } from '../js/updates.js'

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(name)
  return at === -1 ? null : argv[at + 1]
}
const setting = (name, fallback) =>
  flag(`--${name.toLowerCase().replace(/^spore_/, '').replace(/_/g, '-')}`) ??
  (process.env[name] || null) ??
  fallback

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Seed a Spore site, and every version of it, from this machine.

Configured by environment (see deploy/seeder/.env.example); flags override:

  --content <dir>     folder to serve            (SPORE_CONTENT, /site)
  --data <dir>        where versions are kept    (SPORE_DATA, /data)
  --site-name <name>  what the site is called    (SPORE_SITE_NAME)
  --site <name>       which of your sites it is  (SPORE_SITE)
  --name <name>       the name readers see       (SPORE_NAME)
  --status-port <n>   health endpoint            (SPORE_STATUS_PORT, 8081)
  --watch-seconds <n> how often to look for edits (SPORE_WATCH_SECONDS, 30)
  --keep-versions <n> how many to keep seeding   (SPORE_KEEP_VERSIONS, 10)

The passphrase is read from SPORE_PASSPHRASE only, never from a flag: an
argument is visible in \`docker inspect\`, \`ps\`, and shell history.

Needs: npm install webtorrent node-datachannel`)
  process.exit(0)
}

const contentPath = resolve(setting('SPORE_CONTENT', '/site'))
const dataPath = resolve(setting('SPORE_DATA', '/data'))
const siteName = setting('SPORE_SITE_NAME', basename(contentPath))
const claimedName = setting('SPORE_NAME', null)
const statusPort = Number(setting('SPORE_STATUS_PORT', '8081'))
const watchSeconds = Number(setting('SPORE_WATCH_SECONDS', '30'))
const keepVersions = Math.max(1, Number(setting('SPORE_KEEP_VERSIONS', '10')))
const announceSeconds = Math.max(15, Number(setting('SPORE_ANNOUNCE_SECONDS', '60')))

// Never a flag. An argument shows up in `docker inspect`, in `ps` output, and
// in the shell history of whoever started it; an environment variable at least
// stays in the process and the file that set it.
const passphrase = process.env.SPORE_PASSPHRASE || null

let series
try {
  series = normalizeSite(setting('SPORE_SITE', siteName))
} catch (err) {
  console.error(`SPORE_SITE: ${err.message}`)
  process.exit(2)
}

const versionsPath = join(dataPath, 'versions')
const statePath = join(dataPath, 'versions.json')

if (!existsSync(contentPath)) {
  console.error(`Nothing at ${contentPath}. Set SPORE_CONTENT, or mount a folder there.`)
  process.exit(1)
}

// Checked up front, with an explanation. Every version is a copy written here,
// so a data directory this process cannot write to is fatal — and the failure
// it would otherwise produce is an EACCES stack trace several seconds later,
// from inside a copy, which says nothing about whose fault it is.
// Started as root under Docker so this can be sorted out without the operator
// being asked to. An earlier release ran as root and left /data owned by root;
// refusing to start and telling them to fix it by hand turned a permissions
// detail into a crash loop, and the fix suggested — deleting the directory —
// throws away the version history, which from 0.2.0 is the thing worth keeping.
//
// So: take ownership if we can, then drop. Nothing has touched the network or
// read a byte of content at this point.
const runAs = Number(setting('SPORE_UID', '1000'))
const runAsGroup = Number(setting('SPORE_GID', String(runAs)))

if (process.getuid?.() === 0) {
  try {
    await mkdir(dataPath, { recursive: true })
    await chownRecursive(dataPath, runAs, runAsGroup)
    process.setgid?.(runAsGroup)
    process.setuid?.(runAs)
  } catch (err) {
    console.error(`Could not drop from root to ${runAs}:${runAsGroup}: ${err.message}`)
    process.exit(1)
  }
}

try {
  // Both directories: `versions/` may already exist and be owned by somebody
  // else — an earlier run of this image as root is the obvious way — in which
  // case the parent is writable and the place that matters is not.
  for (const dir of [dataPath, versionsPath]) {
    await mkdir(dir, { recursive: true })
    const probe = join(dir, '.writable')
    await writeFile(probe, '')
    await rm(probe, { force: true })
  }
} catch (err) {
  console.error(
    `Cannot write to ${dataPath} as uid ${process.getuid?.() ?? '?'} ` +
    `(${err.code ?? err.message}).\n\n` +
    'Every version published is kept there, so this is fatal.\n\n' +
    'This normally fixes itself: started as root, the seeder takes ownership of\n' +
    'the directory and drops privileges. It cannot when the container is already\n' +
    'running as a non-root user, so either drop `user:` from the compose file and\n' +
    'let it sort itself out, or give the directory to that user:\n\n' +
    `  sudo chown -R ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} data/\n\n` +
    'Do not delete data/ to get past this. It holds every version you have\n' +
    'published, and losing it means readers on an older version can never be\n' +
    'told about a newer one.')
  process.exit(1)
}

/* -------------------------------------------------------------------------- */

let WebTorrent, wrtc
try {
  wrtc = await import('node-datachannel/polyfill')
  WebTorrent = (await import('webtorrent')).default
} catch (err) {
  console.error(
    `\nMissing dependencies. This tool is not part of the gate, so they are ` +
    `not installed by default:\n\n  npm install webtorrent node-datachannel\n\n${err.message}`)
  process.exit(1)
}

// Read by WebTorrent's constructor and passed to the tracker client, which is
// what lets this process answer a browser. Without it the seeder announces
// happily and no browser can ever reach it.
globalThis.WRTC = wrtc

const client = new WebTorrent()
client.on('error', err => {
  console.error('client error:', err.message)
  process.exit(1)
})

const announceList = DEFAULT_TRACKERS.map(tracker => [tracker])
const startedAt = Date.now()

/** @type {{publicKey: Uint8Array, privateKey: CryptoKey, hex: string}|null} */
let identity = null
if (passphrase) {
  process.stdout.write('Deriving your key… ')
  identity = await identityFromPassphrase(passphrase)
  console.log(`${await fingerprint(identity.publicKey)}${claimedName ? ` — “${claimedName}”` : ''}`)
} else {
  console.log(
    'No SPORE_PASSPHRASE, so this site is unsigned. It will be served, but it\n' +
    'can never be updated: readers have no key to check a successor against.')
}

/** @type {{seq: number, infoHash: string, dir: string, createdAt: number}[]} */
let versions = await loadState()
/** infoHash → torrent, for everything currently being seeded. */
const seeding = new Map()
/** Watchers offering the newest record on older swarms; held so they live. */
const announcing = []

// Declared with the rest of the module state, not beside the functions that
// use them: `startAnnouncing()` runs near the top of the file, and a `let`
// declared further down is in its temporal dead zone — a ReferenceError at
// startup rather than an undefined. The container caught it; reading did not.
/** When we last asked the trackers to introduce us, and when one last replied. */
let lastAnnounceAt = null
let lastTrackerReplyAt = null
let lastAnnounceError = null

await restoreVersions()
await checkForNewVersion({ firstRun: true })

if (versions.length === 0) {
  console.error('Nothing could be published. Is the folder empty?')
  process.exit(1)
}

report()
startStatusServer()
startHeartbeat()
startWatching()
startAnnouncing()

process.on('SIGINT', () => {
  console.log('\nStopping.')
  client.destroy(() => process.exit(0))
})

/* -------------------------------------------------------------------------- */
/* Versions                                                                   */
/* -------------------------------------------------------------------------- */

async function loadState () {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    return Array.isArray(state.versions) ? state.versions : []
  } catch {
    return [] // no state yet, or unreadable: this run starts the history
  }
}

async function saveState () {
  await mkdir(dataPath, { recursive: true })
  await writeFile(statePath, JSON.stringify({
    site: series, siteName, key: identity?.hex ?? null, versions
  }, null, 2) + '\n')
}

/** Re-seed everything this seeder published before, from its frozen copy. */
async function restoreVersions () {
  const alive = []
  for (const version of versions) {
    if (!existsSync(version.dir)) {
      console.error(`Version ${version.infoHash.slice(0, 8)} is in the state file but ` +
        `its files are gone (${version.dir}); dropping it.`)
      continue
    }
    const torrent = await seedFrom(version.dir)
    try {
      await verifyReadable(torrent)
    } catch (err) {
      console.error(`Version ${version.infoHash.slice(0, 8)} cannot be read from disk ` +
        `(${err.message}); dropping it.`)
      torrent.destroy()
      continue
    }
    if (torrent.infoHash !== version.infoHash) {
      // Content under a version directory is supposed to be frozen. If it is
      // not, this is no longer the version it claims to be, and seeding it
      // under the old magnet would serve different bytes at a verified address.
      console.error(`Version ${version.infoHash.slice(0, 8)} no longer hashes to itself ` +
        `(${version.dir} has been modified); dropping it.`)
      torrent.destroy()
      continue
    }
    seeding.set(torrent.infoHash, torrent)
    watchTrackerReplies(torrent)
    alive.push(version)
  }
  versions = alive
}

/**
 * Freeze the live folder as a new version, if it differs from the newest one.
 *
 * The copy is what gets seeded, never the folder itself. A magnet must keep
 * meaning the same bytes forever, and a folder somebody can edit cannot promise
 * that — the previous design re-hashed the live folder on every boot and handed
 * out a different magnet whenever anything had changed underneath it.
 */
async function checkForNewVersion ({ firstRun = false } = {}) {
  const seq = Date.now()
  const staging = join(versionsPath, String(seq))

  await mkdir(versionsPath, { recursive: true })
  await rm(staging, { recursive: true, force: true })

  // The directory is named after the site, and the torrent takes its name from
  // the directory. Overriding `name` instead looks equivalent and is not: the
  // torrent is built correctly, because create-torrent reads the real files
  // while hashing, but every read *after* that resolves to
  // `<parent>/<name>/…`, which does not exist. The seeder then reports itself
  // complete — the piece map is in memory — while serving nothing but ENOENT.
  // Peers fail the hash check and re-request forever, so upload climbs, the
  // logs look healthy, and the site never loads.
  await cp(contentPath, join(staging, siteName), { recursive: true })
  await declareIdentity(join(staging, siteName))
  await signContent(join(staging, siteName))

  const torrent = await seedFrom(staging)
  try {
    await verifyReadable(torrent)
  } catch (err) {
    // Refusing is the point. Announcing a torrent whose bytes cannot be read
    // is worse than publishing nothing: peers connect, fail, and retry.
    console.error(`Refusing to publish: the copy in ${staging} cannot be read ` +
      `back (${err.message}).`)
    torrent.destroy()
    await rm(staging, { recursive: true, force: true })
    return null
  }
  const newest = versions[versions.length - 1]

  if (newest && torrent.infoHash === newest.infoHash) {
    // Same bytes. Mtimes move for all sorts of reasons that are not edits.
    torrent.destroy()
    await rm(staging, { recursive: true, force: true })
    return null
  }

  if (seeding.has(torrent.infoHash)) {
    // Reverted to an older version. It is already being seeded, and re-adding
    // it would be a duplicate; the history is what it is.
    console.log(`The folder now matches version ${torrent.infoHash.slice(0, 8)}, ` +
      'which is already being seeded. Nothing new to publish.')
    torrent.destroy()
    await rm(staging, { recursive: true, force: true })
    return null
  }

  seeding.set(torrent.infoHash, torrent)
  watchTrackerReplies(torrent)
  versions.push({ seq, infoHash: torrent.infoHash, dir: staging, createdAt: seq })
  await saveState()

  if (!firstRun) {
    console.log(`\n${new Date().toISOString().slice(0, 19)}Z  the folder changed — ` +
      `published ${torrent.infoHash}`)
    console.log(`  ${magnetFor(torrent)}`)
  }

  await refreshOffers()
  await pruneOldVersions()
  return torrent
}

/**
 * Put the key in the folder, so the site names its own author.
 *
 * A folder that already carries a `spore.pub` is left exactly as it is: the
 * operator may be re-seeding somebody else's site, or deliberately shipping a
 * key other than this one, and overwriting it would change who the site says
 * it belongs to without saying so.
 */
async function declareIdentity (dir) {
  if (!identity) return
  const target = join(dir, 'spore.pub')
  if (existsSync(target)) return
  await writeFile(target, formatSporePub(identity.hex, claimedName, series))
}

/**
 * Sign every file in the site, so that declaring a key stops being free.
 *
 * Without this, anyone can copy a `spore.pub` into a folder of their own text
 * and publish: the site declares a real key, a reader checking the fingerprint
 * against the real person's gets a match, and nothing anywhere says otherwise.
 * They still cannot sign a successor, so they cannot move that person's
 * readers, but they can put words under their name.
 *
 * `spore.sig` closes it. It lists every other file with the SHA-256 of its
 * bytes and signs the list, so altering, adding or removing anything breaks
 * verification. Paths are relative to the site root rather than to the torrent,
 * because the torrent's name is metadata and renaming a site should not
 * invalidate its signature.
 */
async function signContent (dir) {
  if (!identity) return

  const files = []
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      // Exactly what create-torrent skips while walking this same directory:
      // every hidden entry and every name on the junk list, directories
      // included. It does this whether or not it is asked to — `filterJunkFiles`
      // only reaches a list of files, never a path — so hashing one of these
      // here put a file in the signature that was never in the torrent, and
      // every reader was told the site had been altered. Any directory that has
      // been opened in the Finder has a `.DS_Store` in it.
      if (skippedWhenWalking(entry.name)) continue

      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const path = relative(dir, full).split(sep).join('/')
        if (path === SIGNATURE_FILE) continue

        files.push({ path, bytes: new Uint8Array(await readFile(full)) })
      }
    }
  }
  await walk(dir)

  const entries = await manifestEntries(files)
  const contents = await signManifest(identity.privateKey, {
    key: identity.hex, site: series, entries
  })
  await writeFile(join(dir, SIGNATURE_FILE), contents)
}

/**
 * Offer the newest version to everyone still on an older one.
 *
 * This is the only reason old versions are kept. The record is a BEP 44 mutable
 * item — the same bytes a DHT-capable client would resolve through BEP 46 — and
 * it reaches a browser over the wire because a browser cannot speak UDP.
 */
async function refreshOffers () {
  if (!identity || versions.length < 2) return

  const newest = versions[versions.length - 1]
  const record = await signUpdate(
    identity.privateKey, identity.publicKey, newest.infoHash, newest.seq, saltFor(series))

  // Attachments are per wire and cannot be removed, so stale watchers on older
  // swarms are dropped and rebuilt rather than left offering a superseded
  // version alongside the current one.
  while (announcing.length > 0) announcing.pop()()

  for (const version of versions.slice(0, -1)) {
    const torrent = seeding.get(version.infoHash)
    if (!torrent) continue

    announcing.push(watchForUpdates(torrent, {
      publicKey: () => identity.publicKey,
      salt: () => saltFor(series),
      offer: () => record,
      currentInfoHash: () => torrent.infoHash,
      onUpdate: () => {}
    }))
  }
}

/** Old versions cost a full copy of the site each, so the history is bounded. */
async function pruneOldVersions () {
  while (versions.length > keepVersions) {
    const oldest = versions.shift()
    seeding.get(oldest.infoHash)?.destroy()
    seeding.delete(oldest.infoHash)
    await rm(oldest.dir, { recursive: true, force: true })
    console.log(`Stopped seeding version ${oldest.infoHash.slice(0, 8)} ` +
      `(keeping the newest ${keepVersions}).`)
  }
  await saveState()
}

function seedFrom (dir) {
  return new Promise((resolve_, reject) => {
    try {
      // No `name` option: see checkForNewVersion. The name comes from the
      // directory, which is why the directory is named after the site.
      client.seed(join(dir, siteName), { announceList }, resolve_)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Read every file back before announcing it.
 *
 * `torrent.progress` is computed from the piece map WebTorrent built while
 * hashing, so a freshly seeded torrent reports itself complete whether or not
 * the bytes can still be found. That is not a hypothetical distinction: it hid
 * a mapping bug that made this seeder serve nothing at all while every
 * indicator, including its own health endpoint, said it was fine. A seeder
 * that cannot read its own files should refuse to claim it is serving them.
 */
async function verifyReadable (torrent) {
  for (const file of torrent.files) {
    await new Promise((resolve_, reject) => {
      const stream = file.createReadStream({ start: 0, end: 0 })
      stream.on('error', reject)
      stream.on('data', () => {})
      stream.on('end', resolve_)
    })
  }
}

function magnetFor (torrent) {
  return torrent.magnetURI
}

/* -------------------------------------------------------------------------- */
/* Saying what is going on                                                    */
/* -------------------------------------------------------------------------- */

function report () {
  const newest = seeding.get(versions[versions.length - 1].infoHash)
  console.log(`\nSeeding “${siteName}” — ${versions.length} version` +
    `${versions.length === 1 ? '' : 's'}, newest is ${newest.files.length} files, ` +
    `${format(newest.length)}`)
  if (series) console.log(`Site (series): ${series}`)
  console.log(`\n  ${magnetFor(newest)}\n`)
  console.log('Open it with any Spore gate by putting that magnet in the fragment:')
  console.log(`  https://<your-gate>/#${magnetFor(newest)}\n`)

  if (versions.length > 1) {
    console.log('Still seeding, so readers on them can be offered the newest:')
    for (const version of versions.slice(0, -1)) {
      console.log(`  ${version.infoHash}  ${new Date(version.createdAt).toISOString().slice(0, 19)}`)
    }
    console.log()
  }

  if (!identity && versions.length > 1) {
    console.log('Nobody will be told about the newer versions: without a passphrase\n' +
      'there is no key to sign a successor with.\n')
  }
  console.log(`Clock: ${new Date().toISOString()} (UTC — versions are numbered by it, ` +
  'so a server whose clock is genuinely wrong will number them wrong).')
console.log('Leave this running. Ctrl+C stops seeding.\n')
}

/**
 * Keep announcing, or quietly stop being findable.
 *
 * A WebRTC tracker is a matchmaker, not a peer list. Announcing deposits a
 * batch of SDP offers; the tracker parks them and hands one to each peer that
 * turns up. They are consumed, and they expire. A seeder that announces once
 * and then waits for the tracker's suggested interval — 120 seconds, in
 * practice — runs its pool down and becomes impossible to introduce, while
 * staying connected and reporting itself perfectly healthy.
 *
 * Measured, not assumed: a seeder left alone was reachable at 5, 10 and 15
 * minutes and gave a 404 at 20, with uploads flatlining and every log line
 * still saying it was fine. That is the worst shape a failure can have.
 *
 * Announcing more often than the tracker asks is the point, so the floor is
 * 15s to keep this from being turned into something abusive.
 */
function startAnnouncing () {
  const announce = () => {
    for (const torrent of seeding.values()) {
      try {
        torrent.discovery?.tracker?.update()
      } catch (err) {
        // A tracker that will not take an announce is not fatal — the peers
        // already known stay connected — but it is why nobody new arrives.
        lastAnnounceError = err.message
      }
    }
    lastAnnounceAt = Date.now()
  }

  announce()
  setInterval(announce, announceSeconds * 1000).unref?.()
  console.log(`Re-announcing every ${announceSeconds}s, so the trackers keep ` +
    'offers to introduce readers with.\n')
}

/**
 * A tracker answering is the only evidence available that this seeder is
 * findable at all. Peer counts cannot tell "nobody wants it" from "nobody can
 * find it", which is the distinction that matters when a site goes quiet.
 */
function watchTrackerReplies (torrent) {
  try {
    torrent.discovery?.tracker?.on('update', () => { lastTrackerReplyAt = Date.now() })
  } catch {
    // Older or stubbed tracker clients simply do not report; the status
    // endpoint then says "unknown" rather than lying.
  }
}

function startHeartbeat () {
  // A terminal gets a line that rewrites itself; a log gets one complete line a
  // minute. `\r` with no newline never reaches `docker logs` at all, because
  // stdout to a pipe is buffered and Docker splits on newlines — a seeder under
  // compose used to have no observable heartbeat whatsoever.
  if (process.stdout.isTTY) {
    setInterval(() => process.stdout.write(`\r${heartbeat()}   `), 2000).unref?.()
  } else {
    setInterval(() => console.log(heartbeat()), 60_000).unref?.()
  }
}

function heartbeat () {
  const peers = [...seeding.values()].reduce((n, t) => n + t.numPeers, 0)
  const uploaded = [...seeding.values()].reduce((n, t) => n + t.uploaded, 0)
  const incomplete = [...seeding.values()].filter(t => t.progress < 1).length

  // Marked UTC, because it is. A container with no TZ logs in UTC while the
  // person reading the logs is somewhere else, and an unlabelled clock two
  // hours off their own reads as a broken server — which sends them looking
  // for a fault that is not there.
  return `${new Date().toISOString().slice(11, 19)}Z ` +
    `${versions.length} version${versions.length === 1 ? '' : 's'}  ` +
    `${peers} peer${peers === 1 ? '' : 's'}  ↑ ${format(uploaded)}` +
    (incomplete ? `  INCOMPLETE ${incomplete} — serving nothing for those` : '') +
    (trackersSilent() ? '  NO TRACKER REPLY — readers cannot be introduced' : '')
}

/** No tracker has answered for several announce cycles: nobody can find us. */
function trackersSilent () {
  if (!lastTrackerReplyAt) return Date.now() - startedAt > announceSeconds * 3000
  return Date.now() - lastTrackerReplyAt > announceSeconds * 3000
}

/**
 * What a monitor needs to tell the failure modes apart.
 *
 * `complete` false is the one worth alerting on: a version whose files no
 * longer verify is announced but cannot be served, which from the outside is
 * indistinguishable from being down.
 */
function status () {
  const newest = versions[versions.length - 1]
  return {
    site: series,
    name: siteName,
    key: identity?.hex ?? null,
    signed: Boolean(identity),
    current: newest?.infoHash ?? null,
    magnetURI: newest ? magnetFor(seeding.get(newest.infoHash)) : null,
    complete: [...seeding.values()].every(t => t.progress === 1),
    peers: [...seeding.values()].reduce((n, t) => n + t.numPeers, 0),
    uploaded: [...seeding.values()].reduce((n, t) => n + t.uploaded, 0),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    // Whether this seeder can still be *found*, which peer counts cannot say.
    lastAnnounceAt: lastAnnounceAt ? new Date(lastAnnounceAt).toISOString() : null,
    lastTrackerReplyAt: lastTrackerReplyAt ? new Date(lastTrackerReplyAt).toISOString() : null,
    trackerSilentSeconds: lastTrackerReplyAt
      ? Math.round((Date.now() - lastTrackerReplyAt) / 1000)
      : null,
    lastAnnounceError,
    versions: versions.map(version => {
      const torrent = seeding.get(version.infoHash)
      return {
        infoHash: version.infoHash,
        seq: version.seq,
        publishedAt: new Date(version.createdAt).toISOString(),
        complete: torrent ? torrent.progress === 1 : false,
        peers: torrent?.numPeers ?? 0
      }
    })
  }
}

function startStatusServer () {
  if (!statusPort) return
  if (!Number.isInteger(statusPort) || statusPort < 1 || statusPort > 65535) {
    console.error(`SPORE_STATUS_PORT must be a port number, not "${statusPort}"`)
    process.exit(2)
  }

  // Deliberately unauthenticated and read-only: it exposes nothing the magnet
  // does not already tell anyone, and requiring a secret to answer "are you
  // alive" is how health checks end up switched off. It does not report the
  // passphrase, and the public key is public.
  createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    })
    response.end(JSON.stringify(status(), null, 2) + '\n')
  }).listen(statusPort, () => {
    console.log(`Status on http://0.0.0.0:${statusPort}/ — curl it to check this seeder.`)
  })
}

/* -------------------------------------------------------------------------- */
/* Watching for edits                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Poll a cheap signature of the tree rather than watching it.
 *
 * `fs.watch` fires several times for one save, differs across platforms, and
 * misses changes made by replacing a mount. Comparing sizes and mtimes costs a
 * `stat` per file every half minute and cannot be fooled into missing an edit
 * that a full re-hash would have caught — the re-hash still happens, this only
 * decides when to bother.
 */
function startWatching () {
  if (!watchSeconds) {
    return console.log('Not watching for edits (SPORE_WATCH_SECONDS=0).\n')
  }

  let previous = null
  let busy = false

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const now = await contentSignature(contentPath)
      if (previous !== null && now !== previous) await checkForNewVersion()
      previous = now
    } catch (err) {
      console.error('Could not check the folder for changes:', err.message)
    } finally {
      busy = false
    }
  }

  contentSignature(contentPath).then(signature => { previous = signature })
  setInterval(tick, watchSeconds * 1000).unref?.()
  console.log(`Watching ${contentPath} every ${watchSeconds}s; edits publish a new version.\n`)
}

async function contentSignature (dir) {
  const parts = []

  const walk = async current => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const info = await stat(full)
        parts.push(`${relative(dir, full)}\0${info.size}\0${info.mtimeMs}`)
      }
    }
  }

  await walk(dir)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

function format (bytes) {
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Give a tree to one user, skipping the work when it already belongs to them.
 *
 * The check matters: `data/` grows a full copy of the site per version, and
 * walking all of it on every start to set ownership it already has would be a
 * silly thing to do to somebody keeping ten versions of a large site.
 */
async function chownRecursive (dir, uid, gid) {
  const info = await stat(dir)
  if (info.uid === uid && info.gid === gid) return

  await chown(dir, uid, gid)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await chownRecursive(full, uid, gid)
    else await chown(full, uid, gid).catch(() => {})
  }
}
