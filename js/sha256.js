/**
 * SHA-256, one chunk at a time.
 *
 * ## Why this exists at all
 *
 * `crypto.subtle.digest()` takes a complete buffer and returns a promise. There
 * is no `update()`, no `final()`, no streaming form — the gap has been open in
 * the platform for a decade. So a file can be *read* a chunk at a time, but it
 * could not be *described* a chunk at a time, and describing a file is what
 * signing a site consists of.
 *
 * That turned a limit of the browser API into a limit of the product: above the
 * largest buffer this machine will allocate, a site could not be signed, could
 * not be verified, and — worst of all — was reported to its readers as altered.
 * A film is exactly the thing a BitTorrent client is for, and the one thing the
 * gate could not put its name to.
 *
 * ## Why writing it is defensible
 *
 * Writing your own crypto is usually a bad idea, and this is the narrow case
 * where it is not. A hash is completely specified — FIPS 180-4 — and completely
 * testable: the published vectors either come out or they do not, and the check
 * beside this one compares it against `crypto.subtle.digest` on inputs from
 * nothing to several megabytes, at every chunk boundary that matters. There is
 * no key, no randomness, no secret, and nothing to leak. A mistake here makes
 * hashes that do not match, loudly, rather than a signature that is quietly
 * forgeable.
 *
 * The alternative was a hash of the hashes of the chunks, which needs no code
 * of ours but stops the number in `spore.sig` from being the file's SHA-256 —
 * and being able to check a published site with `sha256sum` and nothing else is
 * one of the few things that make this format worth defending.
 *
 * ## The implementation
 *
 * Deliberately the plain one from the specification, with the round constants
 * written out. It is not fast and does not try to be: it is used where the
 * native call cannot go, and correctness is checked against the native call
 * everywhere both can reach.
 */

/** Cube roots of the first sixty-four primes, as the specification gives them. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

const rotr = (x, n) => (x >>> n) | (x << (32 - n))

/**
 * A digest in progress.
 *
 * `update` may be called with any number of chunks of any size; `digest`
 * returns the 32 bytes and must be called once.
 */
export class Sha256 {
  constructor () {
    this.state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ])
    this.buffer = new Uint8Array(64)
    this.buffered = 0
    this.length = 0 // bytes seen, for the length block at the end
    this.words = new Uint32Array(64)
  }

  /** @param {Uint8Array} bytes */
  update (bytes) {
    this.length += bytes.length
    let at = 0

    // Finish any partial block left by the previous call first.
    if (this.buffered > 0) {
      const wanted = Math.min(64 - this.buffered, bytes.length)
      this.buffer.set(bytes.subarray(0, wanted), this.buffered)
      this.buffered += wanted
      at = wanted
      if (this.buffered === 64) {
        this.block(this.buffer, 0)
        this.buffered = 0
      }
    }

    // Then whole blocks straight out of the caller's bytes, without copying.
    for (; at + 64 <= bytes.length; at += 64) this.block(bytes, at)

    // Whatever is left starts the next call's partial block.
    if (at < bytes.length) {
      this.buffer.set(bytes.subarray(at), 0)
      this.buffered = bytes.length - at
    }
    return this
  }

  /** @returns {Uint8Array} the 32-byte digest */
  digest () {
    const bits = this.length * 8

    // The padding the specification prescribes: a single 1 bit, zeroes, and the
    // length in bits as a 64-bit big-endian integer.
    const tail = new Uint8Array(this.buffered < 56 ? 64 : 128)
    tail.set(this.buffer.subarray(0, this.buffered), 0)
    tail[this.buffered] = 0x80

    const view = new DataView(tail.buffer)
    // Split rather than BigInt: a file long enough to need the high word is far
    // beyond anything reachable here, and this keeps the arithmetic ordinary.
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000), false)
    view.setUint32(tail.length - 4, bits >>> 0, false)

    for (let at = 0; at < tail.length; at += 64) this.block(tail, at)

    const out = new Uint8Array(32)
    const outView = new DataView(out.buffer)
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.state[i], false)
    return out
  }

  /** One 64-byte block, straight from the specification. */
  block (bytes, at) {
    const w = this.words
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, 64)

    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = this.state

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0

      h = g; g = f; f = e
      e = (d + t1) >>> 0
      d = c; c = b; b = a
      a = (t1 + t2) >>> 0
    }

    const s = this.state
    s[0] = (s[0] + a) >>> 0; s[1] = (s[1] + b) >>> 0
    s[2] = (s[2] + c) >>> 0; s[3] = (s[3] + d) >>> 0
    s[4] = (s[4] + e) >>> 0; s[5] = (s[5] + f) >>> 0
    s[6] = (s[6] + g) >>> 0; s[7] = (s[7] + h) >>> 0
  }
}

/**
 * The digest of a Blob, read a chunk at a time and never held whole.
 *
 * This is the whole point of the file: a four-gigabyte film is described
 * without four gigabytes ever existing at once.
 *
 * @param {Blob} blob
 * @returns {Promise<Uint8Array>}
 */
export async function digestBlob (blob) {
  const hash = new Sha256()
  const reader = blob.stream().getReader()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
  }
  return hash.digest()
}
