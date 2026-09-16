/**
 * `spore.sig` — a signature over everything else in the torrent.
 *
 * ## Why this exists
 *
 * `spore.pub` names a key. Naming one is free: anybody can copy someone else's
 * public key into a folder, write their own text around it, and publish. The
 * result declares a real fingerprint that matches the real person, and until
 * this file existed nothing in Spore could tell a reader otherwise. The damage
 * is not hijacking — an impostor cannot sign a successor, so they can never
 * move the victim's readers — it is *attribution*: words appearing under a name
 * that never wrote them, passing every check available.
 *
 * So the content itself is signed. `spore.sig` lists every other file in the
 * torrent with the SHA-256 of its bytes, and signs that list with the key
 * `spore.pub` declares. Change any byte of any file and the signature stops
 * verifying. Add a file and it is missing from the list. Remove one and it is
 * listed but absent.
 *
 * ## Why there is no circularity
 *
 * The obvious objection is that a signature inside the torrent would have to
 * cover itself. It does not: the manifest covers every file *except*
 * `spore.sig`. The infohash then covers the signature file too, which is fine,
 * because nothing needs to sign the infohash for this to work.
 *
 * ## What it still does not prove
 *
 * That the key belongs to who you think. This establishes "the holder of key K
 * produced exactly these bytes", which is the half that was missing. "K is the
 * person I mean to be reading" is not a question any protocol answers; it is
 * settled by comparing a fingerprint against one obtained somewhere already
 * trusted. See spec/mutable-sites.md.
 *
 * ## The format
 *
 * Deliberately dull, and readable in view-source like everything else here:
 *
 *     spore-sig/1
 *     key=<64 hex>
 *     site=<series name, or absent>
 *     <64 hex sha256> <path>
 *     <64 hex sha256> <path>
 *     sig=<base64 ed25519 signature>
 *
 * The signature covers every byte before `sig=`, which makes the signed region
 * exactly what a reader can see and re-derive. Entries are sorted by path,
 * compared as raw UTF-8 bytes, so two implementations produce the same file.
 */

import { fromHex, toHex } from './bencode.js'
import { digestBlob } from './sha256.js'

export const SIGNATURE_FILE = 'spore.sig'

/**
 * How large a `spore.sig` may be, on both sides of the swarm.
 *
 * The reader needs a limit because it is reading a file out of a stranger's
 * torrent: without one, a hostile site can put two gigabytes at this path and
 * have every reader pull it down and hold it *before* any check has begun.
 *
 * The publisher needs the same limit for the opposite reason. A manifest is one
 * line per file, so a large honest site can make one no reader will open — and
 * the site then shows as unsigned, correctly signed, with nothing anywhere
 * saying why. That was true here: the reader refused above half a megabyte and
 * nothing on the publishing side had ever heard of the number.
 *
 * So there is one number, it lives beside the format it describes, and both
 * ends import it. Four megabytes is roughly forty thousand files, which is far
 * past anything a browser can publish and nothing beside the site it describes.
 */
export const MAX_MANIFEST_BYTES = 4_000_000

/**
 * The largest buffer this gate will ask the platform to digest in one go.
 *
 * Not a limit on anything: it is the line between two ways of computing the
 * same number. `crypto.subtle.digest` is ten times faster and takes a complete
 * buffer, which is fine for a page, a stylesheet or a photograph — nearly every
 * file there is. Above it the file is streamed through `sha256.js` instead and
 * never exists whole. Both produce the SHA-256 of the same bytes, and a check
 * compares them at every size that matters.
 *
 * There used to be a size above which a site could not be signed, could not be
 * verified, and was reported to its readers as altered. There is no such size.
 */
const DIGEST_IN_ONE_GO = 64_000_000

/**
 * The SHA-256 of some bytes, however many there are.
 *
 * @param {Uint8Array|Blob|{stream: Function, length?: number, size?: number}} source
 */
export async function digestOf (source) {
  if (source instanceof Uint8Array) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', source))
  }

  const size = source.size ?? source.length ?? Infinity
  if (size <= DIGEST_IN_ONE_GO && typeof source.arrayBuffer === 'function') {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', await source.arrayBuffer()))
  }
  return await digestBlob(source)
}

/**
 * Would signing these paths produce a manifest no reader will open?
 *
 * Answered from the paths alone, before anything is hashed, because the cost of
 * a manifest is one line per file and a line is 64 hex characters, a space, the
 * path and a newline. The header adds a hundred bytes or so; the margin here is
 * thousands of files wide, so an estimate is the honest tool.
 *
 * @param {string[]} paths site-relative
 */
export function manifestWouldExceed (paths) {
  const bytes = paths.reduce(
    (total, path) => total + 66 + new TextEncoder().encode(path).length, 256)
  return bytes > MAX_MANIFEST_BYTES
}

/**
 * Files an operating system leaves in a folder, which are not part of a site.
 *
 * This lives here because this module owns the question "what does a signature
 * cover", and the answer has to be the same everywhere: the gate, the seeder,
 * and `create-torrent`, which drops these on its own and cannot be told not to
 * when it is handed a directory. Two rules that differ by one file produce a
 * manifest describing something the torrent does not contain, and a reader
 * reads that as tampering rather than as a stray — so the list is copied from
 * `create-torrent` deliberately, and a check compares the two against the real
 * library rather than trusting the copy.
 *
 * Both halves matter: a leading dot *and* a match. `Thumbs.db` is on the list
 * and is not junk by this rule, because it has no leading dot.
 */
const JUNK = new RegExp([
  '^npm-debug\\.log$', '^\\..*\\.swp$',
  '^\\.DS_Store$', '^\\.AppleDouble$', '^\\.LSOverride$', '^Icon\\r$', '^\\._.*',
  '^\\.Spotlight-V100(?:$|\\/)', '\\.Trashes', '^__MACOSX$',
  '~$', '^Thumbs\\.db$', '^ehthumbs\\.db$', '^[Dd]esktop\\.ini$', '@eaDir$'
].join('|'))

/**
 * Two rules, because `create-torrent` has two and applies them to two kinds of
 * input. Handed a *list of files* it drops a name that begins with a dot and
 * matches the list. Handed a *directory* it walks it, dropping every hidden
 * entry and every name on the list whether or not it begins with a dot — and
 * that one cannot be turned off, since `filterJunkFiles` only reaches the list.
 *
 * The gate hands over a list; the seeder hands over a directory. Naming both
 * here, beside each other, is the only way the difference stays visible.
 */

/** What is dropped from a list of files: a dot *and* a match. */
export function isJunkPath (path) {
  const name = path.split('/').pop()
  return name.startsWith('.') && JUNK.test(name)
}

/** What is dropped while walking a directory: hidden, *or* a match. */
export function skippedWhenWalking (name) {
  return name.startsWith('.') || JUNK.test(name)
}

/** Files that describe the signature rather than being covered by it. */
const EXCLUDED = new Set([SIGNATURE_FILE])

/**
 * The bytes that get signed, and that a verifier re-derives.
 *
 * @param {{key: string, site: string|null, entries: {path: string, hash: string}[]}} manifest
 */
export function signableManifest ({ key, site, entries }) {
  const lines = ['spore-sig/1', `key=${key}`]
  if (site) lines.push(`site=${site}`)

  for (const entry of [...entries].sort(byPath)) {
    lines.push(`${entry.hash} ${entry.path}`)
  }
  // The trailing newline is part of the signed region: without it, appending a
  // line would be indistinguishable from the file simply ending there.
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

/** @returns {Promise<string>} the contents of `spore.sig` */
export async function signManifest (privateKey, { key, site, entries }) {
  const signable = signableManifest({ key, site, entries })
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, signable))

  return new TextDecoder().decode(signable) + `sig=${toBase64(signature)}\n`
}

/**
 * @param {string} contents
 * @returns {{key: string, site: string|null, entries: {path: string, hash: string}[],
 *            signature: Uint8Array, signable: Uint8Array}}
 */
export function parseManifest (contents) {
  const text = typeof contents === 'string'
    ? contents
    : new TextDecoder().decode(contents)

  const at = text.indexOf('\nsig=')
  if (at === -1) throw new SyntaxError('no signature line')

  // Re-derived from the file rather than rebuilt from the parsed fields: a
  // verifier must check what was actually signed, not what it would have
  // written itself.
  const signable = new TextEncoder().encode(text.slice(0, at + 1))
  const signature = fromBase64(text.slice(at + 5).trim())

  const lines = text.slice(0, at).split('\n')
  if (lines[0] !== 'spore-sig/1') throw new SyntaxError('not a spore-sig/1 file')

  let key = null
  let site = null
  const entries = []

  for (const line of lines.slice(1)) {
    if (line.startsWith('key=')) { key = line.slice(4).trim().toLowerCase(); continue }
    if (line.startsWith('site=')) { site = line.slice(5).trim() || null; continue }
    if (!line) continue

    const match = /^([0-9a-f]{64}) (.+)$/.exec(line)
    if (!match) throw new SyntaxError(`unreadable entry: ${line.slice(0, 40)}`)
    entries.push({ hash: match[1], path: match[2] })
  }

  if (!key || !/^[0-9a-f]{64}$/.test(key)) throw new SyntaxError('no usable key')
  return { key, site, entries, signature, signable }
}

/**
 * Check that a manifest was signed by the key the site declares.
 *
 * This is only half of verification: it says the key vouches for a particular
 * list of hashes. Whether the files actually match is `checkFile`, and both
 * must hold before anything may be called verified.
 *
 * @returns {Promise<{ok: true, manifest: object}|{ok: false, reason: string}>}
 */
export async function verifyManifest (contents, expectedKeyHex) {
  let manifest
  try {
    manifest = parseManifest(contents)
  } catch (err) {
    return { ok: false, reason: `unreadable ${SIGNATURE_FILE}: ${err.message}` }
  }

  if (manifest.key !== expectedKeyHex.toLowerCase()) {
    return { ok: false, reason: 'signed by a different key than spore.pub declares' }
  }

  let key
  try {
    key = await crypto.subtle.importKey(
      'raw', fromHex(manifest.key), { name: 'Ed25519' }, false, ['verify'])
  } catch {
    return { ok: false, reason: 'the declared key could not be imported' }
  }

  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' }, key, manifest.signature, manifest.signable)

  return valid
    ? { ok: true, manifest }
    : { ok: false, reason: 'the signature does not verify' }
}

/**
 * Does one file match what the manifest says it should be?
 *
 * Per file rather than all at once, because a torrent arrives in pieces and a
 * reader should not have to download a whole site to learn that the page in
 * front of them is authentic.
 *
 * @returns {Promise<{ok: true}|{ok: false, reason: string}>}
 */
export async function checkFile (manifest, path, bytes) {
  const entry = manifest.entries.find(e => e.path === path)
  if (!entry) {
    // An unlisted file is as much of a problem as an altered one: it is content
    // travelling under a signature that never covered it.
    return { ok: false, reason: `${path} is not in ${SIGNATURE_FILE}` }
  }

  const digest = toHex(await digestOf(bytes))
  return digest === entry.hash
    ? { ok: true }
    : { ok: false, reason: `${path} does not match its signed hash` }
}

/** Paths the manifest covers but the torrent does not contain. */
export function missingFrom (manifest, presentPaths) {
  const present = new Set(presentPaths)
  return manifest.entries.filter(e => !present.has(e.path)).map(e => e.path)
}

/** Files in the torrent that the signature never covered. */
export function unlistedIn (manifest, presentPaths) {
  const listed = new Set(manifest.entries.map(e => e.path))
  return presentPaths.filter(p => !listed.has(p) && !EXCLUDED.has(p))
}

/**
 * Build the entry list for a set of files.
 *
 * Nothing has to exist whole: a file larger than the platform's digest will
 * take is streamed through `sha256.js` instead, so a film is described without
 * a film ever being in memory.
 *
 * @param {{path: string, bytes: Uint8Array|Blob}[]} files
 */
export async function manifestEntries (files) {
  const entries = []
  for (const file of files) {
    if (EXCLUDED.has(file.path)) continue

    // A Blob is read here rather than by the caller, one file at a time. The
    // caller used to read them all first and hand over an array of byte arrays,
    // which meant holding an entire site in memory in order to describe it —
    // and a site can hold a film. The peak is now the largest single file
    // rather than the sum of all of them.
    entries.push({ path: file.path, hash: toHex(await digestOf(file.bytes)) })
  }
  return entries.sort(byPath)
}

/* -------------------------------------------------------------------------- */

/** Sorted by raw UTF-8 bytes, so every implementation agrees on the order. */
function byPath (a, b) {
  const x = new TextEncoder().encode(a.path)
  const y = new TextEncoder().encode(b.path)
  const limit = Math.min(x.length, y.length)

  for (let i = 0; i < limit; i++) {
    if (x[i] !== y[i]) return x[i] - y[i]
  }
  return x.length - y.length
}

function toBase64 (bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64 (text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
