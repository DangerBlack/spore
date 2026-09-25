/**
 * An author's key: making one, deriving one from a passphrase, and reading the
 * `spore.pub` a site declares.
 *
 * Ed25519 and PBKDF2 are both native in current Chrome, Chromium and Firefox,
 * so there is no crypto library here and there should never be one.
 *
 * See spec/mutable-sites.md for what any of this is worth. Briefly: a key is an
 * author, a signature proves the same author published two things, and neither
 * proves who that author is.
 */

import { fromHex, toHex } from './bencode.js'

/**
 * Deliberately expensive. The public key is public, so a passphrase can be
 * attacked offline with no rate limit and no lockout — this is a brain wallet,
 * with the same failure mode. Measured at roughly 0.3 s in Chrome and 0.9 s in
 * Firefox for 600k, so this costs a moment on publish and nothing on read.
 */
const PBKDF2_ITERATIONS = 1_200_000

/**
 * A fixed salt makes derivation reproducible on any machine with nothing to
 * carry — which is the entire appeal — at the cost of letting one precomputed
 * table serve every user. Against a passphrase with real entropy that is an
 * acceptable trade; against a weak one nothing here helps, which is why the
 * gate should generate the words rather than accept a typed password.
 */
const DERIVATION_SALT = new TextEncoder().encode('spore/identity/v1')

/**
 * The 16 bytes that turn a raw Ed25519 seed into a PKCS#8 private key.
 * WebCrypto will not import a bare 32-byte seed, but it will import this, and
 * the prefix is constant for every Ed25519 key.
 */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
])

/**
 * @typedef {object} Identity
 * @property {CryptoKey} privateKey  never persisted; held in memory only
 * @property {Uint8Array} publicKey  32 raw bytes
 * @property {string} hex            the public key as 64 hex characters
 */

/**
 * What to tell someone whose browser has no Ed25519 in WebCrypto — Chrome and
 * Edge before 137, Firefox before 129, Safari before 17. Everything else in
 * Spore works there; signing and checking signatures do not.
 */
export const ED25519_UNSUPPORTED =
  'this browser cannot make or check Ed25519 signatures (Chrome or Edge 137, Firefox 129 and Safari 17 can)'

/** RFC 8032 §7.1, test 1: a public key known to be valid. */
const KNOWN_PUBLIC_KEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'

let ed25519 = null

/**
 * Can this browser do Ed25519 at all? Asked once, by importing a key that is
 * certainly valid, so a failure means the algorithm and never the key.
 *
 * It matters because the two failures look alike from the call that fails. A
 * browser without Ed25519 rejects every key, and a verifier that did not ask
 * reported every signed site as not matching its own signature — telling
 * readers that honest authors had been tampered with.
 *
 * @returns {Promise<boolean>}
 */
export function supportsEd25519 () {
  ed25519 ??= crypto.subtle.importKey(
    'raw', fromHex(KNOWN_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']
  ).then(() => true, () => false)
  return ed25519
}

async function requireEd25519 () {
  if (!(await supportsEd25519())) {
    throw new Error(ED25519_UNSUPPORTED.charAt(0).toUpperCase() + ED25519_UNSUPPORTED.slice(1) + '.')
  }
}

/** A fresh random identity. The private key must be exported and kept. */
export async function createIdentity () {
  await requireEd25519()
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey, hex: toHex(publicKey) }
}

/**
 * The same passphrase always produces the same identity, on any machine.
 *
 * There is no account and nothing to check against: every passphrase yields a
 * valid key, so a typo does not fail — it silently makes you a different
 * author. Callers must show the fingerprint or avatar the moment this returns,
 * because a wrong passphrase is only visible as a wrong picture.
 *
 * @param {string} passphrase
 * @returns {Promise<Identity>}
 */
export async function identityFromPassphrase (passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('a passphrase is required')
  }
  // Before the derivation, which is slow on purpose: otherwise a browser that
  // cannot sign spends seconds on it and only then says so.
  await requireEd25519()

  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase.normalize('NFKC')),
    'PBKDF2', false, ['deriveBits'])

  const seed = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-512', salt: DERIVATION_SALT, iterations: PBKDF2_ITERATIONS },
    base, 256))

  return await identityFromSeed(seed)
}

/** @param {Uint8Array} seed 32 bytes */
export async function identityFromSeed (seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new TypeError('seed must be 32 bytes')
  }
  await requireEd25519()

  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32)
  pkcs8.set(PKCS8_ED25519_PREFIX, 0)
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length)

  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])

  // WebCrypto will not hand back the public half of an imported private key,
  // so it is recovered the only way available: sign a fixed message and find
  // the key that verifies it. Cheaper than it sounds — Ed25519 public keys are
  // derived from the seed, and jwk export gives it directly.
  const jwk = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
  const exported = await crypto.subtle.exportKey('jwk', jwk)
  const publicKey = base64UrlToBytes(exported.x)

  return { privateKey, publicKey, hex: toHex(publicKey) }
}

/* -------------------------------------------------------------------------- */
/* spore.pub                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The longest a series name may be, because BEP 44 caps a salt at 64 bytes.
 * Measured in UTF-8 bytes, not characters.
 */
export const MAX_SITE_BYTES = 64

/**
 * How large a `spore.pub` may be, on both sides of the swarm.
 *
 * A key file is a line of hex and at most two more. This is read out of a
 * stranger's torrent, so something far larger is not one, and decoding it to
 * find that out would be the wrong order of operations.
 *
 * Exported because the publisher checks the same thing when it decides whether
 * a publication already verifies. It used to apply neither this nor the
 * manifest's limit, so it could conclude "this verifies, republish it
 * untouched" about a site every reader would show as unsigned.
 */
export const MAX_KEY_BYTES = 4096

/**
 * Parse the file a site uses to declare its author and which of that author's
 * sites it is.
 *
 * Format is deliberately dull: the key as hex on the first line, then optional
 * `name=` and `site=` lines.
 *
 * `name` is a *claim* — tamper-proof, because it is covered by the torrent's
 * hashes, and not thereby true. Callers must never render it as the author's
 * name.
 *
 * `site` is the series this belongs to, and it is load-bearing rather than
 * decorative: it becomes the BEP 44 salt, so `(key, site)` is what an update
 * actually addresses. Without it a key would have exactly one series, and
 * publishing a second site under the same identity would announce itself as
 * the successor to the first. An author has many sites; a key is an author.
 *
 * @param {string|Uint8Array} contents
 * @returns {{ publicKey: Uint8Array, hex: string, claimedName: string|null,
 *             site: string|null, salt: Uint8Array }}
 */
export function parseSporePub (contents) {
  const text = typeof contents === 'string' ? contents : new TextDecoder().decode(contents)
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)

  const hex = (lines[0] ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new SyntaxError('spore.pub must begin with 64 hex characters')
  }

  let claimedName = null
  let site = null
  for (const line of lines.slice(1)) {
    const name = /^name=(.*)$/.exec(line)
    if (name) claimedName = name[1].trim() || null

    const series = /^site=(.*)$/.exec(line)
    if (series) site = normalizeSite(series[1]) // throws on anything unusable
  }

  return { publicKey: fromHex(hex), hex, claimedName, site, salt: saltFor(site) }
}

/**
 * Canonical form of a series name.
 *
 * Lower-cased and NFC-normalised because the salt is compared byte for byte:
 * "Blog" and "blog" would otherwise be two different series, and a publisher
 * would fork their own site by capitalising differently on a new machine.
 * Whitespace is refused for the same reason — a trailing space is invisible
 * and would silently start a new series.
 *
 * @returns {string|null} null for an empty name, meaning the default series
 */
export function normalizeSite (site) {
  if (site == null) return null
  const trimmed = String(site).normalize('NFC').trim().toLowerCase()
  if (trimmed === '') return null

  if (/\s/.test(trimmed)) {
    throw new SyntaxError('a site name cannot contain spaces')
  }
  if (new TextEncoder().encode(trimmed).length > MAX_SITE_BYTES) {
    throw new SyntaxError(`a site name must be at most ${MAX_SITE_BYTES} bytes`)
  }
  return trimmed
}

/**
 * The BEP 44 salt for a series name.
 *
 * A site with no name uses the empty salt, which is an ordinary unsalted
 * mutable item — so "the author's default series" needs no special case
 * anywhere, and an older `spore.pub` with no `site=` keeps working.
 */
export function saltFor (site) {
  const normalized = normalizeSite(site)
  return normalized ? new TextEncoder().encode(normalized) : new Uint8Array(0)
}

/** The file contents a publisher should put in their folder. */
export function formatSporePub (hex, claimedName, site) {
  const name = claimedName ? `\nname=${claimedName.replace(/[\r\n]/g, ' ').trim()}` : ''
  const normalized = normalizeSite(site)
  const series = normalized ? `\nsite=${normalized}` : ''
  return `${hex}${name}${series}\n`
}

/* -------------------------------------------------------------------------- */
/* Showing a key to a person                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A short fingerprint for comparing keys by eye.
 *
 * Grouped hex rather than words, on purpose. The specification leaves the
 * wordlist undecided, and shipping a provisional one would be worse than
 * shipping none: the moment it changed, every fingerprint anyone had written
 * down or read aloud would change with it.
 */
export async function fingerprint (publicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))
  const hex = toHex(digest.subarray(0, 8))
  return hex.replace(/(.{4})(?=.)/g, '$1-')
}

/**
 * A deterministic avatar, so a change of key is *noticed*.
 *
 * Symmetric because symmetry is easier to remember. Emphatically not a
 * verification mechanism — OpenSSH says the same of its randomart, and for the
 * same reason: keys can be ground until the picture looks about right, and
 * people compare pictures coarsely. It answers "does this look like last
 * time"; the fingerprint answers "is this the same key".
 *
 * @returns {Promise<string>} an SVG document
 */
export async function avatar (publicKey, size = 64) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))

  const hue = (digest[0] * 360) / 256
  const fill = `hsl(${hue.toFixed(0)} 62% 45%)`
  const back = `hsl(${((hue + 180) % 360).toFixed(0)} 24% 92%)`

  // A 5x5 grid, mirrored left to right: 15 independent cells from 15 bytes.
  const cells = []
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((digest[1 + y * 3 + x] & 1) === 0) continue
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`)
      if (x < 2) cells.push(`<rect x="${4 - x}" y="${y}" width="1" height="1"/>`)
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 5 5" shape-rendering="crispEdges" role="img" aria-label="author avatar">` +
    `<rect width="5" height="5" fill="${back}"/>` +
    `<g fill="${fill}">${cells.join('')}</g></svg>`
}

function base64UrlToBytes (value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}
