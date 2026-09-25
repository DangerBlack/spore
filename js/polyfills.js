/**
 * The recent built-ins the vendored WebTorrent calls, where they are missing.
 *
 * `vendor/webtorrent.min.js` encodes infohashes and more with the native
 * `Uint8Array.prototype.toHex`, `Uint8Array.prototype.toBase64` and
 * `Uint8Array.fromHex` — Chrome 140, Firefox 133 and Safari 18.2, none of them
 * much more than a year old. Without them nothing opens at all, and the error
 * a reader sees is `e.toBase64 is not a function`. It also calls
 * `AbortSignal.timeout` (Chrome 124) on its HTTP path, reached when a magnet
 * names a web seed. With these, the oldest browsers Spore runs on are set by
 * other things (see README, "Browser support"), several years older.
 *
 * Only these four, because they are what the bundle actually calls — the list
 * came from reading it, not from a guess at what might be needed — and only
 * where missing: a native implementation is never replaced. They follow the
 * specification for the calls the bundle makes (no options); anything else is
 * left to the platform.
 *
 * Imported first by js/app.js, so it runs before WebTorrent is evaluated.
 */

const HEX = /^(?:[0-9a-fA-F]{2})*$/

function define (target, name, value) {
  if (typeof target[name] === 'function') return
  // Non-enumerable, like the built-in it stands in for.
  Object.defineProperty(target, name, { value, writable: true, configurable: true })
}

define(Uint8Array.prototype, 'toHex', function toHex () {
  let out = ''
  for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, '0')
  return out
})

define(Uint8Array.prototype, 'toBase64', function toBase64 () {
  // In slices: String.fromCharCode spread over a whole large array would
  // overflow the call stack.
  let binary = ''
  for (let i = 0; i < this.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000))
  }
  return btoa(binary)
})

define(AbortSignal, 'timeout', function timeout (milliseconds) {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), milliseconds)
  return controller.signal
})

define(Uint8Array, 'fromHex', function fromHex (string) {
  if (typeof string !== 'string') throw new TypeError('Uint8Array.fromHex requires a string')
  if (!HEX.test(string)) throw new SyntaxError('Uint8Array.fromHex requires an even number of hex digits')
  const out = new Uint8Array(string.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(string.substr(i * 2, 2), 16)
  return out
})
