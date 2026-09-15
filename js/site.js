/**
 * Locating the page to render inside a torrent.
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
 * Publishing needs it too, and it must be the same function: the gate used to
 * insist on one rule when seeding and another when rendering, so it refused to
 * publish sites it could open and signed sites into directories nobody read.
 *
 * @param {string[]} paths
 * @returns {string|null}
 */
export function chooseEntry (paths) {
  return paths.find(path => ENTRY.test(path)) ?? null
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

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    // A key file is a couple of lines. Anything larger is not one, and is not
    // worth decoding to find that out.
    if (bytes.length > 4096) return null
    const { parseSporePub } = await import('./identity.js')
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

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    // A manifest is one line per file. Something far larger is not one, and
    // hashing it to find that out would be the wrong order of operations.
    if (bytes.length > 512 * 1024) return null
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
