/**
 * Turning whatever the user pasted into a magnet URI.
 *
 * Accepts a magnet URI, a bare infohash (40 hex or 32 base32 chars), or a full
 * gate URL whose fragment holds either of those — so a link copied out of
 * another mirror can be pasted straight into the address bar.
 *
 * ## A page inside a site
 *
 * A magnet names a torrent, not a file in it, and BitTorrent has no standard
 * field for one: BEP 53's `so=` picks files by index, which a republish
 * reshuffles. So Spore adds its own, `x.sp=<path>`, the path of a page
 * relative to the site's root (where `index.html` is). `x.` is the prefix
 * BEP 9 sets aside for extensions, and other clients ignore it. The link names
 * no gate, so it opens on whichever gate the reader trusts.
 */

import { DEFAULT_TRACKERS } from './config.js'

const HEX_INFOHASH = /^[0-9a-f]{40}$/i
const BASE32_INFOHASH = /^[a-z2-7]{32}$/i

/** The magnet parameter naming a page inside the site. See above. */
export const PAGE_PARAM = 'x.sp'

export class InvalidSiteRef extends Error {}

/**
 * @param {string} input
 * @returns {{ magnetURI: string, infoHash: string|null, page: string|null, source: string }}
 *   `infoHash` is null when the reference is a magnet we cannot read a v1
 *   infohash out of; the real one is known once metadata arrives. `page` is
 *   the site-relative path from `x.sp`, and `magnetURI` comes without it:
 *   the torrent is the same whichever page is asked for.
 */
export function parseSiteRef (input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new InvalidSiteRef('Paste a magnet link or an infohash.')

  const ref = raw.startsWith('http://') || raw.startsWith('https://')
    ? fragmentOf(raw)
    : raw

  if (ref.startsWith('magnet:')) {
    return { magnetURI: withPage(ref, null), infoHash: infoHashFromMagnet(ref), page: pageFromMagnet(ref), source: ref }
  }
  if (HEX_INFOHASH.test(ref)) {
    const infoHash = ref.toLowerCase()
    return { magnetURI: magnetFor(infoHash), infoHash, page: null, source: ref }
  }
  if (BASE32_INFOHASH.test(ref)) {
    // WebTorrent decodes base32 itself; we just cannot name the hash yet.
    return { magnetURI: magnetFor(ref.toUpperCase()), infoHash: null, page: null, source: ref }
  }
  throw new InvalidSiteRef('That is not a magnet link or an infohash.')
}

/**
 * The same magnet, pointing at `page` — or at the site's home, for null.
 *
 * Any page it named before is replaced, not added to: two `x.sp` would leave
 * the reader's gate to guess.
 */
export function withPage (magnetURI, page) {
  const [head, query = ''] = magnetURI.split('?')
  const kept = query.split('&').filter(pair => pair && !pair.toLowerCase().startsWith(`${PAGE_PARAM}=`))
  if (page) kept.push(`${PAGE_PARAM}=${page.split('/').map(encodeURIComponent).join('/')}`)
  return `${head}?${kept.join('&')}`
}

/**
 * The HTTP sources a magnet offers, if any (`ws=`, a BitTorrent "web seed").
 *
 * Spore does not use them, and a reader staring at a site that will not load
 * deserves to know that a fallback existed and was declined on purpose rather
 * than assume the gate is broken. See `describe` in app.js for the reasoning.
 *
 * @returns {string[]} the hosts offered, deduplicated
 */
export function webSeedHosts (magnetURI) {
  const hosts = new Set()
  for (const [, value] of magnetURI.matchAll(/[?&]ws=([^&]+)/gi)) {
    try {
      hosts.add(new URL(decodeURIComponent(value)).host)
    } catch { /* not a URL we can name; nothing useful to report */ }
  }
  return [...hosts]
}

/** Build a magnet URI for an infohash, with the default web trackers attached. */
export function magnetFor (infoHash, name) {
  const params = DEFAULT_TRACKERS.map(tr => `tr=${encodeURIComponent(tr)}`)
  if (name) params.unshift(`dn=${encodeURIComponent(name)}`)
  return `magnet:?xt=urn:btih:${infoHash}&${params.join('&')}`
}

/**
 * The infohash a magnet addresses, validated.
 *
 * Validated here rather than left to WebTorrent, which accepts a malformed
 * infohash without complaint and then waits for peers that can never exist —
 * so a typo in a pasted link looked exactly like a site nobody is seeding, for
 * as long as the reader was willing to watch a spinner.
 *
 * @returns {string|null} the v1 infohash in hex, or null for a base32 one,
 *   which WebTorrent decodes itself and which we cannot name until metadata.
 * @throws {InvalidSiteRef} if there is no readable infohash in there
 */
function infoHashFromMagnet (magnetURI) {
  const match = /xt=urn:btih:([^&]+)/i.exec(magnetURI)
  if (!match) {
    throw new InvalidSiteRef('That magnet link has no infohash in it (no “xt=urn:btih:”).')
  }

  const value = decodeURIComponent(match[1])
  if (HEX_INFOHASH.test(value)) return value.toLowerCase()
  if (BASE32_INFOHASH.test(value)) return null

  throw new InvalidSiteRef(
    `“${value}” is not a valid infohash: it should be 40 characters of 0-9 and ` +
    'a-f, or 32 of base32. Check the link for a typo or a missing character.')
}

/**
 * The page a magnet asks for, validated, or null for the site's home.
 *
 * The value comes from whoever wrote the link, so it is held to the shape of a
 * path inside a site: no `..`, no empty or `.` segments, nothing absolute.
 * That is a courtesy rather than the defence — the gate only ever opens a page
 * that is in the torrent's own file list — but a link that could never work
 * should say so rather than quietly show the home page.
 *
 * @throws {InvalidSiteRef}
 */
function pageFromMagnet (magnetURI) {
  const match = new RegExp(`[?&]${PAGE_PARAM.replace('.', '\\.')}=([^&]*)`, 'i').exec(magnetURI)
  if (!match || match[1] === '') return null

  let page = match[1]
  try { page = decodeURIComponent(page) } catch { /* already decoded */ }
  if (page.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new InvalidSiteRef(`“${page}” is not a page inside a site: it should be a path like posts/hello.html.`)
  }
  return page
}

/**
 * The site reference lives in the URL fragment on purpose: fragments are never
 * sent to the server, so the gate's host never learns which site is being read.
 */
function fragmentOf (url) {
  try {
    return decodeURIComponent(new URL(url).hash.replace(/^#/, ''))
  } catch {
    throw new InvalidSiteRef('That URL could not be read.')
  }
}
