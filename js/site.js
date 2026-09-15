/**
 * What a site is: the rules, for both ends of the swarm.
 *
 * This module is imported by the viewer, which asks them of a torrent, and by
 * publishing, which asks them of files that are about to become one. That is
 * the point of it being one module: every serious defect on this branch was the
 * two sides answering one of these questions with two pieces of code, agreeing
 * on every layout anyone had tried and differing on one nobody had.
 *
 * It depends on nothing that needs a browser, so the checks can ask it the same
 * questions directly.
 *
 * ## Locating the page to render inside a torrent.
 *
 * One rule, and it is a rule rather than a search: **the entry page is
 * `index.html` in the site's root, and nowhere else.** A torrent's root is the
 * single folder BitTorrent wraps a multi-file torrent in, or the file itself
 * when there is only one.
 *
 * What used to be here looked for the shallowest `index.html` anywhere in the
 * tree, and that flexibility was the single largest source of defects in this
 * codebase: "which directory is the site?" then had an answer that depended on
 * where you asked from, and the publisher and the reader answered it with
 * different code. A signature was written into one directory while readers
 * looked in another, and a correctly signed site read as unsigned. There is
 * nothing to disagree about now.
 *
 * A torrent with no `index.html` in its root is not a failure. It is a set of
 * files, and the gate shows it as one for the reader to browse.
 */

import { TORRENT_PATH } from './config.js'
import { MAX_KEY_BYTES, parseSporePub } from './identity.js'
import { MAX_MANIFEST_BYTES, isJunkPath } from './manifest.js'

/** `index.html` directly inside the torrent's single root folder, or alone. */
const ENTRY = /^(?:[^/]+\/)?index\.html?$/i

/**
 * @param {import('webtorrent').Torrent} torrent
 * @returns {string|null} the entry file's path within the torrent
 */
export function findEntry (torrent) {
  return chooseEntry(torrent.files.map(file => normalize(file.path)))
}

/**
 * The same question, asked of paths rather than of a torrent.
 *
 * This is the *reader's* half, and it tolerates one leading folder because
 * BitTorrent wraps every multi-file torrent in exactly one. Publishing asks the
 * same question of paths that have not been through that yet, where the same
 * tolerance would accept a folder that is not the torrent's — so `publish.js`
 * anchors its own version at the set's root instead. Two questions about one
 * rule, kept honest by a check that publishes every shape of input and compares
 * the two answers, because every serious defect on this branch was them
 * disagreeing about a shape nobody had tried.
 *
 * @param {string[]} paths
 * @returns {string|null}
 */
export function chooseEntry (paths) {
  return paths.find(path => ENTRY.test(path)) ?? null
}

/** One spelling of a file's path, used by everything that compares them. */
export function pathOf (file) {
  return (file.fullPath || file.name).replace(/\\/g, '/')
}

/**
 * What a reader will land on, or `null` if they will land on a file list.
 *
 * `index.html` at the top of the set and nowhere else. There is no root to
 * account for here because `asSite` has already removed it: the paths this sees
 * are the paths that will be published, one folder shallower than the reader's
 * only because BitTorrent adds that folder itself.
 *
 * @param {File[]} files
 * @returns {string|null}
 */
export function entryFor (files) {
  return files.map(pathOf).find(path => /^index\.html?$/i.test(path)) ?? null
}

/**
 * A set of files as the site it is meant to be, at the paths it will have.
 *
 * Two jobs, and the first is the one that matters.
 *
 * **Every path is made relative to the site's root**, because otherwise
 * `create-torrent` does it — and it does it to the set it publishes, not to the
 * set that was signed. It removes one shared top folder, silently, whenever
 * every file has one. So `spore.sig` described `sito/index.html` while the
 * torrent contained `index.html`, a reader comparing the two found a file
 * missing, and the site was reported as having been altered. Every serious
 * defect on this branch was a version of that sentence.
 *
 * Handing over paths that are already root-relative leaves nothing to remove.
 * It strips repeatedly, because the library takes one level per pass and would
 * take the next one otherwise, and it stops as soon as some file sits at the
 * root — which is exactly the condition under which the library does nothing.
 * The outermost folder becomes the torrent's name, so the link still says what
 * the author called the thing.
 *
 * Second: a lone page becomes `index.html`, whatever it was called, because
 * somebody who picks `il-mio-post.html` on a phone means it to be the site, and
 * the alternative is telling them to rename a file with tools they do not have.
 *
 * Neither job touches a byte. Both rewrite `fullPath`, which is all
 * `create-torrent` reads: for one file it takes that path's basename, and for
 * several it takes the paths entire.
 *
 * @param {File[]} files
 * @returns {{files: File[], renamed: {from: string, to: string}|null, name: string|null}}
 */
export function asSite (files) {
  let name = null
  for (let top = sharedTop(files.map(pathOf)); top; top = sharedTop(files.map(pathOf))) {
    name = name ?? top.slice(0, -1)
    for (const file of files) file.fullPath = pathOf(file).slice(top.length)
  }

  if (entryFor(files)) return { files, renamed: null, name }

  const pages = files.filter(file => /^[^/]+\.html?$/i.test(pathOf(file)))
  if (pages.length !== 1) return { files, renamed: null, name }

  const from = pathOf(pages[0])
  pages[0].fullPath = 'index.html'
  return {
    files,
    renamed: { from, to: 'index.html' },
    name: name ?? from.replace(/\.html?$/i, '')
  }
}

function sharedTop (paths) {
  const cut = paths[0]?.indexOf('/') ?? -1
  if (cut < 1) return ''

  const top = paths[0].slice(0, cut + 1)
  return paths.every(path => path.startsWith(top)) ? top : ''
}

/**
 * The same files, without what an operating system left among them.
 *
 * The rule lives in `manifest.js`, with the question it answers — what a
 * signature covers — because the seeder needs the identical answer and
 * `create-torrent` applies its own copy when handed a directory. The torrent is
 * built here with the library's filtering **off**, so for this path there is
 * exactly one filter and it is this one: the library used to drop these
 * silently *after* `spore.sig` had hashed them, and every reader was told the
 * site had been altered.
 *
 * @param {File[]} files @returns {{files: File[], dropped: string[]}}
 */
export function dropJunk (files) {
  const junk = file => isJunkPath(pathOf(file))
  return {
    files: files.filter(file => !junk(file)),
    dropped: files.filter(junk).map(pathOf)
  }
}

/** URL the viewer iframe points at, served by the worker from the swarm. */
export function entryURL (infoHash, entryPath) {
  const encoded = entryPath.split('/').map(encodeURIComponent).join('/')
  return new URL(`./${TORRENT_PATH}/${infoHash}/${encoded}`, document.baseURI).href
}

/** Torrents made on Windows can carry backslashes; the worker matches on `/`. */
function normalize (path) {
  return path.replace(/\\/g, '/')
}

/**
 * The key a site declares for itself, if it declares one.
 *
 * `spore.pub` sits beside the entry page, so it is scoped to the site rather
 * than to the torrent: a torrent that happens to contain several directories
 * does not let one of them speak for another. Only the file next to the page
 * actually being rendered counts.
 *
 * A site with no `spore.pub` has no author and can never be updated, which is
 * the correct reading of "this publisher never claimed a key" — not an
 * invitation for the first peer along to claim one on their behalf.
 *
 * @returns {Promise<{publicKey: Uint8Array, hex: string, claimedName: string|null}|null>}
 */
export async function readSporePub (torrent, entryPath) {
  const root = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : ''
  const file = torrent.files.find(f => normalize(f.path) === `${root}spore.pub`)
  if (!file) return null

  // Before reading, not after. `file.arrayBuffer()` on a torrent file selects
  // and downloads the whole thing, so a check that runs afterwards has already
  // let a hostile site make every reader pull down whatever it liked — which is
  // precisely what this limit is documented as preventing. `length` comes from
  // the torrent's metadata and costs nothing.
  if (file.length > MAX_KEY_BYTES) return null

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return parseSporePub(new TextDecoder().decode(bytes))
  } catch {
    // Unreadable or malformed: the site declares no usable key. Treated
    // exactly like declaring none, because a broken claim is not a claim.
    return null
  }
}

/**
 * The signed manifest a site ships, if it ships one.
 *
 * Beside `index.html` like `spore.pub`, and read the same way: a file in one
 * directory does not get to vouch for a different directory's contents.
 *
 * @returns {Promise<{contents: string, root: string}|null>}
 */
export async function readManifest (torrent, entryPath) {
  const root = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : ''
  const file = torrent.files.find(f => normalize(f.path) === `${root}spore.sig`)
  if (!file) return null

  // Before reading, for the same reason: this file comes out of a stranger's
  // torrent, and asking for it is what costs. The same number bounds what this
  // gate will sign, so an honest site can never make one this refuses.
  if (file.length > MAX_MANIFEST_BYTES) return null

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return { contents: new TextDecoder().decode(bytes), root }
  } catch {
    return null
  }
}

/** Site-relative paths of everything in the torrent, for manifest comparison. */
export function filePaths (torrent, root) {
  return torrent.files
    .map(file => normalize(file.path))
    .filter(path => path.startsWith(root))
    .map(path => path.slice(root.length))
}
