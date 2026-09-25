/*
 * Is this browser new enough to run the gate at all?
 *
 * Runs before js/app.js, and is the one script here that is not a module and
 * uses no syntax newer than 2015 — because its job is to speak up in exactly
 * the browsers that cannot parse the rest. Without it, a browser too old for
 * the vendored WebTorrent left the page on "Starting…" forever, or showed an
 * error like "e.toBase64 is not a function" that told a reader nothing.
 *
 * Two ways a browser falls short, and both are caught here:
 *
 *  - An API is missing. Tested directly, below.
 *  - The syntax is too new for it: the gate's modules then never run, and the
 *    only trace is a SyntaxError on `window`. Syntax cannot be tested ahead of
 *    time under this page's policy (no eval), so the error is listened for.
 *
 * The minimum, and how it was worked out, is in README ("Browser support").
 * Things that only some features need — Ed25519 for signatures, zip unpacking —
 * are not checked here; the gate says so where they are used.
 */
(function () {
  'use strict'

  var MINIMUM = 'Chrome or Edge 86, Firefox 98, or Safari 16 (iOS 16)'
  var root = document.documentElement
  var missing = []

  function need (what, present) {
    var ok = false
    try { ok = present() } catch (e) { ok = false }
    if (!ok) missing.push(what)
  }

  need('JavaScript modules', function () { return 'noModule' in document.createElement('script') })
  need('WebRTC, to reach other readers', function () { return typeof RTCPeerConnection === 'function' })
  need('dialog windows', function () {
    return typeof HTMLDialogElement === 'function' && typeof HTMLDialogElement.prototype.showModal === 'function'
  })
  need('Element.replaceChildren', function () { return typeof Element.prototype.replaceChildren === 'function' })

  var shown = false
  function show (reasons) {
    if (shown) return
    shown = true
    root.setAttribute('data-unsupported', '')
    var draw = function () {
      var body = document.body
      while (body.firstChild) body.removeChild(body.firstChild)
      var box = document.createElement('main')
      box.className = 'unsupported'
      var title = document.createElement('h1')
      title.textContent = 'This browser is too old for Spore'
      var needs = document.createElement('p')
      needs.textContent = 'Spore needs ' + MINIMUM + ' or later. Updating this browser, or opening ' +
        'the same link in another one, will fix it.'
      var what = document.createElement('p')
      what.className = 'unsupported-detail'
      what.textContent = 'Missing here: ' + reasons.join('; ') + '.'
      box.appendChild(title)
      box.appendChild(needs)
      box.appendChild(what)
      body.appendChild(box)
    }
    if (document.body) draw()
    else document.addEventListener('DOMContentLoaded', draw)
  }

  if (missing.length > 0) show(missing)

  window.addEventListener('error', function (event) {
    var syntax = (event.error && event.error.name === 'SyntaxError') ||
      /SyntaxError/.test(String(event.message || ''))
    // Only while the gate has not started: once js/app.js runs it marks the
    // page, and a SyntaxError after that is some other problem, reported by
    // the gate itself.
    if (!syntax || root.hasAttribute('data-booted')) return
    show(['a JavaScript feature the gate is written in (' + (event.message || 'SyntaxError') + ')'])
  })
})()
