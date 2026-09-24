#!/usr/bin/env node
/**
 * End-to-end check of both MVP promises and the security model behind them.
 *
 * The guarantees in SECURITY.md are claims about browser behaviour, so they are
 * checked in a browser rather than reasoned about. It drives a real Chrome:
 * publishes `example-site/`, opens it through the normal fragment route, and
 * inspects what the site is allowed to do.
 *
 *   npm install puppeteer-core        # the only dependency, and only for this
 *   node tools/e2e.mjs [--headful] [--chrome /path/to/chrome]
 *
 * Nothing in the gate itself needs this: it is a static bundle with no build
 * step and no dependencies to install.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

const CHROME = option('--chrome', process.env.CHROME ?? '/usr/bin/google-chrome')
const SITE = 'example-site'
const SITE_FILES = ['index.html', 'about.html', 'probe.js', 'css/site.css', 'css/leaf.svg']

/** A .zip whose trailing comment contains the end-of-directory signature. */
const COMMENTED_ZIP = 'UEsDBBQAAAAIABqSLV25AlbGEgAAABIAAAAKAAAAaW5kZXguaHRtbLPJMLRzzs/NTc0rSU2x0QfyAFBLAQIUAxQAAAAIABqSLV25AlbGEgAAABIAAAAKAAAAAAAAAAAAAACAAQAAAABpbmRleC5odG1sUEsFBgAAAAABAAEAOAAAADoAAAAiAFBLBQYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/** A .zip carrying two entries at the same path, with different contents. */
const DUPLICATE_PATHS = 'UEsDBBQAAAAIABqSLV2DkPvYDgAAAA4AAAAKAAAAaW5kZXguaHRtbLPJMLQrKMrMzbfRB7IAUEsDBBQAAAAIABqSLV2hhW+pEAAAABAAAAAKAAAAaW5kZXguaHRtbLPJMLQrTk3Oz0vJt9EHsgFQSwECFAMUAAAACAAaki1dg5D72A4AAAAOAAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLAQIUAxQAAAAIABqSLV2hhW+pEAAAABAAAAAKAAAAAAAAAAAAAACAATYAAABpbmRleC5odG1sUEsFBgAAAAACAAIAcAAAAG4AAAAAAA=='

/**
 * Archives that must be refused, with the reason each must be refused for.
 *
 * These are the security boundary of the archive reader, and until this table
 * existed the browser check exercised exactly one valid archive: every refusal
 * below could have been deleted and the suite would still have passed.
 */
const REFUSED_ARCHIVES = [
  { name: 'TRAVERSAL', file: 'traversal.zip', because: 'points outside the archive', base64: 'UEsDBBQAAAAIAAOULV1b+fQWBgAAAAQAAAAQAAAALi4vLi4vZXRjL3Bhc3N3ZCvKzy8BAFBLAQIUAxQAAAAIAAOULV1b+fQWBgAAAAQAAAAQAAAAAAAAAAAAAACAAQAAAAAuLi8uLi9ldGMvcGFzc3dkUEsFBgAAAAABAAEAPgAAADQAAAAAAA==' },
  { name: 'ABSOLUTE', file: 'absolute.zip', because: 'is an absolute path', base64: 'UEsDBBQAAAAIAAOULV2DFtyMAwAAAAEAAAALAAAAL2V0Yy9zaGFkb3erAABQSwECFAMUAAAACAADlC1dgxbcjAMAAAABAAAACwAAAAAAAAAAAAAAgAEAAAAAL2V0Yy9zaGFkb3dQSwUGAAAAAAEAAQA5AAAALAAAAAAA' },
  { name: 'BACKSLASH', file: 'backslash.zip', because: 'uses backslashes', base64: 'UEsDBBQAAAAIAAOULV1ZcYfiCAAAAAYAAAANAAAAY3NzXHN0eWxlLmNzc0vKT6msrgUAUEsBAhQDFAAAAAgAA5QtXVlxh+IIAAAABgAAAA0AAAAAAAAAAAAAAIABAAAAAGNzc1xzdHlsZS5jc3NQSwUGAAAAAAEAAQA7AAAAMwAAAAAA' },
  { name: 'SYMLINK', file: 'symlink.zip', because: 'is a symbolic link', base64: 'UEsDBBQAAAAAAAAAIQBjGzOSDAAAAAwAAAAJAAAAbGluay5odG1sLi4vLi4vc2VjcmV0UEsBAhQDFAAAAAAAAAAhAGMbM5IMAAAADAAAAAkAAAAAAAAAAAAAAP+hAAAAAGxpbmsuaHRtbFBLBQYAAAAAAQABADcAAAAzAAAAAAA=' },
  { name: 'ENCRYPTED', file: 'encrypted.zip', because: 'is encrypted', base64: 'UEsDBBQAAAAIAAOULV1SQcz9CgAAAAoAAAAKAAAAaW5kZXguaHRtbLPJMLSrsNEHkgBQSwECFAMUAAEACAADlC1dUkHM/QoAAAAKAAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAAAyAAAAAAA=' },
  { name: 'CORRUPT', file: 'corrupt.zip', because: 'could not be decompressed', base64: 'UEsDBBQAAAAIAAOULV1khh0oGgAAABkAAAAKAAAAaW5kZXguaHRtbEzJMLRLTEpOSU1Lz8jMys7JzcsvsNEHCgIAUEsBAhQDFAAAAAgAA5QtXWSGHSgaAAAAGQAAAAoAAAAAAAAAAAAAAIABAAAAAGluZGV4Lmh0bWxQSwUGAAAAAAEAAQA4AAAAQgAAAAAA' },
  { name: 'UNKNOWN_METHOD', file: 'unknown-method.zip', because: 'compression method Spore does not read', base64: 'UEsDBBQAAAAJAAOULV1SQcz9CgAAAAoAAAAKAAAAaW5kZXguaHRtbLPJMLSrsNEHkgBQSwECFAMUAAAACQADlC1dUkHM/QoAAAAKAAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAAAyAAAAAAA=' },
  { name: 'NOT_UTF8', file: 'not-utf8.zip', because: 'not UTF-8', base64: 'UEsDBBQAAAgIAPGYLV1SQcz9CgAAAAoAAAALAAAAaW5kZXj/Lmh0bWyzyTC0q7DRB5IAUEsBAhQDFAAACAgA8ZgtXVJBzP0KAAAACgAAAAsAAAAAAAAAAAAAAIABAAAAAGluZGV4/y5odG1sUEsFBgAAAAABAAEAOQAAADMAAAAAAA==' },
  { name: 'NOT_A_ZIP', file: 'not-a-zip.zip', because: 'not a zip archive', base64: 'PGh0bWw+bm90IGFuIGFyY2hpdmUgYXQgYWxsPC9odG1sPg==' },
  { name: 'DOT_SEGMENT', file: 'dot-segment.zip', because: 'is not a plain path', base64: 'UEsDBBQAAAAIAFKYLV1SQcz9CgAAAAoAAAARAAAAc2l0ZS8uL2luZGV4Lmh0bWyzyTC0q7DRB5IAUEsBAhQDFAAAAAgAUpgtXVJBzP0KAAAACgAAABEAAAAAAAAAAAAAAIABAAAAAHNpdGUvLi9pbmRleC5odG1sUEsFBgAAAAABAAEAPwAAADkAAAAAAA==' },
  { name: 'EMPTY_SEGMENT', file: 'empty-segment.zip', because: 'is not a plain path', base64: 'UEsDBBQAAAAIAFKYLV1SQcz9CgAAAAoAAAAQAAAAc2l0ZS8vaW5kZXguaHRtbLPJMLSrsNEHkgBQSwECFAMUAAAACABSmC1dUkHM/QoAAAAKAAAAEAAAAAAAAAAAAAAAgAEAAAAAc2l0ZS8vaW5kZXguaHRtbFBLBQYAAAAAAQABAD4AAAA4AAAAAAA=' },
  { name: 'LEGACY_NAME', file: 'legacy-name.zip', because: 'legacy character set', base64: 'UEsDBBQAAAAIAFKYLV1SQcz9CgAAAAoAAAAMAAAAaW5kZXjDqS5odG1ss8kwtKuw0QeSAFBLAQIUAxQAAAAIAFKYLV1SQcz9CgAAAAoAAAAMAAAAAAAAAAAAAACAAQAAAABpbmRleMOpLmh0bWxQSwUGAAAAAAEAAQA6AAAANAAAAAAA' },
  { name: 'C1_CONTROL', file: 'c1-control.zip', because: 'control characters', base64: 'UEsDBBQAAAgIAGWYLV1SQcz9CgAAAAoAAAAMAAAAaW5kZXjCny5odG1ss8kwtKuw0QeSAFBLAQIUAxQAAAgIAGWYLV1SQcz9CgAAAAoAAAAMAAAAAAAAAAAAAACAAQAAAABpbmRleMKfLmh0bWxQSwUGAAAAAAEAAQA6AAAANAAAAAAA' },
  { name: 'TRUNCATED_INDEX', file: 'truncated-index.zip', because: 'index is truncated', base64: 'UEsDBBQAAAAIAFKYLV1SQcz9CgAAAAoAAAAKAAAAaW5kZXguaHRtbLPJMLSrsNEHkgBQSwECFAMUAAAACABSmC1dUkHM/QoAAAAKAAAA9AEAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAAAyAAAAAAA=' },
  { name: 'TRAILING_DOT', file: 'trailing-dot.zip', because: 'is not a plain path', base64: 'UEsDBBQAAAAIAPebLV2DFtyMAwAAAAEAAAAGAAAAc2l0ZS8uqwAAUEsBAhQDFAAAAAgA95stXYMW3IwDAAAAAQAAAAYAAAAAAAAAAAAAAIABAAAAAHNpdGUvLlBLBQYAAAAAAQABADQAAAAnAAAAAAA=' },
  { name: 'ZIP64', file: 'zip64.zip', because: 'zip64 format', base64: 'UEsDBBQAAAAIALdrL11SQcz9CgAAAAoAAAAKAAAAaW5kZXguaHRtbLPJMLSrsNEHkgBQSwECFAMUAAAACAC3ay9dUkHM/QoAAAAKAAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAAD/////AAA=' },
  { name: 'DRIVE_LETTER', file: 'drive-letter.zip', because: 'names a drive', base64: 'UEsDBBQAAAAIALdrL11SQcz9CgAAAAoAAAANAAAAQzovaW5kZXguaHRtbLPJMLSrsNEHkgBQSwECFAMUAAAACAC3ay9dUkHM/QoAAAAKAAAADQAAAAAAAAAAAAAAgAEAAAAAQzovaW5kZXguaHRtbFBLBQYAAAAAAQABADsAAAA1AAAAAAA=' },
  { name: 'EXPANSION_BOMB', file: 'expansion-bomb.zip', because: 'expand more than 2000-fold', base64: 'UEsDBBQAAAAIAARxL12PXQ5eBgAAAGQAAAAKAAAAaW5kZXguaHRtbKuooD0AAFBLAQIUAxQAAAAIAARxL12PXQ5eBgAAAAAoa+4KAAAAAAAAAAAAAACAAQAAAABpbmRleC5odG1sUEsFBgAAAAABAAEAOAAAAC4AAAAAAA==' },
  { name: 'TOO_MUCH_TO_HOLD', file: 'too-much-to-hold.zip', because: 'more than 256 MB of compressed files', base64: 'UEsDBBQAAAAIAARxL12AFwsGCwAAAOgDAAAHAAAAcDAuaHRtbGNgGAWjYBQMdwAAUEsDBBQAAAAIAARxL12AFwsGCwAAAOgDAAAHAAAAcDEuaHRtbGNgGAWjYBQMdwAAUEsDBBQAAAAIAARxL12AFwsGCwAAAOgDAAAHAAAAcDIuaHRtbGNgGAWjYBQMdwAAUEsDBBQAAAAIAARxL12AFwsGCwAAAOgDAAAHAAAAcDMuaHRtbGNgGAWjYBQMdwAAUEsBAhQDFAAAAAgABHEvXYAXCwZAQg8AgEpdBQcAAAAAAAAAAAAAAIABAAAAAHAwLmh0bWxQSwECFAMUAAAACAAEcS9dgBcLBkBCDwCASl0FBwAAAAAAAAAAAAAAgAEwAAAAcDEuaHRtbFBLAQIUAxQAAAAIAARxL12AFwsGQEIPAIBKXQUHAAAAAAAAAAAAAACAAWAAAABwMi5odG1sUEsBAhQDFAAAAAgABHEvXYAXCwZAQg8AgEpdBQcAAAAAAAAAAAAAAIABkAAAAHAzLmh0bWxQSwUGAAAAAAQABADUAAAAwAAAAAAA' },
  { name: 'PREFIXED', file: 'prefixed.zip', because: 'something in front of its index', base64: 'TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQSwMEFAAAAAgAUZwvXVJBzP0KAAAACgAAAAoAAABpbmRleC5odG1ss8kwtKuw0QeSAFBLAQIUAxQAAAAIAFGcL11SQcz9CgAAAAoAAAAKAAAAAAAAAAAAAACAAQAAAABpbmRleC5odG1sUEsFBgAAAAABAAEAOAAAADIAAAAAAA==' }
]

/**
 * A .zip whose central directory lists `nested/index.html` before `index.html`.
 *
 * Readers open the shallowest page; signing used to take the first one it found
 * in array order, which an archive chooses.
 */
const ORDERED_ZIP = 'UEsDBBQAAAAIAPCVLV1qlh8DKAAAADMAAAARAAAAbmVzdGVkL2luZGV4Lmh0bWyzUUzJTy6pLEhVyCjJzbGzKcksyUm1y0stLklNsdGH8GwyDOEiQCYAUEsDBBQAAAAIAPCVLV20QKIBKwAAADUAAAAKAAAAaW5kZXguaHRtbLNRTMlPLqksSFXIKMnNsbMpySzJSbUrzkjMyckvt9GHcG0yDO2CYUJANgBQSwECFAMUAAAACADwlS1dapYfAygAAAAzAAAAEQAAAAAAAAAAAAAAgAEAAAAAbmVzdGVkL2luZGV4Lmh0bWxQSwECFAMUAAAACADwlS1dtECiASsAAAA1AAAACgAAAAAAAAAAAAAAgAFXAAAAaW5kZXguaHRtbFBLBQYAAAAAAgACAHcAAACqAAAAAAA='

/**
 * What macOS's own "Compress" produces: the folder, and `__MACOSX/` beside it.
 *
 * Two top levels, and the second one is not part of the site. Signing hashed it
 * anyway while verification never looked there, so an ordinary Mac-made archive
 * published a site that accused itself of having been altered.
 */
const MAC_STYLE_ZIP = 'UEsDBBQAAAAIAPebLV1MPnfMXAAAAGsAAAAPAAAAc2l0ZS9pbmRleC5odG1sLYsxDoMwEAS/4riHiC7F4R/wCMssOsSZIN+m4PcBJdWMRhp5zO/C80BQVktSwRyK5ubgGD9culdMwpWGVHOR50/F1n0LDTZG52lwBRiDNiz/0hf369QhTfd28QtQSwMEFAAAAAgA95stXRfKoaoXAAAAFQAAAA4AAABzaXRlL3N0eWxlLmNzc8swrE7Oz8kvsipKT9Kw1LE00LHUrAUAUEsDBBQAAAAIAPebLV1SI2NAFgAAABYAAAAaAAAAX19NQUNPU1gvc2l0ZS8uX2luZGV4Lmh0bWwrSi3OLy1KTlVIyy/KVsjLzytOBSIAUEsBAhQDFAAAAAgA95stXUw+d8xcAAAAawAAAA8AAAAAAAAAAAAAAIABAAAAAHNpdGUvaW5kZXguaHRtbFBLAQIUAxQAAAAIAPebLV0XyqGqFwAAABUAAAAOAAAAAAAAAAAAAACAAYkAAABzaXRlL3N0eWxlLmNzc1BLAQIUAxQAAAAIAPebLV1SI2NAFgAAABYAAAAaAAAAAAAAAAAAAACAAcwAAABfX01BQ09TWC9zaXRlLy5faW5kZXguaHRtbFBLBQYAAAAAAwADAMEAAAAaAQAAAAA='

/** A .zip of a two-file site, for the picker check far below. */
const ZIPPED_SITE = 'UEsDBBQAAAAIABuKLV3689fJZgAAAHcAAAAWAAAAemlwcGVkLXNpdGUvaW5kZXguaHRtbCWMQQ7CMAwEvxJ8h4obBye/4AFRupWjuiWKzaG8vgFuMyPt8mV+FT8agvimiTd4DkVyN3ikty/XByX26or0qa1h5ulvrHVfQ4dGMj8UJoBTkI4lUjGbfvU2aBzIPT33lsv63Q85AVBLAwQUAAAACAAbii1dy2v6BhkAAAAXAAAAGQAAAHppcHBlZC1zaXRlL2Nzcy9zdHlsZS5jc3PLMKxOzs/JL7IqSk/SMDTSMTbRMTXTrAUAUEsBAhQDFAAAAAgAG4otXfrz18lmAAAAdwAAABYAAAAAAAAAAAAAAIABAAAAAHppcHBlZC1zaXRlL2luZGV4Lmh0bWxQSwECFAMUAAAACAAbii1dy2v6BhkAAAAXAAAAGQAAAAAAAAAAAAAAgAGaAAAAemlwcGVkLXNpdGUvY3NzL3N0eWxlLmNzc1BLBQYAAAAAAgACAIsAAADqAAAAAAA='

let puppeteer
try {
  puppeteer = (await import('puppeteer-core')).default
} catch {
  console.error('This check needs puppeteer-core:\n\n  npm install puppeteer-core\n')
  process.exit(2)
}

/* -------------------------------------------------------------------------- */

const results = []
/** Every confirm() the gate raised, newest run of checks clearing it as it goes. */
const prompts = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '  ok  ' : ' FAIL '}${name}${detail ? ` — ${detail}` : ''}`)
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const port = await freePort()

// A tracker of our own, for the same reason the gate ships its own service
// worker: the two public wss trackers are the most fragile thing this project
// depends on, and a suite that fails when one of them is having a bad afternoon
// teaches nobody anything. Peer discovery here is local, instant and
// deterministic; what it exercises — WebRTC between browser peers — is the real
// thing either way.
const trackerPort = await freePort()
const tracker = await startTracker(trackerPort)
const trackerURL = `ws://localhost:${trackerPort}`

const server = spawn(process.execPath, [
  fileURLToPath(new URL('serve.mjs', import.meta.url)), String(port),
  ...(tracker ? ['--trackers', trackerURL] : [])
], { stdio: 'ignore' })
const origin = `http://localhost:${port}`

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: flag('--headful') ? false : 'new',
  protocolTimeout: 30_000,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
})

try {
  if (!flag('--only-isolation')) {
    try {
      await run()
    } catch (err) {
      console.error('\nThe check itself broke:', err.stack ?? err.message)
      results.push({ name: 'suite completed', pass: false })
    }
  }
  // Separate, so a failure in either cannot hide the other.
  try {
    await runIsolated()
  } catch (err) {
    console.error('\nThe isolation check itself broke:', err.stack ?? err.message)
    results.push({ name: 'isolation suite completed', pass: false })
  }
} finally {
  await browser.close()
  server.kill()
  tracker?.close?.()
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

/* -------------------------------------------------------------------------- */

async function run () {
  const page = await browser.newPage()
  const console_ = []
  page.on('console', m => console_.push(m.text()))
  page.on('pageerror', e => console_.push('pageerror: ' + e.message))

  // One handler for the whole run: the gate asks before granting anything, and
  // each check clears the flag before the click it cares about.
  page.on('dialog', async dialog => { prompts.push(dialog.message()); await dialog.accept() })

  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20_000 })
  check('the service worker takes control of the gate', true)

  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open',
    { timeout: 20_000 })
  check('the gate boots and the swarm client starts', true)

  // The viewer must fill the window and the status bar must sit on the bottom
  // edge. A `grid-template-rows` list once handed the free space to the status
  // bar instead, collapsing the viewer to the height of its content.
  const layout = await page.evaluate(() => {
    const box = selector => {
      const { top, height } = document.querySelector(selector).getBoundingClientRect()
      return { top: Math.round(top), height: Math.round(height) }
    }
    return { window: window.innerHeight, stage: box('.stage'), statusbar: box('.statusbar') }
  })
  check('the viewer fills the window and the status bar sits at the bottom',
    layout.stage.height > layout.window / 2 &&
    Math.abs(layout.statusbar.top + layout.statusbar.height - layout.window) <= 1,
    JSON.stringify(layout))

  // With nothing open, the viewer must take up no room at all. `.viewer` sets
  // `display: block`, which silently overrode the browser's own
  // `[hidden] { display: none }` — so a blank white iframe filled the page and
  // pushed the welcome screen below the fold, where nobody would find it.
  const home = await page.evaluate(() => {
    const viewer = document.getElementById('viewer')
    const stage = document.querySelector('.stage').getBoundingClientRect()
    const welcome = document.getElementById('welcome').getBoundingClientRect()
    return {
      viewerDisplay: getComputedStyle(viewer).display,
      viewerHeight: Math.round(viewer.getBoundingClientRect().height),
      welcomeStartsInView: Math.round(welcome.top - stage.top),
      choices: document.querySelectorAll('#welcome .choice').length
    }
  })
  check('with nothing open the viewer takes up no space',
    home.viewerDisplay === 'none' && home.viewerHeight === 0, JSON.stringify(home))
  check('the landing page starts at the top of the stage, not below the fold',
    home.welcomeStartsInView === 0, JSON.stringify(home))
  check('the landing page offers both ways in', home.choices === 2, JSON.stringify(home))

  // --- publish -------------------------------------------------------------
  // Feeding the files in directly rather than through a drag-and-drop, which
  // no automation API can synthesise; publish() sees exactly what a drop gives.
  const infoHash = await page.evaluate(async (site, paths) => {
    const files = []
    for (const path of paths) {
      const res = await fetch(`/${site}/${path}`)
      const file = new File([await res.blob()], path.split('/').pop())
      file.fullPath = `${site}/${path}`
      files.push(file)
    }
    const { publish } = await import('/js/publish.js')
    return (await publish(files, site)).infoHash
  }, SITE, SITE_FILES)
  check('a dropped folder is seeded and yields an infohash', /^[0-9a-f]{40}$/.test(infoHash), infoHash)

  // --- open ----------------------------------------------------------------
  await page.evaluate(hash => { location.hash = hash }, infoHash)
  await page.waitForFunction(() => {
    const frame = document.getElementById('viewer')
    return !frame.hidden && frame.src.includes('/webtorrent/')
  }, { timeout: 20_000 })

  const src = await page.$eval('#viewer', f => f.src)
  const entry = src.slice(src.indexOf(infoHash) + infoHash.length + 1)
  check('the viewer opens the entry page the worker serves',
    src.startsWith(`${origin}/webtorrent/${infoHash}/`) && src.endsWith('index.html'), src)

  const sandbox = await page.$eval('#viewer', f => f.getAttribute('sandbox'))
  check('the sandbox grants nothing but same-origin by default',
    sandbox.trim() === 'allow-same-origin', sandbox)

  const site = await siteFrame(page)
  const rendered = await site.evaluate(() => ({
    heading: document.querySelector('h1')?.textContent,
    headingColour: getComputedStyle(document.querySelector('h1')).color,
    imageLoaded: document.images[0]?.complete && document.images[0]?.naturalWidth > 0,
    probe: document.getElementById('probe')?.textContent
  }))
  check('the page renders out of the swarm', rendered.heading === 'Spore', rendered.heading)
  check('a relative stylesheet loads', rendered.headingColour === 'rgb(47, 143, 69)', rendered.headingColour)
  check('a relative image loads', rendered.imageLoaded === true)
  check('scripts do not run by default', rendered.probe === 'Scripts are off.', rendered.probe)

  // --- the policy on the wire ----------------------------------------------
  const headers = await fetchHeaders(page, infoHash, entry)
  const csp = headers['content-security-policy'] ?? ''
  check('CSP: everything is denied unless named', csp.includes("default-src 'none'"))
  check('CSP: no scripts by default', csp.includes("script-src 'none'"))
  check('CSP: no network egress by default', csp.includes("connect-src 'none'"))
  check('CSP: same-origin loads only, so nothing external can be reached',
    csp.includes("img-src 'self' data: blob:") && !/https?:\/\/(?!localhost)/.test(csp))
  check('CSP: the gate may frame the site (WebTorrent would forbid it)',
    csp.includes(`frame-ancestors ${origin}`), csp.match(/frame-ancestors [^;]*/)?.[0])
  check('the entry page is served inline, not as a download',
    !(headers['content-disposition'] ?? '').includes('attachment'), headers['content-disposition'])
  check('the entry page is served as HTML', (headers['content-type'] ?? '').includes('text/html'),
    headers['content-type'])

  // --- egress --------------------------------------------------------------
  // The probes are static markup in example-site: no script is involved, which
  // is the threat this is about. CSP refusals surface as console errors.
  const refusals = console_.filter(line => line.includes('Content Security Policy'))
  check('an off-site image is refused, so plain markup cannot leak the reader',
    refusals.some(line => line.includes('example.invalid')), `${refusals.length} refusals`)
  // The static probe that points into another torrent must come back empty.
  // Its refusal now comes from the worker rather than from a CSP path, and a
  // scriptless page cannot fetch() to inspect the status — that is checked
  // below, once scripts are on and connect-src permits a request at all.
  check('neither probe image loaded',
    await site.evaluate(() => [...document.images].slice(1).every(img => img.naturalWidth === 0)))

  // --- navigation ----------------------------------------------------------
  await site.evaluate(() => document.querySelector('a[href="about.html"]').click()).catch(() => {})
  await wait(3000)
  const second = await (await siteFrame(page)).evaluate(() => document.querySelector('h1')?.textContent)
  check('a relative link opens a second page from the torrent', second === 'How it works', second)

  await page.evaluate(() => {
    const frame = document.getElementById('viewer')
    frame.src = frame.src.replace('about.html', 'index.html')
  })
  await wait(3000)

  // --- opting in to scripts -------------------------------------------------
  prompts.length = 0
  await page.click('#scripts-toggle')
  await wait(500)
  check('turning scripts on asks first',
    prompts.some(text => text.includes("Run this site's scripts?")), prompts[0]?.split('\n')[0])
  // Sites share the gate's origin here, so the question must say that the risk
  // reaches every site and a kept key — not that it stays with this one.
  const warning = prompts.find(text => text.includes("Run this site's scripts?")) ?? ''
  check('and says the risk reaches every site, not just this one',
    /every site/.test(warning) && /publishing key/.test(warning) &&
      !/does not apply to any other site/.test(warning),
    warning.split('\n')[2])

  // Opting in reloads the frame, so poll rather than guess how long that takes.
  const after = await settle(page, () => document.getElementById('probe')?.textContent,
    text => text === 'Scripts are on for this site.')
  check('the script runs once the reader opts in', after === 'Scripts are on for this site.', after)

  const sandboxAfter = await page.$eval('#viewer', f => f.getAttribute('sandbox'))
  // allow-same-origin is not a choice: a sandboxed opaque origin is never
  // served by a service worker. The opt-in adds allow-scripts and nothing else.
  check('the opt-in adds allow-scripts and nothing else',
    sandboxAfter.trim() === 'allow-same-origin allow-scripts', sandboxAfter)

  const cspAfter = (await fetchHeaders(page, infoHash, entry))['content-security-policy']
  check('CSP: egress stays on this origin even with scripts on',
    cspAfter.includes("connect-src 'self'"), cspAfter.match(/connect-src [^;]*/)?.[0])

  // Cross-torrent isolation, checked at its enforcement point. With scripts on
  // the site may fetch its own origin, so this is the strongest case: the
  // worker still has to refuse a read into a torrent that is not this one.
  const scripted = await siteFrame(page)
  const cross = await scripted.evaluate(async () => {
    const other = '0000000000000000000000000000000000000000'
    const own = await fetch('css/site.css').then(r => r.status, e => 'ERR ' + e.message)
    const theirs = await fetch(`../../${other}/pixel.png`).then(r => r.status, e => 'ERR ' + e.message)
    return { own, theirs }
  })
  check('a scripted site may read its own torrent', cross.own === 200, JSON.stringify(cross))
  check('the worker refuses a scripted read into another torrent',
    cross.theirs === 403, JSON.stringify(cross))

  // --- the address bar ------------------------------------------------------
  // Navigating by pasting a magnet must not reload the gate: the fragment is
  // the whole of the navigation, and the swarm client has to survive it.
  const gateLoadedAt = await page.evaluate(() => {
    window.__spore_marker = Date.now()
    return window.__spore_marker
  })
  await page.$eval('#address', (input, value) => { input.value = value }, infoHash)
  await page.click('#address-form button')
  await wait(2000)
  check('the address bar navigates without reloading the gate',
    (await page.evaluate(() => window.__spore_marker)) === gateLoadedAt)

  // --- the permission is stored, and bound to the infohash ------------------
  // Not tested across a page reload: reloading kills this tab's client, and it
  // is the only seed here, so there would be no site left to re-open. What can
  // be checked is that the decision is persisted under the right key and that
  // re-opening the site honours it without asking again.
  const stored = await page.evaluate(() => localStorage.getItem('spore.scripts-allowed'))
  check('the permission is stored against the infohash, not a name',
    JSON.parse(stored ?? '[]').includes(infoHash), stored)

  prompts.length = 0
  await page.evaluate(() => { location.hash = '' })
  await wait(1000)
  await page.evaluate(hash => { location.hash = hash }, infoHash)
  const reopened = await settle(page, () => document.getElementById('probe')?.textContent,
    text => text === 'Scripts are on for this site.')
  check('re-opening the site keeps scripts on without asking again',
    reopened === 'Scripts are on for this site.' && prompts.length === 0, reopened)

  await checkKeepingOffline(page, infoHash)
  await checkPublishingByDrop(page)
  await checkPublishingFromThePicker(page)
  await checkSignatureLandsWhereReadersLook()
  await checkAFolderCompressedOnAMac()
  await checkRepublishing()
  await checkEveryShapeAgrees()
  await checkTheSeederSurvivesARestart()
  await checkOurSha256()
  await checkJunkRulesMatchTheLibrary()
  await checkShapesNobodyChose()
  await checkAnArchiveWithTooManyFiles()
  await checkAnArchiveTooBigToHold()
  await checkSurvivesDeadStorage(page)
  await checkStuckViewerIsDetected(page)
  await checkUncontrolledPageRecovers(page)
  await checkMissingSiteAndHome(page)
  await checkKeptSiteSurvivesReload(page)
  await checkTorrentWithoutIndex(page)
  await checkSigningCore(page)
  await checkUpdateOverTheWire()
  await checkUpdateOffer()
  await checkPublishingASuccessor()
  await checkRememberedKey()
  await checkSlowSwarm()
  await checkMobileLayout()
  await checkLateFailureIsVisible()
  await checkContentSignature()
  await checkKeptSiteHearsUpdates()
  await checkReadersPassItOn()
  await checkWorkerIsPutBack()
  await checkSandboxProbe()
}

/**
 * The other two ways in: an ordinary file picker, and a .zip through it.
 *
 * This is the path that exists on devices with no directory picker at all, so
 * it is checked in a browser rather than reasoned about — and the archive is
 * unpacked by the gate's own reader, with `DecompressionStream`, no library.
 *
 * It also pins down the rule that publishing and reading now share. The gate
 * used to refuse to publish anything without an `index.html`, while the viewer
 * was perfectly happy to render a lone page under any other name: it would not
 * let you publish a site it could open. One page under any name publishes; a
 * set with no entry asks first, because it renders as a list of files.
 */

async function checkPublishingFromThePicker (page) {
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  check('the landing page offers a file picker beside the folder one',
    await page.$eval('#files-input', input => input.type === 'file' && input.multiple &&
      !input.hasAttribute('webkitdirectory')))

  // Measured at the width this runs at, because the phone check passed while
  // the desktop layout had the two buttons overlapping by eight pixels: padding
  // on an inline element paints outside its line box without making the line
  // taller, which is invisible until there are two of them.
  const pickers = await page.evaluate(() => [...document.querySelectorAll('.pick .button')]
    .map(el => {
      const box = el.getBoundingClientRect()
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), w: Math.round(box.width) }
    }))
  check('the two pickers are a column of equal buttons that do not touch',
    pickers.length === 2 && pickers[1].top - pickers[0].bottom >= 4 &&
    pickers[0].w === pickers[1].w, JSON.stringify(pickers))

  // Reachable without a mouse. `hidden` on the input took both pickers out of
  // the focus order entirely: the label is not focusable and a span is not a
  // control, so a keyboard could not open either one and a screen reader was
  // offered nothing to press.
  const reachable = await page.evaluate(() => {
    const out = []
    for (const id of ['folder-input', 'files-input']) {
      const input = document.getElementById(id)
      input.focus()
      const label = input.closest('label')
      out.push({
        id,
        focused: document.activeElement === input,
        named: (label?.textContent ?? '').trim().length > 0,
        painted: getComputedStyle(label).outlineStyle !== 'none'
      })
    }
    return out
  })
  check('both pickers can be reached and pressed without a mouse',
    reachable.every(r => r.focused && r.named), JSON.stringify(reachable))
  check('and focusing one is visible, since the label is what looks like a button',
    reachable.every(r => r.painted), JSON.stringify(reachable))

  // Every reader downloads the gate and most never publish anything, so the
  // archive reader is meant to arrive only when an archive does. Checked rather
  // than asserted in a comment, because a static import would satisfy every
  // other check in this file while quietly making it a lie.
  const loadedBefore = await page.evaluate(() => performance.getEntriesByType('resource')
    .some(entry => entry.name.endsWith('/js/zip.js')))
  check('the archive reader is not in a reader\u2019s module graph', !loadedBefore)

  // --- a .zip, with a folder inside it --------------------------------------
  const before = await page.$eval('#share-link', input => input.value)
  await pick(page, [{ name: 'zipped-site.zip', type: 'application/zip', base64: ZIPPED_SITE }])

  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  check('an archive is unpacked and reaches the signing question, like a folder', true)
  await page.click('#signin-skip')

  const link = await settled(page, before)
  check('a .zip publishes and yields a shareable link',
    link.includes('#magnet:?xt=urn:btih:') && link !== before, link.slice(0, 70))

  const unpacked = await (await siteFrame(page)).evaluate(() => ({
    heading: document.querySelector('h1')?.textContent,
    colour: getComputedStyle(document.querySelector('h1')).color
  }))
  check('the unpacked site renders out of the swarm', unpacked.heading === 'Unpacked', unpacked.heading)
  check('and it arrived the moment an archive did',
    await page.evaluate(() => performance.getEntriesByType('resource')
      .some(entry => entry.name.endsWith('/js/zip.js'))))
  // The archive's root folder must be stripped exactly as a drop strips it, or
  // `css/style.css` resolves one level too deep and the page loads unstyled.
  check('a subdirectory inside the archive survives, so relative links resolve',
    unpacked.colour === 'rgb(12, 34, 56)', unpacked.colour)

  // --- one page, named whatever its author called it ------------------------
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  await pick(page, [{ name: 'il-mio-post.html', type: 'text/html', text: '<h1>Un post</h1>' }])
  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  check('a single page under any name publishes, as the viewer always rendered it',
    !(await page.$eval('#no-entry-dialog', d => d.open)))
  await page.click('#signin-skip')

  await settled(page, '')
  check('and it opens as the site, not as a file list',
    await (await siteFrame(page)).evaluate(() => document.querySelector('h1')?.textContent) === 'Un post')

  // --- an archive whose comment looks like the end of the archive -----------
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  const beforeComment = await page.$eval('#share-link', input => input.value)
  await pick(page, [{ name: 'commented.zip', type: 'application/zip', base64: COMMENTED_ZIP }])
  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await page.click('#signin-skip')
  await settled(page, beforeComment)
  check('a trailing comment containing the end-of-directory signature does not fool the reader',
    await (await siteFrame(page)).evaluate(() => document.querySelector('h1')?.textContent) === 'Commented')

  // --- two entries at one path ---------------------------------------------
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  await pick(page, [{ name: 'duplicate.zip', type: 'application/zip', base64: DUPLICATE_PATHS }])
  await page.waitForFunction(
    () => !document.getElementById('error').hidden, { timeout: 20_000 })
  const refused = await page.$eval('#error-detail', el => el.textContent)
  // Not a layout complaint: spore.sig would list the path twice with two
  // hashes, a verifier would check the first and the worker could serve the
  // second, and the site would read as verified while showing unchecked bytes.
  check('two entries at one path are refused before anything can be signed',
    refused.includes('index.html twice'), refused.slice(0, 80))
  check('and the signing question was never asked',
    await page.$eval('#signin-dialog', d => !d.open))

  // The same thing without an archive. A picker can be talked into handing over
  // two files of one name, so the guard lives where every way in passes, not
  // only in the zip reader.
  await page.click('#error-home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  await pick(page, [
    { name: 'index.html', type: 'text/html', text: '<h1>primo</h1>' },
    { name: 'index.html', type: 'text/html', text: '<h1>secondo</h1>' }
  ])
  await page.waitForFunction(
    () => !document.getElementById('error').hidden, { timeout: 20_000 })
  check('and two picked files of one name are refused too, archive or not',
    (await page.$eval('#error-detail', el => el.textContent)).includes('two files called index.html'))

  // A refused publish leaves the error page up, and clearing an already-empty
  // fragment fires no hashchange, so the way back is the button that is there
  // for it. Clicking it is also the only way to know the button works.
  await page.click('#error-home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  check('the way back from a refused archive is one click', true)

  // --- everything the reader must refuse, and why ---------------------------
  for (const archive of REFUSED_ARCHIVES) {
    await page.click('#error-home').catch(() => {})
    await page.evaluate(() => { location.hash = '' })
    await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

    await pick(page, [{ name: archive.file, type: 'application/zip', base64: archive.base64 }])
    await page.waitForFunction(
      () => !document.getElementById('error').hidden, { timeout: 20_000 })

    const said = await page.$eval('#error-detail', el => el.textContent)
    check(`an archive is refused: ${archive.name.toLowerCase().replace(/_/g, ' ')}`,
      said.includes(archive.because) &&
      await page.$eval('#signin-dialog', d => !d.open),
      said.slice(0, 70))
  }

  // --- a refused archive dropped rather than picked -------------------------
  await page.click('#error-home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  const corrupt = REFUSED_ARCHIVES.find(a => a.name === 'CORRUPT')
  await page.evaluate(b64 => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))],
      'corrupt.zip', { type: 'application/zip' }))
    document.body.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  }, corrupt.base64)
  // The drop handler unpacks too, and that rejection used to go unhandled: the
  // page did nothing at all, which is the worst of the available answers.
  await page.waitForFunction(
    () => !document.getElementById('error').hidden, { timeout: 20_000 })
  check('a refused archive says so when it is dropped, not only when it is picked',
    (await page.$eval('#error-detail', el => el.textContent)).includes(corrupt.because))

  // --- backing out of signing hands the screen back -------------------------
  await page.click('#error-home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  await pick(page, [{ name: 'cancelled.html', type: 'text/html', text: '<h1>nope</h1>' }])
  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await page.click('#signin-cancel')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  check('cancelling the signing question gives the drop zone back',
    await page.$eval('#notice', el => el.hidden))

  // --- no entry page at all: a question, not a refusal ----------------------

  await pick(page, [
    { name: 'one.html', type: 'text/html', text: '<h1>one</h1>' },
    { name: 'two.html', type: 'text/html', text: '<h1>two</h1>' }
  ])
  await page.waitForFunction(
    () => document.getElementById('no-entry-dialog').open, { timeout: 20_000 })
  check('files with no entry page raise a warning before anything is hashed', true)
  check('the warning names the files it is talking about',
    (await page.$eval('#no-entry-files', list => list.textContent)).includes('one.html'))

  const unchanged = await page.$eval('#share-link', input => input.value)
  await page.click('#no-entry-cancel')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  // Going back must cost nothing: no signature asked for, no torrent made, and
  // the landing page — which is also the drop zone — back in reach.
  await wait(1500)
  const after = await page.evaluate(() => ({
    signing: document.getElementById('signin-dialog').open,
    welcome: !document.getElementById('welcome').hidden,
    link: document.getElementById('share-link').value
  }))
  check('going back publishes nothing and leaves the drop zone in reach',
    !after.signing && after.welcome && after.link === unchanged, JSON.stringify(after).slice(0, 90))

  // --- and the other answer, which is a real thing to publish ---------------
  await pick(page, [
    { name: 'one.html', type: 'text/html', text: '<h1>one</h1>' },
    { name: 'two.html', type: 'text/html', text: '<h1>two</h1>' }
  ])
  await page.waitForFunction(
    () => document.getElementById('no-entry-dialog').open, { timeout: 20_000 })
  await page.click('#no-entry-accept')

  // Signing is not offered here, and that is the point: a reader's check reads
  // the signature from beside the entry page, and there is none, so a signed
  // file list would read as unsigned to everyone including its author.
  await wait(1500)
  check('a file list is not offered a signature nobody could check',
    await page.$eval('#signin-dialog', d => !d.open))

  await page.waitForFunction(
    () => !document.getElementById('listing').hidden, { timeout: 40_000 })
  const listed = await page.evaluate(() => ({
    files: [...document.querySelectorAll('#listing-files a, #listing-files li')]
      .map(el => el.textContent.trim()).join(' '),
    summary: document.getElementById('listing-summary').textContent
  }))
  check('publishing it as a file list really produces one, and readers get it',
    listed.files.includes('one.html') && listed.files.includes('two.html'),
    JSON.stringify(listed).slice(0, 100))
}

/**
 * Wait for a publish to land, and say what went wrong if it does not.
 *
 * A bare wait for the viewer reports "30000ms exceeded", which names the
 * symptom and hides every cause. Publishing ends in one of three places, and
 * two of them are on screen already.
 */
async function settled (page, before) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await page.evaluate(previous => {
      const link = document.getElementById('share-link').value
      const shown = !document.getElementById('share').hidden && link !== previous
      const frame = document.getElementById('viewer')
      if (shown && !frame.hidden && frame.src.includes('/webtorrent/')) return { link }

      if (!document.getElementById('error').hidden) {
        return {
          failed: `${document.getElementById('error-title').textContent}: ` +
            document.getElementById('error-detail').textContent
        }
      }
      return null
    }, before)

    if (state?.failed) throw new Error(`publishing failed — ${state.failed}`)
    if (state) return state.link
    await wait(200)
  }
  const stuck = await page.evaluate(() => ({
    notice: document.getElementById('notice').hidden ? null : document.getElementById('notice').textContent,
    share: document.getElementById('share').hidden,
    link: document.getElementById('share-link').value.slice(0, 70),
    frame: document.getElementById('viewer').src.slice(0, 70),
    listing: !document.getElementById('listing').hidden,
    hash: location.hash.slice(0, 70)
  }))
  throw new Error(`publishing never settled — ${JSON.stringify(stuck)}`)
}

/** Put files into the ordinary picker the way a person would. */
async function pick (page, files) {
  await page.evaluate(async items => {
    const data = new DataTransfer()
    for (const item of items) {
      const bytes = item.base64
        ? Uint8Array.from(atob(item.base64), c => c.charCodeAt(0))
        : item.text
      data.items.add(new File([bytes], item.name, { type: item.type }))
    }
    const input = document.getElementById('files-input')
    input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, files)
}

/**
 * Where a signature is put has to match where a reader looks for it.
 *
 * `spore.pub` and `spore.sig` sit beside the entry page, and `readSporePub`
 * derives that from the page the viewer actually opened — the shallowest
 * `index.html`. Signing derived its own root separately, from the first
 * `index.html` in array order, and an archive controls that order. The two
 * agreed on every folder anyone had tried and disagreed on this one, which
 * publishes a correctly signed site that reads as unsigned to everybody,
 * its author included.
 */
async function checkSignatureLandsWhereReadersLook () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  await pick(page, [{ name: 'ordered.zip', type: 'application/zip', base64: ORDERED_ZIP }])
  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })

  await page.type('#signin-label', 'Ordered')
  await page.type('#signin-passphrase', 'a phrase long enough to be a real one')
  await page.click('#signin-continue')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-confirm').hidden, { timeout: 30_000 })
  await page.click('#signin-use')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-choose').hidden, { timeout: 30_000 })
  await page.select('#signin-series', '\u0000new')
  await page.type('#signin-new-series', 'ordered')
  await page.click('#signin-use-known')

  const link = await settled(page, '')
  const hash = /btih:([0-9a-f]{40})/.exec(link ?? '')?.[1]

  const paths = await page.evaluate(async infoHash => {
    const { getClient } = await import('/js/swarm.js')
    return (await getClient().get(infoHash)).files.map(file => file.path)
  }, hash)

  const entry = await page.evaluate(async infoHash => {
    const { getClient } = await import('/js/swarm.js')
    const { findEntry } = await import('/js/site.js')
    return findEntry(await getClient().get(infoHash))
  }, hash)

  const rootOf = path => path.slice(0, path.lastIndexOf('/') + 1)
  const signature = paths.find(path => /spore\.pub$/.test(path))

  check('the signature is written beside the page readers actually open',
    signature && rootOf(signature) === rootOf(entry),
    JSON.stringify({ entry, signature }))

  // And the reader agrees, which is the thing that was broken: the key was
  // present in the torrent and invisible to everyone.
  const named = await page.evaluate(async infoHash => {
    const { getClient } = await import('/js/swarm.js')
    const { findEntry, readSporePub } = await import('/js/site.js')
    const torrent = await getClient().get(infoHash)
    return Boolean(await readSporePub(torrent, findEntry(torrent)))
  }, hash)
  check('so a reader opening it finds a key rather than "unsigned"', named)

  await page.close()
}

/**
 * A folder compressed on a Mac, which is two top levels rather than one.
 *
 * `__MACOSX/` is resource forks, not content, and macOS writes it beside
 * anything its Compress command touches. Left in, the archive has no
 * `index.html` in its root, so a folder compressed the ordinary way on the
 * commonest desktop would open as a list of files instead of as a site. It is
 * dropped by name — the one piece of rubbish common enough to earn a rule.
 */
async function checkAFolderCompressedOnAMac () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  await pick(page, [{ name: 'site.zip', type: 'application/zip', base64: MAC_STYLE_ZIP }])
  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })

  await page.type('#signin-label', 'Mac')
  await page.type('#signin-passphrase', 'another long enough phrase to sign with')
  await page.click('#signin-continue')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-confirm').hidden, { timeout: 30_000 })
  await page.click('#signin-use')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-choose').hidden, { timeout: 30_000 })
  await page.select('#signin-series', '\u0000new')
  await page.type('#signin-new-series', 'mac')
  await page.click('#signin-use-known')

  const link = await settled(page, '')
  const hash = /btih:([0-9a-f]{40})/.exec(link ?? '')?.[1]

  const paths = await page.evaluate(async infoHash => {
    const { getClient } = await import('/js/swarm.js')
    return (await getClient().get(infoHash)).files.map(file => file.path)
  }, hash)

  check('a folder compressed on a Mac opens as a site, not as a list of files',
    paths.some(path => /^[^/]+\/index\.html$/.test(path)), JSON.stringify(paths))
  check('and the resource forks are not published with it',
    !paths.some(path => path.includes('__MACOSX')), JSON.stringify(paths))

  await page.waitForFunction(
    () => !document.getElementById('author').hidden, { timeout: 30_000 })
  await page.waitForFunction(
    () => document.getElementById('author').dataset.state !== 'checking', { timeout: 30_000 })
  check('and it reads as verified, not as tampered with',
    await page.$eval('#author', el => el.dataset.state) === 'verified',
    await page.$eval('#author', el => el.dataset.state))

  await page.close()
}

/**
 * What the gate does with a publication that arrives already claiming an author.
 *
 * Two outcomes and no third: either it verifies exactly as it stands and is
 * republished untouched — still its author's, which is what a mirror is — or
 * its key and signature are thrown away and the publisher signs their own.
 * Everything in between produced a site that accused itself of being altered.
 */
async function checkRepublishing () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  // --- the rules a site is held to, asked directly ---------------------------
  // One rule, not a search: `index.html` in the site's root and nowhere else,
  // and a single page becomes it whatever the author called it. What used to be
  // here looked for the shallowest index.html anywhere in the tree, and that
  // flexibility was where the publisher and the reader learned to disagree.
  const rules = await page.evaluate(async () => {
    const { asSite, entryFor } = await import('/js/site.js')
    const file = path => Object.assign(new File(['x'], path.split('/').pop(),
      { type: 'text/html' }), { fullPath: path })

    const ask = paths => {
      const site = asSite(paths.map(file))
      return { entry: entryFor(site.files), renamed: site.renamed?.to ?? null }
    }
    return {
      folder: ask(['site/index.html', 'site/css/a.css']),
      onePage: ask(['il-mio-post.html']),
      pageAndAsset: ask(['post.html', 'photo.jpg']),
      nested: ask(['site/docs/index.html', 'site/a.css']),
      wrapped: ask(['site/docs/index.html', 'site/docs/a.css']),
      twoPages: ask(['one.html', 'two.html']),
      twoFolders: ask(['site/index.html', 'other/x.txt'])
    }
  })

  // Always bare: `asSite` has made every path relative to the site's root, which
  // is what leaves `create-torrent` nothing to strip and therefore leaves the
  // list that gets signed and the list that gets published identical.
  check('a folder with index.html at its top is the site, at the top',
    rules.folder.entry === 'index.html', JSON.stringify(rules.folder))
  check('a single page becomes index.html, whatever it was called',
    rules.onePage.entry === 'index.html' && rules.onePage.renamed === 'index.html',
    JSON.stringify(rules.onePage))
  check('and so does a page with its own images beside it',
    rules.pageAndAsset.entry === 'index.html', JSON.stringify(rules.pageAndAsset))
  // A folder that wraps *everything* comes off; one that wraps only the page
  // does not, because a sibling is already at the root. So this is a list, and
  // the reader agrees — which is the only thing that has to be true.
  check('an index.html deeper than its siblings is not the entry',
    rules.nested.entry === null, JSON.stringify(rules.nested))
  check('but folders wrapping the whole site come off, however many',
    rules.wrapped.entry === 'index.html', JSON.stringify(rules.wrapped))
  check('two pages and no index is a list of files, not a guess',
    rules.twoPages.entry === null, JSON.stringify(rules.twoPages))

  // Two folders dropped at once. BitTorrent wraps them in a third, so the entry
  // ends up two deep and the reader shows a list — and the publisher used to
  // see an entry here and sign something nobody would ever check.
  check('and two folders at once agree with what the reader will see: a list',
    rules.twoFolders.entry === null, JSON.stringify(rules.twoFolders))

  // --- a folder that was nothing but leftovers --------------------------------
  // checkPublishable runs before the junk is dropped, so a folder holding only
  // a .DS_Store used to pass it, reach an empty "there is no page" dialog, and
  // fail at "Hashing 0 files…" — the late failure the early check exists to
  // prevent.
  await page.click('#error-home').catch(() => {})
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  await pick(page, [{ name: '.DS_Store', type: 'application/octet-stream', text: 'Bud1' }])
  await page.waitForFunction(
    () => !document.getElementById('error').hidden, { timeout: 20_000 })
  const onlyJunk = await page.$eval('#error-detail', el => el.textContent)
  check('a folder that held nothing but leftovers says so at once',
    onlyJunk.includes('.DS_Store') && onlyJunk.includes('nothing else here'),
    onlyJunk.slice(0, 80))
  check('and it never reached the signing question',
    await page.$eval('#signin-dialog', d => !d.open))

  // --- two publications at once -----------------------------------------------
  // Drops are wired to the window and an open dialog does not make it inert, so
  // a folder dropped onto the signing question started a second publish, called
  // showModal on an already-open dialog, threw, and left the first waiting on a
  // promise that could never settle.
  await page.click('#error-home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  await pick(page, [{ name: 'first.html', type: 'text/html', text: '<h1>first</h1>' }])
  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })

  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['<h1>second</h1>'], 'index.html', { type: 'text/html' }))
    document.body.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await wait(800)

  const both = await page.evaluate(() => ({
    stillAsking: document.getElementById('signin-dialog').open,
    told: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent
  }))
  check('a second publication started over the first is refused, not tangled with it',
    both.stillAsking && both.told.includes('already on its way'), JSON.stringify(both).slice(0, 90))

  await page.click('#signin-dismiss')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  check('and the first one can still be answered afterwards',
    await page.$eval('#signin-dialog', d => !d.open))

  // --- the size a signature may be, agreed on both sides ---------------------
  // The reader refuses a spore.sig too large to be one, because it is reading a
  // stranger's torrent. The publisher has to refuse to make one, or an honest
  // site with thousands of files goes out correctly signed and shows as
  // unsigned to everybody, with nothing anywhere saying why. The old reader
  // limit was half a megabyte, which a photo gallery passes.
  const manifest = await page.evaluate(async () => {
    const { manifestWouldExceed, MAX_MANIFEST_BYTES } = await import('/js/manifest.js')
    const paths = (n, len) => Array.from({ length: n }, (_, i) => `p/${i}`.padEnd(len, 'x'))
    return {
      cap: MAX_MANIFEST_BYTES,
      gallery: manifestWouldExceed(paths(5_000, 30)),
      bigSite: manifestWouldExceed(paths(40_000, 22)),
      absurd: manifestWouldExceed(paths(100_000, 20))
    }
  })
  check('a site with thousands of files can still be signed',
    !manifest.gallery && !manifest.bigSite, JSON.stringify(manifest))
  check('and one whose signature no reader would open is not offered the chance',
    manifest.absurd, JSON.stringify(manifest))

  // The arithmetic, at its own boundary. The estimate allowed 256 bytes for the
  // header and the real one is up to 244, and the caller adds a `spore.pub`
  // line after asking — so fifty-odd thousand short paths passed the check and
  // produced a signature a hair over four million, which every reader refuses
  // on size. Signed, and silently unsigned. What has to hold is not "the
  // estimate is close" but "the estimate is never optimistic".
  const boundary = await page.evaluate(async () => {
    const { manifestWouldExceed, signManifest, MAX_MANIFEST_BYTES } =
      await import('/js/manifest.js')
    const { identityFromPassphrase } = await import('/js/identity.js')
    const me = await identityFromPassphrase('a passphrase for the boundary check')

    const fits = n => !manifestWouldExceed(
      [...Array.from({ length: n }, (_, i) => `p/${i}`), 'spore.pub', 'spore.sig'])

    let low = 1000
    let high = 200_000
    while (low < high) {
      const mid = (low + high) >> 1
      if (fits(mid)) low = mid + 1; else high = mid
    }

    const paths = Array.from({ length: low - 1 }, (_, i) => `p/${i}`).concat('spore.pub')
    const signature = await signManifest(me.privateKey, {
      key: me.hex,
      site: 's'.repeat(60), // the longest series name the format allows for
      entries: paths.map(path => ({ path, hash: 'a'.repeat(64) }))
    })
    return { accepted: low - 1, bytes: signature.length, cap: MAX_MANIFEST_BYTES }
  })

  check('the largest set the gate will sign really does fit what a reader reads',
    boundary.bytes <= boundary.cap,
    `${boundary.accepted} files -> ${boundary.bytes} of ${boundary.cap}`)

  // The publisher's "does this already verify?" has to apply the reader's own
  // limits, or it republishes untouched a site every reader shows as unsigned.
  const limits = await page.evaluate(async () => {
    const { MAX_KEY_BYTES } = await import('/js/identity.js')
    const { MAX_MANIFEST_BYTES } = await import('/js/manifest.js')
    const source = await (await fetch('/js/app.js')).text()
    const fn = source.slice(source.indexOf('async function verifiesAsItStands'))
      .slice(0, source.slice(source.indexOf('async function verifiesAsItStands')).indexOf('\n}\n'))
    return {
      key: MAX_KEY_BYTES,
      manifest: MAX_MANIFEST_BYTES,
      applied: fn.includes('MAX_KEY_BYTES') && fn.includes('MAX_MANIFEST_BYTES')
    }
  })
  check('and the publisher weighs a signature by the reader\u2019s limits, not its own',
    limits.applied && limits.key === 4096 && limits.manifest === 4_000_000,
    JSON.stringify(limits))

  // --- somebody else's key, without a signature that stands up ---------------
  // Two outcomes and no third. This is the second one: the declaration does not
  // verify, so it is thrown away and the publisher's own takes its place. The
  // first outcome — a publication that verifies exactly as it arrived — is
  // checked below, on a site this suite actually signed.
  const theirKey = 'f'.repeat(64)
  await pick(page, [
    { name: 'index.html', type: 'text/html', text: '<h1>a mirror</h1>' },
    { name: 'spore.pub', type: 'text/plain', text: `${theirKey}\nname=Somebody Else\n` }
  ])

  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await page.type('#signin-label', 'Mirroring')
  await page.type('#signin-passphrase', 'a passphrase belonging to whoever mirrors')
  await page.click('#signin-continue')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-confirm').hidden, { timeout: 30_000 })
  await page.click('#signin-use')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-choose').hidden, { timeout: 30_000 })
  await page.select('#signin-series', '\u0000new')
  await page.type('#signin-new-series', 'mirror')
  await page.click('#signin-use-known')

  const mirrored = await settled(page, '')
  const declared = await page.evaluate(async link => {
    const { getClient } = await import('/js/swarm.js')
    const torrent = await getClient().get(/btih:([0-9a-f]{40})/.exec(link)[1])
    const file = torrent.files.find(f => /spore\.pub$/.test(f.path))
    return {
      paths: torrent.files.map(f => f.path),
      key: new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
    }
  }, mirrored)

  check('a key that carries no signature that stands up is thrown away',
    !declared.key.includes(theirKey), declared.key.split('\n')[0].slice(0, 20))
  check('and the publisher signs it as their own instead',
    declared.paths.some(path => /spore\.sig$/.test(path)), JSON.stringify(declared.paths))

  // --- and the first outcome: a publication that still verifies ---------------
  // Taken out of the torrent the check above just signed, and handed back in.
  // This is the round trip a mirror is: nobody is asked for a passphrase,
  // because the site is already somebody's and is not about to become anybody
  // else's.
  const theirs = await page.evaluate(async link => {
    const { getClient } = await import('/js/swarm.js')
    const torrent = await getClient().get(/btih:([0-9a-f]{40})/.exec(link)[1])
    const out = []
    for (const file of torrent.files) {
      out.push({
        name: file.path.slice(file.path.indexOf('/') + 1),
        bytes: [...new Uint8Array(await file.arrayBuffer())]
      })
    }
    return out
  }, mirrored)

  await page.evaluate(files => {
    document.getElementById('share-unsigned').hidden = true
    const data = new DataTransfer()
    for (const file of files) {
      data.items.add(new File([new Uint8Array(file.bytes)], file.name))
    }
    const input = document.getElementById('files-input')
    input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, theirs)

  // Not a new link: an identical one. A publication that is not touched hashes
  // to what it hashed before, which is the strongest thing a mirror can say —
  // the copy is the original, not a copy of it.
  await page.waitForFunction(
    () => !document.getElementById('share-unsigned').hidden, { timeout: 40_000 })

  const untouched = await page.evaluate(async link => {
    const { getClient } = await import('/js/swarm.js')
    const torrent = await getClient().get(/btih:([0-9a-f]{40})/.exec(link)[1])
    const file = torrent.files.find(f => /spore\.pub$/.test(f.path))
    return {
      asked: document.getElementById('signin-dialog').open,
      said: document.getElementById('share-unsigned').textContent,
      link: document.getElementById('share-link').value,
      key: new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
    }
  }, mirrored)

  check('a publication that still verifies is republished without being asked about',
    !untouched.asked, String(untouched.asked))
  // Identical here because both publishes reach the torrent by the same route
  // and so compute the same torrent name, which is part of the infohash. The
  // files are what is guaranteed untouched; the hash follows only when the name
  // does too.
  check('and its files are untouched, so by this route it hashes the same',
    untouched.link === mirrored, `${untouched.link.slice(-20)} vs ${mirrored.slice(-20)}`)
  check('and it keeps the key it arrived with, rather than the publisher\u2019s',
    untouched.key.split('\n')[0] === declared.key.split('\n')[0],
    untouched.key.split('\n')[0].slice(0, 20))
  check('and the publisher is told it stayed its author\u2019s',
    untouched.said.includes('still its author'), untouched.said.slice(0, 60))

  // --- a folder the Finder has touched ---------------------------------------
  // `.DS_Store` sits in essentially every folder macOS has ever opened, and
  // create-torrent drops it silently — after `spore.sig` has already hashed it.
  // The manifest then described a file the torrent did not contain, and every
  // reader, the author included, was told the site had been altered.
  const withJunk = await page.$eval('#share-link', input => input.value)
  await pick(page, [
    { name: 'index.html', type: 'text/html', text: '<h1>touched by finder</h1>' },
    { name: '.DS_Store', type: 'application/octet-stream', text: 'Bud1\u0000junk' }
  ])
  await page.waitForFunction(
    () => !document.getElementById('signin-step-choose').hidden, { timeout: 20_000 })
  await page.select('#signin-series', '\u0000new')
  await page.type('#signin-new-series', 'finder')
  await page.click('#signin-use-known')

  const tidied = await settled(page, withJunk)
  const kept = await page.evaluate(async link => {
    const { getClient } = await import('/js/swarm.js')
    const torrent = await getClient().get(/btih:([0-9a-f]{40})/.exec(link)[1])
    return torrent.files.map(f => f.path)
  }, tidied)
  check('a folder the Finder has touched publishes without its leftovers',
    !kept.some(path => path.includes('.DS_Store')), JSON.stringify(kept))

  await page.waitForFunction(
    () => !document.getElementById('author').hidden, { timeout: 30_000 })
  await page.waitForFunction(
    () => document.getElementById('author').dataset.state !== 'checking', { timeout: 30_000 })
  check('and it reads as verified rather than as tampered with',
    await page.$eval('#author', el => el.dataset.state) === 'verified',
    await page.$eval('#author', el => el.dataset.state))
  check('and the publisher is told what was left out',
    (await page.$eval('#share-unsigned', el => el.hidden ? '' : el.textContent)).includes('.DS_Store'))

  // --- a site that has already been signed once ------------------------------
  // The folder somebody re-publishes is the one they downloaded, or the one a
  // seeder wrote its version into, and both carry a spore.sig. Signing appended
  // a second one beside it, two files landed at one path, and the duplicate
  // guard refused the whole publish: a site that had ever been signed could
  // never be published again.
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  const beforeAgain = await page.$eval('#share-link', input => input.value)
  await pick(page, [
    { name: 'index.html', type: 'text/html', text: '<h1>again</h1>' },
    { name: 'spore.sig', type: 'text/plain', text: 'spore-sig/1\nkey=' + 'a'.repeat(64) + '\nsig=b\n' }
  ])
  // This tab is signed in already, so the dialog opens at the step that asks
  // which site this is, not at the one that asks who you are.
  await page.waitForFunction(
    () => !document.getElementById('signin-step-choose').hidden, { timeout: 20_000 })
  await page.select('#signin-series', '\u0000new')
  await page.type('#signin-new-series', 'again')
  await page.click('#signin-use-known')

  // Waited for the link to *change*: a share panel left open by the publish
  // before this one made "published" true before anything had happened, and the
  // check then read the previous torrent and failed for the wrong reason.
  let againLink = null
  let refusedWhy = null
  try {
    againLink = await settled(page, beforeAgain)
  } catch (err) {
    refusedWhy = err.message
  }
  check('a site that was already signed can be published again',
    Boolean(againLink), refusedWhy ?? '')
  // The wording matters: a refused publish used to be announced as a site
  // failing to open, to somebody who had not asked for a site.
  if (refusedWhy) {
    check('and a refused publish is described as a publish, not as a failed read',
      !refusedWhy.includes('could not be opened'), refusedWhy.slice(0, 70))
  }

  const resigned = againLink === null ? [] : await page.evaluate(async link => {
    const { getClient } = await import('/js/swarm.js')
    const torrent = await getClient().get(/btih:([0-9a-f]{40})/.exec(link)[1])
    return torrent.files.map(f => f.path)
  }, againLink)
  check('and it carries one signature, not the old one and a new one',
    resigned.filter(path => /spore\.sig$/.test(path)).length === 1, JSON.stringify(resigned))

  await page.close()
}

/**
 * The thing a BitTorrent client is for: something too big to hold.
 *
 * The reader used to read the whole archive with `arrayBuffer()` and then
 * materialise every entry, so it needed a ceiling — and the ceiling was a
 * number that would have refused a film, in a client whose own file listing
 * exists so that "a video plays". The ceiling was covering an implementation,
 * not protecting anybody: the folder and picker paths never had one, because
 * WebTorrent reads a File from disk in pieces.
 *
 * A stored entry is the author's bytes verbatim, so it is handed over as a
 * slice of the file on disk and never becomes memory. The archive built here is
 * larger than every cap this branch ever carried.
 */
async function checkAnArchiveTooBigToHold () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 60_000 })

  // Built in the page rather than shipped: seventy megabytes of base64 does not
  // belong in a source file, and a stored zip is a header, the bytes, and an
  // index, which is short enough to write here.
  const built = await page.evaluate(async megabytes => {
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
    const crc32 = bytes => {
      let crc = 0xffffffff
      for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
      return (crc ^ 0xffffffff) >>> 0
    }

    // Incompressible on purpose, which is also why a real mp4 is stored.
    const movie = new Uint8Array(megabytes * 1024 * 1024)
    for (let i = 0; i < movie.length; i++) movie[i] = (i * 2654435761) & 0xff

    const page = new TextEncoder().encode(
      '<!doctype html><meta charset="utf-8"><title>film</title><h1>Film</h1>')

    const parts = []
    const central = []
    let offset = 0

    for (const [name, bytes] of [['film/index.html', page], ['film/movie.mp4', movie]]) {
      const nameBytes = new TextEncoder().encode(name)
      const crc = crc32(bytes)

      const local = new DataView(new ArrayBuffer(30))
      local.setUint32(0, 0x04034b50, true)
      local.setUint16(4, 20, true)
      local.setUint16(8, 0, true) // stored
      local.setUint32(14, crc, true)
      local.setUint32(18, bytes.length, true)
      local.setUint32(22, bytes.length, true)
      local.setUint16(26, nameBytes.length, true)

      const entry = new DataView(new ArrayBuffer(46))
      entry.setUint32(0, 0x02014b50, true)
      entry.setUint16(4, 20, true)
      entry.setUint16(6, 20, true)
      entry.setUint16(10, 0, true) // stored
      entry.setUint32(16, crc, true)
      entry.setUint32(20, bytes.length, true)
      entry.setUint32(24, bytes.length, true)
      entry.setUint16(28, nameBytes.length, true)
      entry.setUint32(42, offset, true)

      parts.push(new Uint8Array(local.buffer), nameBytes, bytes)
      central.push(new Uint8Array(entry.buffer), nameBytes)
      offset += 30 + nameBytes.length + bytes.length
    }

    const indexSize = central.reduce((sum, part) => sum + part.length, 0)
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, 2, true)
    end.setUint16(10, 2, true)
    end.setUint32(12, indexSize, true)
    end.setUint32(16, offset, true)

    const archive = new File([...parts, ...central, new Uint8Array(end.buffer)],
      'film.zip', { type: 'application/zip' })

    window.__film = archive
    const { filesFromZip } = await import('/js/zip.js')
    const unpacked = await filesFromZip(archive)
    return {
      archive: archive.size,
      files: unpacked.files.map(file => ({ path: file.fullPath, size: file.size }))
    }
  }, 70)

  const movie = built.files.find(file => file.path.endsWith('.mp4'))
  check('an archive far larger than any cap this branch ever had is accepted',
    built.archive > 70_000_000, `${Math.round(built.archive / 1e6)} MB`)
  check('and the stored file comes out whole',
    movie && movie.size === 70 * 1024 * 1024, JSON.stringify(built.files))

  // And it can be signed, which is the half that was still false: signing read
  // every file into memory at once to hash it, so a site with a film in it died
  // during "Hashing 2 files…" — defeating the very ceiling this branch removed.
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(window.__film)
    const input = document.getElementById('files-input')
    input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })

  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 60_000 })
  await page.type('#signin-label', 'Film')
  await page.type('#signin-passphrase', 'a passphrase for something with a film in it')
  await page.click('#signin-continue')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-confirm').hidden, { timeout: 60_000 })
  await page.click('#signin-use')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-choose').hidden, { timeout: 60_000 })
  await page.select('#signin-series', '\u0000new')
  await page.type('#signin-new-series', 'film')
  await page.click('#signin-use-known')

  const link = await settled(page, '')
  const seeded = await page.evaluate(async magnet => {
    const { getClient } = await import('/js/swarm.js')
    const torrent = await getClient().get(/btih:([0-9a-f]{40})/.exec(magnet)[1])
    return torrent.files.map(f => ({ path: f.path, length: f.length }))
  }, link)

  check('a site with a film in it can be signed without the tab dying',
    seeded.some(f => f.path.endsWith('.mp4') && f.length === 70 * 1024 * 1024),
    JSON.stringify(seeded.map(f => `${f.path} ${Math.round(f.length / 1e6)}MB`)))
  check('and the signature covers it',
    seeded.some(f => /spore\.sig$/.test(f.path)), JSON.stringify(seeded.map(f => f.path)))

  // The half that matters, and the one the suite was missing: a reader checking
  // it. Seventy-three megabytes is past the size the platform's digest takes in
  // one go, so this verdict is reached by streaming the film out of the torrent
  // through our own hash — the path that did not exist an hour ago, and the one
  // that used to make a gate tell an author their film had been altered.
  await page.waitForFunction(
    () => !document.getElementById('author').hidden, { timeout: 60_000 })
  await page.waitForFunction(
    () => document.getElementById('author').dataset.state !== 'checking', { timeout: 120_000 })
  check('and a reader checks the film itself, streaming it, and says verified',
    await page.$eval('#author', el => el.dataset.state) === 'verified',
    await page.$eval('#author', el => el.dataset.state))

  // The other side of it: there is no size at which a reader stops being able
  // to check a site. A file larger than the platform's digest will take is
  // streamed through our own, so a verdict of "altered" can never come from a
  // limit that is ours.
  const verdicts = await page.evaluate(async () => {
    const source = await (await fetch('/js/app.js')).text()
    const from = source.indexOf('async function verifyContent')
    const body = source.slice(from, from + source.slice(from).indexOf('\n}\n'))
    return {
      hasNoCap: !body.includes('MAX_HASHABLE_BYTES'),
      neverAccuses: !/status: 'broken'[\s\S]{0,80}could not be read/.test(body)
    }
  })
  check('a file too large for one buffer is streamed, not refused or blamed',
    verdicts.hasNoCap && verdicts.neverAccuses, JSON.stringify(verdicts))

  // And the cost of that: since the digest learned to stream, nothing stopped
  // verification from pulling a four-gigabyte film off the swarm in the
  // background to fill in a chip. A weak check, structural rather than
  // behavioural, because building a torrent past the budget costs more than the
  // check is worth — but it fails if the budget is ever taken out again.
  const budgeted = await page.evaluate(async () => {
    const source = await (await fetch('/js/app.js')).text()
    const from = source.indexOf('async function verifyContent')
    return source.slice(from, from + source.slice(from).indexOf('\n}\n'))
      .includes('VERIFY_WITHOUT_ASKING_BYTES')
  })
  check('and checking a signature has a bandwidth budget of its own', budgeted)

  await page.close()
}

/**
 * Every shape of input, published for real, and the two answers compared.
 *
 * This is the branch's one real hazard written down as a table. The publisher
 * decides what a site is before a torrent exists; the reader decides after,
 * from paths BitTorrent has rearranged — it wraps a multi-file torrent in one
 * folder, strips at most one shared level, and for a single file keeps only the
 * basename. Every serious defect here was those two answers differing on a
 * shape nobody had tried, so the shapes are tried.
 */
async function checkEveryShapeAgrees () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  const shapes = [
    ['a folder', ['site/index.html', 'site/a.css'], 'site'],
    ['a folder holding one file', ['site/index.html'], 'site'],
    ['a page nested on its own', ['site/docs/index.html'], 'site'],
    ['a page nested with a sibling', ['site/docs/index.html', 'site/docs/a.css'], 'site'],
    ['loose files', ['index.html', 'a.css'], null],
    ['one page', ['post.html'], null],
    ['one page, nested', ['site/docs/post.html'], null],
    ['two folders at once', ['site/index.html', 'other/x.txt'], null]
  ]

  const answers = await page.evaluate(async cases => {
    const { publish } = await import('/js/publish.js')
    const { asSite, entryFor, findEntry } = await import('/js/site.js')

    const out = []
    for (const [label, paths, folder] of cases) {
      const files = paths.map(path => {
        const file = new File(['x'], path.split('/').pop(), { type: 'text/html' })
        file.fullPath = path
        return file
      })
      const site = asSite(files)
      const publisher = entryFor(site.files)
      const torrent = await publish(site.files, folder ?? site.name)
      out.push({ label, publisher, reader: findEntry(torrent) })
    }
    return out
  }, shapes)

  for (const answer of answers) {
    check(`publisher and reader agree about ${answer.label}`,
      Boolean(answer.publisher) === Boolean(answer.reader),
      `${answer.publisher ?? 'a list'} / ${answer.reader ?? 'a list'}`)
  }

  await page.close()
}

/**
 * Our two ideas of a junk file, against the library's two, on real input.
 *
 * `create-torrent` has two rules and applies them to two kinds of input. Handed
 * a *list of files* it drops names that begin with a dot and match its list.
 * Handed a *directory* it walks it, dropping every hidden entry and every name
 * on the list whether or not it begins with a dot — and that one cannot be
 * turned off, because `filterJunkFiles` never reaches a path.
 *
 * The gate hands over a list and the seeder hands over a directory, so both
 * rules are copied and both have to be exact. Too broad and the torrent carries
 * a file the signature never covered; too narrow and the signature covers a
 * file the torrent never carried. Both read to a reader as tampering.
 *
 * Checked against the library itself rather than against the list it was copied
 * from, because a copy verified only against its own origin is not verified.
 */
async function checkJunkRulesMatchTheLibrary () {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const createTorrent = (await import('create-torrent')).default
  const { isJunkPath, skippedWhenWalking } =
    await import(`file://${process.cwd()}/js/manifest.js`)

  const names = [
    'index.html', 'photo.jpg', '.DS_Store', '._preview.jpg', '.gitignore',
    'Thumbs.db', '.hidden', 'npm-debug.log', '.swap.swp', 'desktop.ini'
  ]
  const build = opts => new Promise((resolve, reject) =>
    createTorrent(opts.input, opts.options ?? {}, (err, buf) => err ? reject(err) : resolve(buf)))

  // --- the rule for a directory, which is the seeder's ------------------------
  const dir = await mkdtemp(join(tmpdir(), 'spore-junk-'))
  try {
    for (const name of names) await writeFile(join(dir, name), 'x')
    const walked = new Set((await parseTorrentFile(await build({ input: dir })))
      .files.map(file => file.path.split('/').slice(1).join('/')))

    const wrong = names.filter(name => skippedWhenWalking(name) === walked.has(name))
    check('the seeder skips exactly what the library skips walking a directory',
      wrong.length === 0, wrong.length ? `disagreed about ${wrong.join(', ')}` : `${names.length} names`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  // --- and the rule for a list of files, which is the gate's -------------------
  const listed = names.map(name => {
    const buffer = Buffer.from('x')
    buffer.name = name
    buffer.fullPath = `site/${name}`
    return buffer
  })
  const inTorrent = new Set((await parseTorrentFile(await build({
    input: listed, options: { name: 'site' }
  }))).files.map(file => file.path.split('/').slice(1).join('/')))

  const off = names.filter(name => isJunkPath(name) === inTorrent.has(name))
  check('and the gate drops exactly what the library drops from a list',
    off.length === 0, off.length ? `disagreed about ${off.join(', ')}` : `${names.length} names`)
}

/** parse-torrent, which is CommonJS-ish depending on the version. */
async function parseTorrentFile (buffer) {
  const mod = await import('parse-torrent')
  return (mod.default ?? mod)(buffer)
}

/**
 * The agreement, on shapes nobody chose.
 *
 * `checkEveryShapeAgrees` tries eight layouts I thought of, which is exactly the
 * weakness every defect on this branch exploited: the publisher and the reader
 * agreed on everything anyone had tried. This tries a hundred and twenty nobody
 * tried, building each torrent for real so the comparison is against what
 * `create-torrent` actually does rather than against my reading of it.
 *
 * Seeded, so a failure is reproducible: the seed is printed with the result.
 */
async function checkShapesNobodyChose () {
  const createTorrent = (await import('create-torrent')).default
  const { asSite, entryFor, findEntry } = await import(`file://${process.cwd()}/js/site.js`)

  const seed = Number(process.env.SPORE_SHAPES_SEED ?? 20260915)
  let state = seed
  const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = list => list[Math.floor(random() * list.length)]

  const folders = ['site', 'docs', 'a', 'b', 'assets']
  const leaves = ['index.html', 'post.html', 'a.css', 'photo.jpg', 'notes.txt']
  const shape = () => [...Array(Math.floor(random() * 3))]
    .map(() => pick(folders)).concat(pick(leaves)).join('/')

  const disagreed = []
  for (let i = 0; i < 120; i++) {
    const paths = [...new Set([...Array(1 + Math.floor(random() * 4))].map(shape))]
    const files = paths.map(path => {
      const file = new File(['x'], path.split('/').pop())
      file.fullPath = path
      return file
    })

    const site = asSite(files)
    const publisher = entryFor(site.files)
    const options = site.files.length === 1
      ? { filterJunkFiles: false }
      : { name: site.name ?? 'site', filterJunkFiles: false }

    const torrent = await parseTorrentFile(await new Promise((resolve, reject) =>
      createTorrent(site.files, options, (err, buf) => err ? reject(err) : resolve(buf))))
    // Through `findEntry`, which is the function the viewer itself calls, on a
    // torrent-shaped object. The rule underneath is not exported: a second
    // entry rule reachable from outside is the thing most likely to be picked
    // up by mistake later.
    const reader = findEntry({ files: torrent.files.map(file => ({ path: file.path })) })

    if (Boolean(publisher) !== Boolean(reader)) {
      disagreed.push(`${JSON.stringify(paths)} -> ${publisher} / ${reader}`)
    }
  }

  check('publisher and reader agree on a hundred and twenty shapes nobody chose',
    disagreed.length === 0,
    disagreed.length ? `seed ${seed}: ${disagreed[0]}` : `seed ${seed}`)
}

/**
 * A real archive with more files in it than the reader will take.
 *
 * Built here rather than shipped, because a forged count is a different thing:
 * an end record claiming forty thousand entries that holds one is simply a
 * damaged archive, and refusing it as damaged is correct. What has to be
 * refused *by name* is an archive that really does carry more files than a
 * browser should turn into that many Files, torrent entries, manifest lines and
 * rows in a list.
 */
async function checkAnArchiveWithTooManyFiles () {
  const { filesFromZip, ZipError } =
    await import(`file://${process.cwd()}/js/zip.js`)
  const { ZIP_MAX_ENTRIES } = await import(`file://${process.cwd()}/js/config.js`)

  const archive = storedZip([...Array(ZIP_MAX_ENTRIES + 500)]
    .map((_, i) => [`f${i}.txt`, new TextEncoder().encode('x')]))

  let refused = null
  try {
    await filesFromZip(new File([archive], 'many.zip', { type: 'application/zip' }))
  } catch (err) {
    refused = err
  }
  check('an archive really holding more files than the reader takes is refused by name',
    refused instanceof ZipError && refused.message.includes(`more than ${ZIP_MAX_ENTRIES}`),
    refused?.message?.slice(0, 70) ?? 'it was accepted')
}

/** A zip with every entry stored, which is all these checks need. */
function storedZip (entries) {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  const crc32 = bytes => {
    let crc = 0xffffffff
    for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }

  const parts = []
  const central = []
  let offset = 0

  for (const [name, bytes] of entries) {
    const nameBytes = new TextEncoder().encode(name)
    const crc = crc32(bytes)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, bytes.length, true)
    local.setUint32(22, bytes.length, true)
    local.setUint16(26, nameBytes.length, true)

    const record = new DataView(new ArrayBuffer(46))
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(4, 20, true)
    record.setUint16(6, 20, true)
    record.setUint32(16, crc, true)
    record.setUint32(20, bytes.length, true)
    record.setUint32(24, bytes.length, true)
    record.setUint16(28, nameBytes.length, true)
    record.setUint32(42, offset, true)

    parts.push(new Uint8Array(local.buffer), nameBytes, bytes)
    central.push(new Uint8Array(record.buffer), nameBytes)
    offset += 30 + nameBytes.length + bytes.length
  }

  const indexSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, indexSize, true)
  end.setUint32(16, offset, true)

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)])
}

/**
 * Our SHA-256, against the published vectors and against the platform's.
 *
 * Writing a hash is usually a bad idea and this is the narrow case where it is
 * not: it is completely specified, completely testable, has no key and no
 * secret, and a mistake produces numbers that do not match rather than a
 * signature somebody can forge. What makes it defensible is this check — not
 * that it was written carefully, but that it is compared against
 * `crypto.subtle.digest` at every boundary that matters, on every run.
 *
 * It exists because the platform has no streaming digest, and without one there
 * was a size above which a site could not be signed, could not be verified, and
 * was reported to its readers as altered.
 */
async function checkOurSha256 () {
  const { Sha256, digestBlob } = await import(`file://${process.cwd()}/js/sha256.js`)
  const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  const utf8 = new TextEncoder()

  // FIPS 180-4 / RFC 6234.
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1']
  ]
  const wrong = vectors.filter(([input, want]) =>
    hex(new Sha256().update(utf8.encode(input)).digest()) !== want)

  const million = new Sha256()
  for (let i = 0; i < 1000; i++) million.update(utf8.encode('a'.repeat(1000)))
  const millionOk = hex(million.digest()) ===
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'

  check('our SHA-256 produces the published vectors',
    wrong.length === 0 && millionOk,
    wrong.length ? `wrong for ${JSON.stringify(wrong[0][0].slice(0, 20))}` : 'four of four')

  // Every length where the block and padding arithmetic changes behaviour.
  const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65_536, 1_000_003]
  const differed = []
  for (const size of sizes) {
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = (i * 31) & 0xff
    const ours = hex(new Sha256().update(bytes).digest())
    const theirs = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    if (ours !== theirs) differed.push(size)
  }
  check('and agrees with the platform at every boundary that matters',
    differed.length === 0,
    differed.length ? `differed at ${differed.join(', ')}` : `${sizes.length} sizes`)

  // Fed in pieces of uneven size, which is how a stream actually arrives.
  const big = new Uint8Array(3_000_000)
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff
  const uneven = new Sha256()
  for (let at = 0; at < big.length;) {
    const step = 1 + ((at * 13) % 100_000)
    uneven.update(big.subarray(at, Math.min(at + step, big.length)))
    at += step
  }
  const native = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', big)))
  check('and arrives at the same answer in uneven pieces, and through a Blob',
    hex(uneven.digest()) === native && hex(await digestBlob(new Blob([big]))) === native)
}

/**
 * Reading a site must not depend on being able to store one.
 *
 * Browsers set to block site data give a failing or hanging IndexedDB, and the
 * gate used to take that personally: `render()` awaited `isKept()`, and an
 * unopenable database turned into "Spore is broken" rather than "offline
 * storage is unavailable". Simulated here by making `indexedDB.open` hang, the
 * worst case, since a promise that never settles is what actually wedged it.
 */
async function checkSurvivesDeadStorage (page) {
  const wedged = await browser.createBrowserContext()
  const victim = await wedged.newPage()

  await victim.evaluateOnNewDocument(() => {
    indexedDB.open = () => ({ // never fires an event, either way
      set onsuccess (_) {}, set onerror (_) {}, set onblocked (_) {}, set onupgradeneeded (_) {}
    })
  })

  await victim.goto(origin + '/', { waitUntil: 'load' })
  await victim.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open',
    { timeout: 30_000 }).catch(() => {})
  check('the gate finishes booting even when IndexedDB never answers',
    (await victim.$eval('#status', el => el.textContent)) === 'Nothing open',
    await victim.$eval('#status', el => el.textContent))

  const hash = await victim.evaluate(async (site, paths) => {
    const files = []
    for (const path of paths) {
      const res = await fetch(`/${site}/${path}`)
      const file = new File([await res.blob()], path.split('/').pop())
      file.fullPath = `${site}/${path}`
      files.push(file)
    }
    const { publish } = await import('/js/publish.js')
    return (await publish(files, site)).infoHash
  }, SITE, SITE_FILES)

  await victim.evaluate(h => { location.hash = h }, hash)
  const shown = await victim.waitForFunction(() => {
    const frame = document.getElementById('viewer')
    return !frame.hidden && frame.src.includes('/webtorrent/')
  }, { timeout: 30_000 }).then(() => true, () => false)
  check('a site still opens when offline storage is unavailable', shown,
    await victim.$eval('#notice', el => el.textContent.slice(0, 80)))

  await wedged.close()
}

/**
 * Publishing through the actual UI, not by calling publish() directly.
 *
 * This is the path a reader uses and it was broken while every other check
 * passed: the drop was only handled on the dashed box, so a folder dropped
 * anywhere else fell through to the browser, which navigated away from the
 * gate to open the file.
 *
 * A real folder drag cannot be synthesised — `webkitGetAsEntry` needs one from
 * the OS — so this covers the wiring and the flat-file fallback around it.
 */
async function checkPublishingByDrop (page) {
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  const handled = await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['<h1>dropped</h1>'], 'index.html', { type: 'text/html' }))

    const dropOn = target => {
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    return {
      dropzone: dropOn(document.getElementById('dropzone')),
      body: dropOn(document.body),
      header: dropOn(document.querySelector('.chrome'))
    }
  })
  check('a folder dropped on the drop zone is handled', handled.dropzone)
  check('a folder dropped anywhere else on the page is handled too, not opened by the browser',
    handled.body && handled.header, JSON.stringify(handled))

  // Publishing now asks whether to sign first. This check is about the drop, so
  // it answers the question the way a publisher in a hurry would.
  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await page.click('#signin-skip')

  await page.waitForFunction(() => !document.getElementById('share').hidden, { timeout: 30_000 })
  const link = await page.$eval('#share-link', input => input.value)
  check('dropping publishes and offers a shareable link', link.includes('#magnet:?xt=urn:btih:'), link.slice(0, 60))

  // Dragging must announce itself across the whole window, or readers aim at
  // the dashed box, miss, and conclude that dropping does not work.
  const overlay = await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File([''], 'x.html'))
    document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }))
    const shown = getComputedStyle(document.getElementById('drop-overlay')).display
    document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: data }))
    return { shown, hidden: getComputedStyle(document.getElementById('drop-overlay')).display }
  })
  check('dragging a file over the page shows where it can be dropped',
    overlay.shown === 'flex' && overlay.hidden === 'none', JSON.stringify(overlay))
}

/**
 * Keeping a site is the only thing that writes to disk, so it gets checked the
 * same way: nothing stored until asked, and everything gone when forgotten.
 */
async function checkKeepingOffline (page, infoHash) {
  const stored = () => page.evaluate(async () => {
    const { listSites } = await import('/js/idb.js')
    return (await listSites()).map(s => s.infoHash)
  })

  check('nothing is on disk before the reader asks', (await stored()).length === 0)

  prompts.length = 0
  await page.click('#keep-toggle')
  await page.waitForFunction(() => !document.getElementById('kept').hidden, { timeout: 30_000 })
  check('keeping a site on this device asks first',
    prompts.some(text => text.includes('Keep this site on this device?')), prompts[0]?.split('\n')[0])
  check('the site is stored under its infohash', (await stored()).includes(infoHash))
  check('the kept site is listed with a way to forget it',
    await page.$eval('#kept-list', list => list.children.length === 1 &&
      !!list.querySelector('button')))

  // Keeping a site must not cost you the ability to pass it on. The list used
  // to link to a bare infohash, which opens here — the bytes are already on
  // disk — and is useless to anyone else, because it names the content and
  // says nothing about where to ask for it.
  const keptLink = await page.$eval('#kept-list a', a => a.getAttribute('href'))
  check('a kept site is listed by a link a friend could actually open',
    keptLink.startsWith('#magnet:?xt=urn:btih:') && keptLink.includes('tr='),
    keptLink.slice(0, 70))

  // And any open site can be handed over, however it was reached.
  await page.click('#share-open')
  await page.waitForFunction(() => !document.getElementById('share').hidden, { timeout: 10_000 })
  const shared = await page.$eval('#share-link', input => input.value)
  check('any site on screen offers a shareable link, not just a freshly published one',
    shared.includes('#magnet:?xt=urn:btih:' + infoHash) && shared.includes('tr='),
    shared.slice(0, 80))
  check('and it does not claim the reader just published it',
    !/Published\./.test(await page.$eval('#share-intro', el => el.textContent)),
    await page.$eval('#share-intro', el => el.textContent.trim().slice(0, 40)))
  await page.click('#share-dismiss')

  // The payoff: a kept site comes back complete, with no peer to ask.
  const restored = await page.evaluate(async hash => {
    const { restoreAll } = await import('/js/keep.js')
    const { getClient } = await import('/js/swarm.js')
    const client = getClient()
    const torrent = await client.get(hash)
    await torrent.destroy()                    // as if the tab had been closed
    const result = await restoreAll(client)
    const back = await client.get(hash)
    return { ...result, done: !!back?.done, progress: back?.progress }
  }, infoHash)
  check('a kept site reloads from disk, complete, with no peers',
    restored.restored === 1 && restored.done === true,
    `restored ${restored.restored}, progress ${restored.progress}`)

  // Kept sites are managed from the welcome screen, so go back to it first.
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  check('the welcome screen reports what is being seeded from disk',
    (await page.$eval('#peers', el => el.textContent)).includes('1 kept site'),
    await page.$eval('#peers', el => el.textContent))

  await page.click('#kept-list button')
  await page.waitForFunction(() => document.getElementById('kept').hidden, { timeout: 10_000 })
  check('forgetting a site removes it from disk', (await stored()).length === 0)

  const chunks = await page.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('spore')
    open.onsuccess = () => {
      const count = open.result.transaction('chunks').objectStore('chunks').count()
      count.onsuccess = () => resolve(count.result)
    }
    open.onerror = () => resolve(-1)
  }))
  check('forgetting deletes the stored bytes, not just the record', chunks === 0, `${chunks} chunks left`)
}

/**
 * A site nobody seeds gets a page, and the logo gets you out of it.
 *
 * An infohash with no seeder is the swarm's version of a dead URL, so it earns
 * what a web server gives one: a 404 that explains itself. Uses a hash nothing
 * can possibly be seeding, and a shortened timeout so the check does not sit
 * through the full minute the gate allows a real swarm.
 */
async function checkMissingSiteAndHome (page) {
  const missing = 'ffffffffffffffffffffffffffffffffffffffff'

  // A magnet with a typo in it must be refused at once, not waited on. This is
  // the shape a reader actually hits: one wrong character in a pasted link,
  // which WebTorrent accepts without complaint and then waits out in full.
  await page.evaluate(() => {
    location.hash = 'magnet:?xt=urn:btih:ba62786619c7e7b0ccfdqdd1c660cd24c53e6d8b&dn=x'
  })
  await wait(2500)
  const typo = await page.evaluate(() => ({
    hidden: document.getElementById('error').hidden,
    code: document.getElementById('error-code').textContent,
    detail: document.getElementById('error-detail').textContent.slice(0, 60)
  }))
  check('a magnet with a typo is refused immediately, not waited on',
    typo.hidden === false && typo.code === '???', JSON.stringify(typo))

  // Deliberately the slow path. An earlier version of this check faked the
  // failure by emitting an error on the torrent, which took the generic branch
  // and never exercised the 404 at all — it passed while proving nothing. This
  // waits out the real timeout so the real error travels the real route.
  await page.evaluate(hash => { location.hash = hash }, missing)

  // Polled in short steps rather than one long waitForFunction: the browser is
  // launched with a 30s protocolTimeout, which aborts any single CDP call that
  // outlives it — including a wait. That is what made an earlier version of
  // this check read the page's defaults and report a passing 404 it had never
  // actually seen.
  let shown = false
  for (let waited = 0; waited < 90_000 && !shown; waited += 2000) {
    await wait(2000)
    shown = await page.evaluate(() => !document.getElementById('error').hidden)
  }

  const view = await page.evaluate(() => ({
    code: document.getElementById('error-code').textContent,
    title: document.getElementById('error-title').textContent,
    ref: document.getElementById('error-ref').textContent,
    welcomeHidden: document.getElementById('welcome').hidden,
    viewerHidden: document.getElementById('viewer').hidden
  }))
  check('a site nobody is seeding gets a 404 page, not a red line',
    shown && view.code === '404' && view.viewerHidden, JSON.stringify(view))
  check('the missing-site page names the address that failed',
    view.ref === missing, view.ref)

  // The landing page's own field is the primary call to action, so it has to
  // navigate exactly like the address bar in the chrome does.
  await page.click('#home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  await page.$eval('#visit', (input, value) => { input.value = value }, missing)
  await page.click('#visit-form button')
  await wait(1500)
  check('the landing page field opens what it is given',
    (await page.evaluate(() => location.hash)) === '#' + missing,
    await page.evaluate(() => location.hash))

  // The logo is the way back, and it should leave a clean URL behind it.
  await page.click('#home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  const home = await page.evaluate(() => ({
    hash: location.hash,
    welcome: !document.getElementById('welcome').hidden,
    error: document.getElementById('error').hidden
  }))
  check('the logo goes home, leaving no stray fragment behind',
    home.welcome && home.error && home.hash === '', JSON.stringify(home))

  // And the browser's own back button still works across that transition.
  await page.goBack()
  await wait(1500)
  check('back returns to the address that was open',
    (await page.evaluate(() => location.hash)) === '#' + missing,
    await page.evaluate(() => location.hash))
  await page.evaluate(() => history.pushState(null, '', location.pathname))
  await page.evaluate(() => { location.hash = '' })
}

/**
 * One peer tells another that a site has a newer version.
 *
 * The point of the whole slice, and it cannot be faked: two independent
 * browser contexts, two WebTorrent clients, a real swarm, and a signed record
 * crossing a real wire through the BEP 10 extension handshake.
 *
 * The publisher seeds v1 and holds a record naming v2. The reader opens v1,
 * connects, and must end up with v2's infohash — having verified it against
 * the key carried inside v1's own content.
 */
async function checkUpdateOverTheWire () {
  const publisher = await browser.createBrowserContext().then(c => c.newPage())
  const reader = await browser.createBrowserContext().then(c => c.newPage())

  for (const page of [publisher, reader]) {
    await page.goto(origin + '/', { waitUntil: 'load' })
    await page.waitForFunction(
      () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })
  }

  // The publisher makes an identity, publishes v1 carrying its spore.pub, then
  // publishes v2 and signs a record naming it.
  const published = await publisher.evaluate(async () => {
    const { createIdentity, formatSporePub } = await import('/js/identity.js')
    const { signUpdate } = await import('/js/record.js')
    const { seedTorrent } = await import('/js/swarm.js')
    const { watchForUpdates } = await import('/js/updates.js')

    const me = await createIdentity()
    const pub = formatSporePub(me.hex, 'Test Author')

    const version = async (body, name) => {
      const files = [
        new File([body], 'index.html', { type: 'text/html' }),
        new File([pub], 'spore.pub', { type: 'text/plain' })
      ]
      files[0].fullPath = `${name}/index.html`
      files[1].fullPath = `${name}/spore.pub`
      return await seedTorrent(files, { name })
    }

    const v1 = await version('<h1>version one</h1>', 'site-v1')
    const v2 = await version('<h1>version two</h1>', 'site-v2')

    const record = await signUpdate(me.privateKey, me.publicKey, v2.infoHash, 2)

    // Offer it to anyone who joins v1's swarm — the seeder's whole job here.
    watchForUpdates(v1, {
      publicKey: () => me.publicKey,
      offer: () => record,
      onUpdate: () => {}
    })

    return { key: me.hex, v1: v1.infoHash, v2: v2.infoHash, magnet: v1.magnetURI }
  })
  check('the publisher seeded two versions and signed a successor',
    /^[0-9a-f]{40}$/.test(published.v1) && published.v1 !== published.v2, published.v2)

  // Joining v1's swarm with a watcher installed, expecting `keyHex` to be the
  // author. Records land in `window.__seen`, refusals in `window.__rejected`.
  //
  // The watcher goes on through openTorrent's join hook, which runs the moment
  // the torrent is added — before metadata, and so before any peer handshakes.
  // Attaching after the await would be too late: the wire would already exist
  // and would never have advertised sp_update, so the publisher, which decides
  // what to send from the peer's handshake, would never send us one.
  const joinAndWatch = async (page, magnet, keyHex) => page.evaluate(async (magnet, keyHex) => {
    const { fromHex } = await import('/js/bencode.js')
    const { openTorrent } = await import('/js/swarm.js')
    const { watchForUpdates } = await import('/js/updates.js')

    window.__seen = null
    window.__rejected = []

    let torrent
    // Started, never awaited. Joining a swarm takes as long as it takes, and an
    // evaluate that outlives the browser's protocolTimeout is killed mid-wait —
    // which the suite then reports as a failure of whatever it was testing.
    window.__joined = openTorrent(magnet, joined => watchForUpdates(torrent = joined, {
      // In the gate this comes from the site's own spore.pub; passed in here so
      // the check does not also depend on reading a file out of the torrent.
      publicKey: () => fromHex(keyHex),
      offer: () => null,
      currentInfoHash: () => torrent.infoHash,
      onRejected: reason => window.__rejected.push(reason),
      onUpdate: update => { window.__seen = update }
    }))
  }, magnet, keyHex)

  // Polled from the outside in short calls: a single evaluate that waits half a
  // minute outruns the browser's protocolTimeout and is killed mid-wait, which
  // looks exactly like failure.
  const settle = async (page, read, ms = 40_000) => {
    let value = await page.evaluate(read)
    for (let waited = 0; waited < ms; waited += 2000) {
      if (Array.isArray(value) ? value.length : value) break
      await wait(2000)
      value = await page.evaluate(read)
    }
    return value
  }

  // The reader joins v1 knowing only its magnet, and must learn v2 from a peer.
  await joinAndWatch(reader, published.magnet, published.key)
  const learned = await settle(reader, () => window.__seen)
  check('a reader on the old version learns the new one from a peer',
    learned?.infoHash === published.v2 && learned?.seq === 2,
    JSON.stringify(learned ?? await reader.evaluate(() => window.__rejected.slice(0, 3))))

  // The same exchange for a peer expecting a different author. It needs its own
  // browser context rather than a second watcher on the reader's torrent: the
  // publisher offers its record once, when a peer's handshake tells it the peer
  // speaks sp_update, so only a peer that joins fresh is ever sent one.
  const stranger = await browser.createBrowserContext().then(c => c.newPage())
  await stranger.goto(origin + '/', { waitUntil: 'load' })
  // Waited for, like the other two. `load` only means the HTML arrived; the
  // swarm client is started during boot, and joining before that produces a
  // page that quietly never joins anything.
  await stranger.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  const otherKey = await stranger.evaluate(async () => {
    const { createIdentity } = await import('/js/identity.js')
    return (await createIdentity()).hex
  })
  await joinAndWatch(stranger, published.magnet, otherKey)

  const refused = await settle(stranger, () => window.__rejected, 30_000)
  check('a record signed by anyone but the key the reader expects is refused',
    refused.some(r => /different key/.test(r)) && !(await stranger.evaluate(() => window.__seen)),
    JSON.stringify(refused.slice(0, 2)))
}

/**
 * The whole loop, through the gate's own UI.
 *
 * The publisher ships a `spore.pub` beside its index, so the site names its own
 * author; the reader opens it the way a person would, by putting the magnet in
 * the fragment. Nothing about the update is typed in: the reader learns the key
 * by reading it out of the torrent and the successor by hearing it from a peer.
 *
 * The banner is the point. An update that applied itself would be a page
 * swapped under someone mid-read on the authority of a key that might since
 * have been stolen, so it is offered and the click is the reader's.
 */
async function checkUpdateOffer () {
  const publisher = await browser.createBrowserContext().then(c => c.newPage())
  const reader = await browser.createBrowserContext().then(c => c.newPage())

  for (const page of [publisher, reader]) {
    await page.goto(origin + '/', { waitUntil: 'load' })
    await page.waitForFunction(
      () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })
  }

  const published = await publisher.evaluate(async () => {
    const { createIdentity, formatSporePub } = await import('/js/identity.js')
    const { signUpdate } = await import('/js/record.js')
    const { seedTorrent } = await import('/js/swarm.js')
    const { watchForUpdates } = await import('/js/updates.js')

    const me = await createIdentity()
    const pub = formatSporePub(me.hex, 'Lara from work')

    const version = async (body, name) => {
      const files = [
        new File([body], 'index.html', { type: 'text/html' }),
        new File([pub], 'spore.pub', { type: 'text/plain' })
      ]
      files[0].fullPath = `${name}/index.html`
      files[1].fullPath = `${name}/spore.pub`
      return await seedTorrent(files, { name })
    }

    const v1 = await version('<h1>version one</h1>', 'offered-v1')
    const v2 = await version('<h1>version two</h1>', 'offered-v2')
    const record = await signUpdate(me.privateKey, me.publicKey, v2.infoHash, 7)

    watchForUpdates(v1, { publicKey: () => me.publicKey, offer: () => record, onUpdate: () => {} })
    return { v1: v1.infoHash, v2: v2.infoHash, magnet: v1.magnetURI }
  })

  // Opened the way a reader opens anything: the magnet goes in the fragment.
  await reader.evaluate(magnet => { location.hash = magnet }, published.magnet)

  let shown = false
  for (let waited = 0; waited < 60_000 && !shown; waited += 2000) {
    await wait(2000)
    shown = await reader.$eval('#update', el => !el.hidden)
  }
  check('the gate offers a signed successor rather than following it',
    shown && (await reader.evaluate(() => location.hash)).includes(published.v1),
    shown ? 'offered, still on v1' : 'no banner')

  const said = await reader.$eval('#update-title', el => el.textContent)
  check('the offer names the key\'s claim as a claim',
    /Lara from work/.test(said), said)

  // Only the reader's click moves them.
  await reader.click('#update-open')
  await reader.waitForFunction(
    hash => location.hash.includes(hash), { timeout: 20_000 }, published.v2).catch(() => {})
  check('taking the offer navigates to the signed version',
    (await reader.evaluate(() => location.hash)).includes(published.v2),
    await reader.evaluate(() => location.hash))
}

/**
 * The publisher's half, through the UI a publisher actually uses.
 *
 * Everything before this drove the modules directly and hand-signed the record.
 * Here nobody signs anything on purpose: a person types a passphrase, drops a
 * folder, drops a second folder, and a reader on the first one is offered the
 * second. If the gate is not putting `spore.pub` in the folder, or is numbering
 * versions wrong, or is announcing to the wrong swarm, this is what notices.
 */
async function checkPublishingASuccessor () {
  const publisher = await browser.createBrowserContext().then(c => c.newPage())
  await publisher.goto(origin + '/', { waitUntil: 'load' })
  await publisher.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  // The real input, with a real change event: this is the path that raises the
  // signing question, adds spore.pub and signs successors. Calling publish()
  // directly skips all of it.
  const dropFolder = async body => publisher.evaluate(body => {
    const data = new DataTransfer()
    data.items.add(new File([body], 'index.html', { type: 'text/html' }))
    const input = document.getElementById('folder-input')
    input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, body)

  const settled = async since => {
    for (let waited = 0; waited < 60_000; waited += 1000) {
      await wait(1000)
      const hash = await publisher.evaluate(() => location.hash)
      if (hash.length > 1 && hash !== since) return hash
    }
    return null
  }

  // --- the question is asked before anything is hashed ----------------------
  await dropFolder('<h1>first</h1>')
  await publisher.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  check('dropping a folder asks whether to sign it, before publishing anything',
    await publisher.$eval('#signin-step-enter', el => !el.hidden))

  // --- and backing out leaves a page you can still publish from -------------
  // The bug this is here for: the dialog used to be raised after busy(), which
  // hides the landing page, so cancelling — or signing in at all — left no drop
  // zone and no way to publish anything ever again.
  await publisher.click('#signin-cancel')
  await wait(500)
  check('cancelling leaves the landing page, and the way to publish, intact',
    await publisher.evaluate(() => {
      const welcome = document.getElementById('welcome')
      return !welcome.hidden && getComputedStyle(welcome).display !== 'none' &&
        !!document.getElementById('dropzone')
    }))

  // --- every step can be left ----------------------------------------------
  // The choose step had no cancel of any kind: once a key was known, Esc was
  // the only exit from a modal covering the page.
  await dropFolder('<h1>first</h1>')
  await publisher.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await publisher.click('#signin-dismiss')
  await wait(500)
  check('the signing dialog can always be dismissed',
    await publisher.evaluate(() => !document.getElementById('signin-dialog').open))

  // --- publish signed -------------------------------------------------------
  await dropFolder('<h1>first</h1>')
  await publisher.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await publisher.type('#signin-label', 'Lara from work')
  await publisher.type('#signin-passphrase', 'correct horse battery staple hunter2')
  await publisher.click('#signin-continue')
  await publisher.waitForFunction(
    () => !document.getElementById('signin-step-confirm').hidden, { timeout: 30_000 })

  const shownFingerprint = await publisher.$eval('#signin-fingerprint', el => el.textContent)
  check('the key is shown before anything is signed with it',
    /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(shownFingerprint), shownFingerprint)
  check('a key this browser has not seen is described plainly, not as an error',
    /New to this browser/.test(
      await publisher.$eval('#signin-recognised', el => el.textContent)))

  await publisher.click('#signin-use')

  // Confirming the key does not publish: which site this is comes next.
  await publisher.waitForFunction(
    () => !document.getElementById('signin-step-choose').hidden, { timeout: 30_000 })
  await publisher.select('#signin-series', '\u0000new')
  await publisher.type('#signin-new-series', 'blog')
  await publisher.click('#signin-use-known')

  const first = await settled('')
  check('publishing while signed in yields a magnet', Boolean(first), String(first))

  const v1 = /btih:([0-9a-f]{40})/.exec(first ?? '')?.[1]
  const contents = await publisher.evaluate(async hash => {
    const { getClient } = await import('/js/swarm.js')
    return (await getClient().get(hash)).files.map(f => f.path)
  }, v1)
  check('the published folder carries the signed-in key',
    contents.some(path => /(^|\/)spore\.pub$/.test(path)), JSON.stringify(contents))

  // --- the second publish should not ask again ------------------------------
  await dropFolder('<h1>second, and different</h1>')
  await publisher.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  const greeting = await publisher.$eval('#signin-known-label', el => el.textContent)
  const declared = await publisher.evaluate(async hash => {
    const { getClient } = await import('/js/swarm.js')
    const torrent = await getClient().get(hash)
    const file = torrent.files.find(f => /spore\.pub$/.test(f.path))
    return new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
  }, v1)
  check('the name the publisher gave is the name the site declares',
    /\nname=Lara from work\n/.test(declared), JSON.stringify(declared))

  check('a key already in use is offered back by the name it was given',
    /Lara from work/.test(greeting), greeting)
  const offeredSeries = await publisher.$$eval('#signin-series option', els =>
    els.map(el => el.textContent))
  check('a site already published is offered as something to update',
    offeredSeries.includes('blog'), JSON.stringify(offeredSeries))
  await publisher.select('#signin-series', 'blog')
  await publisher.click('#signin-use-known')

  const second = await settled(first)
  const v2 = /btih:([0-9a-f]{40})/.exec(second ?? '')?.[1]
  check('publishing again yields a different site', Boolean(v2) && v2 !== v1, `${v1} → ${v2}`)

  const note = await publisher.$eval(
    '#share-successor', el => el.hidden ? '' : el.textContent)
  check('the publisher is told which site the successor is for, and where it reaches',
    /new version of “blog”/.test(note) && /previous version/.test(note), note.slice(0, 90))

  // --- unsigned publishing must still work ----------------------------------
  await dropFolder('<h1>anonymous</h1>')
  await publisher.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await publisher.click('#signin-skip-known')
  const third = await settled(second)
  const v3 = /btih:([0-9a-f]{40})/.exec(third ?? '')?.[1]
  const bare = await publisher.evaluate(async hash => {
    const { getClient } = await import('/js/swarm.js')
    return (await getClient().get(hash)).files.map(f => f.path)
  }, v3)
  check('publishing unsigned publishes no key at all',
    Boolean(v3) && !bare.some(path => /spore\.pub$/.test(path)), JSON.stringify(bare))

  // --- the proof ------------------------------------------------------------
  // Someone still on the first version, who was never told anything by us,
  // hears about the second from the publisher's tab.
  const reader = await browser.createBrowserContext().then(c => c.newPage())
  await reader.goto(origin + '/', { waitUntil: 'load' })
  await reader.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })
  await reader.evaluate(hash => { location.hash = hash }, first)

  let offered = false
  for (let waited = 0; waited < 60_000 && !offered; waited += 2000) {
    await wait(2000)
    offered = await reader.$eval('#update', el => !el.hidden)
  }
  const detail = offered ? await reader.$eval('#update-detail', el => el.textContent) : ''
  check('a reader on the first version is offered the second',
    offered && /Published today/.test(detail), detail || 'no banner')

  // --- the reader can actually check the authorship -------------------------
  const chip = await reader.evaluate(() => ({
    shown: !document.getElementById('author').hidden,
    text: document.getElementById('author-chip-name').textContent
  }))
  check('a signed site says so in a way you can click', chip.shown, JSON.stringify(chip))

  await reader.click('#author')
  await reader.waitForFunction(
    () => document.getElementById('author-dialog').open, { timeout: 10_000 })
  const panel = await reader.evaluate(() => ({
    fingerprint: document.getElementById('author-fingerprint').textContent,
    facts: [...document.querySelectorAll('#author-facts dt')].map(dt => dt.textContent),
    values: [...document.querySelectorAll('#author-facts dd')].map(dd => dd.textContent)
  }))
  check('the author panel shows the key, not just that one exists',
    /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(panel.fingerprint) &&
    panel.values.some(v => /^[0-9a-f]{64}$/.test(v)),
    panel.fingerprint)
  check('it names the site and marks the declared name as a claim',
    panel.values.includes('blog') &&
    panel.values.some(v => /Lara from work.*their own claim/.test(v)),
    JSON.stringify(panel.values.slice(0, 2)))

  // A petname is the reader's answer to two people calling themselves Lara.
  await reader.type('#author-label', 'Lara from work')
  await reader.click('#author-close')
  await wait(300)
  // Contains rather than equals: the chip also carries a mark for whether the
  // content signature checked out, which is a different claim from the name.
  check('naming an author replaces their self-declared claim in the chip',
    (await reader.$eval('#author-chip-name', el => el.textContent)).includes('Lara from work') &&
    !(await reader.$eval('#author-chip-name', el => el.textContent)).includes('“'),
    await reader.$eval('#author-chip-name', el => el.textContent))

  // --- and a second site under the same key must not replace the first ------
  // The bug this exists for: history was keyed by public key alone, so
  // publishing anything else under one identity signed it as the successor to
  // whatever came before. A blog would be replaced by an unrelated page.
  await publisher.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['<h1>notes, a different site</h1>'], 'index.html',
      { type: 'text/html' }))
    const input = document.getElementById('folder-input')
    input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await publisher.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await publisher.select('#signin-series', '\u0000new')
  await publisher.type('#signin-new-series', 'notes')
  await publisher.click('#signin-use-known')
  await settled(third)

  // The blog reader is holding the offer for blog v2. A record for "notes" is
  // authentic, signed by the same key, and about something else — so it must
  // neither be shown nor quietly swap the offer that is up.
  await wait(6000)
  const still = await reader.$eval('#update-detail', el => el.textContent)
  const stillOnBlog = await reader.evaluate(() => location.hash)
  check('a second site under the same key does not replace the first',
    still === detail && stillOnBlog.includes(v1), `${still.slice(0, 60)} | ${stillOnBlog.slice(0, 30)}`)
}

/**
 * The gate must find out for itself whether a sandboxed frame is reachable.
 *
 * WebKit will not let a service worker serve one, which is why nothing rendered
 * on iOS: the frame's request skipped the worker, went to the network, and the
 * host answered 404. Measured with two frames differing only in the attribute —
 * WebKit served the plain one and 404'd the sandboxed one, Chrome served both.
 *
 * Here the answer must be yes, and the sandbox must therefore still be applied:
 * this check exists to make sure the fallback never triggers on an engine that
 * does not need it, because it costs real isolation.
 */
async function checkSandboxProbe () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  const served = await page.waitForFunction(async () => {
    const { sandboxWorks } = await import('/js/viewer.js')
    return sandboxWorks() !== null ? { verdict: sandboxWorks() } : null
  }, { timeout: 25_000 }).then(h => h.jsonValue()).catch(() => ({ verdict: 'timed out' }))
  check('the gate works out whether sandboxed frames reach the worker',
    served.verdict === true, JSON.stringify(served))

  // The probe endpoint is the worker's, so it must not be reachable without one.
  const direct = await page.evaluate(async prefix => {
    const res = await fetch(prefix + '/probe/')
    const body = await res.text()
    // The whole body, not a prefix of it: the marker sits after the doctype,
    // and slicing it off made this check fail on a worker that was answering
    // perfectly well.
    return { status: res.status, served: body.includes('served'), length: body.length }
  }, `${origin}/webtorrent`)
  check('the worker answers the probe', direct.status === 200 && direct.served,
    JSON.stringify(direct))

  // And with a working engine the sandbox is still there, unweakened.
  const magnet = await page.evaluate(async () => {
    const { publish } = await import('/js/publish.js')
    const index = new File(['<h1>sandboxed</h1>'], 'index.html', { type: 'text/html' })
    index.fullPath = 'sandboxed/index.html'
    const style = new File(['body{color:#111}'], 'style.css', { type: 'text/css' })
    style.fullPath = 'sandboxed/style.css'
    return (await publish([index, style], 'sandboxed')).magnetURI
  })
  await page.evaluate(m => { location.hash = m }, magnet)
  await page.waitForFunction(
    () => !document.getElementById('viewer').hidden, { timeout: 30_000 })
  check('a capable engine keeps the sandbox',
    (await page.$eval('#viewer', el => el.getAttribute('sandbox'))) === 'allow-same-origin',
    await page.$eval('#viewer', el => el.getAttribute('sandbox')))

  await page.close()
}

/**
 * A browser that throws the service worker away must not leave a dead page.
 *
 * Reported from an iPhone, and the diagnostics were unambiguous: worker not
 * controlling, no registrations at all, and a viewer response of 404 with 9379
 * bytes, which is the host's own error page. WebKit evicts registrations under
 * memory pressure mid-session. Spore checked for a controller once, when
 * opening the site, so nothing noticed and the reader was left with a white
 * page and a panel full of green.
 *
 * Unregistering here stands in for the eviction. A browser cannot be made to
 * drop a worker on demand, but the state that follows is the same one, and it
 * is the state that has to be survivable.
 */
async function checkWorkerIsPutBack () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  const magnet = await page.evaluate(async () => {
    const { publish } = await import('/js/publish.js')
    const index = new File(['<h1>worker watchdog</h1>'], 'index.html', { type: 'text/html' })
    index.fullPath = 'watchdog/index.html'
    const style = new File(['body{color:#111}'], 'style.css', { type: 'text/css' })
    style.fullPath = 'watchdog/style.css'
    return (await publish([index, style], 'watchdog')).magnetURI
  })
  await page.evaluate(m => { location.hash = m }, magnet)
  await page.waitForFunction(
    () => !document.getElementById('viewer').hidden, { timeout: 30_000 })

  // The eviction.
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      await registration.unregister()
    }
  })
  check('the registration really went away',
    (await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length))) === 0)

  // The watchdog runs on a timer, so this waits rather than polls once.
  const back = await page.waitForFunction(
    () => navigator.serviceWorker.getRegistrations().then(r => r.length > 0),
    { timeout: 60_000 }).then(() => true).catch(() => false)
  check('the gate notices and registers it again', back)

  const showing = await page.waitForFunction(() => {
    const frame = document.getElementById('viewer')
    return !frame.hidden && frame.src.includes('/webtorrent/')
  }, { timeout: 60_000 }).then(() => true).catch(() => false)
  check('and the site is showing again afterwards', showing,
    showing ? '' : await page.$eval('#status', el => el.textContent))

  await page.close()
}

/**
 * Having been told is what qualifies you to tell.
 *
 * A swarm's publisher is one peer among many, and a reader holding a complete
 * copy is rarely introduced to it: measured against a live swarm, a complete
 * client sat with two peers for two minutes and never met the seeder, however
 * often it re-announced. If the publisher is the only source of the news, those
 * readers never get it.
 *
 * They should not have to. A reader who has taken an update holds the record,
 * and handing it on costs nothing. Until this check existed the opposite
 * happened: taking an update tore down the watcher on the version it replaced,
 * so a reader stopped telling anyone the moment they had been told.
 *
 * Staged with the publisher gone, which is the case that matters.
 */
async function checkReadersPassItOn () {
  const publisher = await browser.createBrowserContext().then(c => c.newPage())
  const first = await browser.createBrowserContext().then(c => c.newPage())
  const second = await browser.createBrowserContext().then(c => c.newPage())

  for (const page of [publisher, first, second]) {
    await page.goto(origin + '/', { waitUntil: 'load' })
    await page.waitForFunction(
      () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })
  }

  const published = await publisher.evaluate(async () => {
    const { createIdentity, formatSporePub, saltFor } = await import('/js/identity.js')
    const { seedTorrent } = await import('/js/swarm.js')
    const { signUpdate } = await import('/js/record.js')
    const { watchForUpdates } = await import('/js/updates.js')

    const me = await createIdentity()
    const pub = formatSporePub(me.hex, 'Relay Author', 'relay')
    const version = async (body, name) => {
      const files = [
        new File([body], 'index.html', { type: 'text/html' }),
        new File([pub], 'spore.pub', { type: 'text/plain' })
      ]
      files[0].fullPath = `${name}/index.html`
      files[1].fullPath = `${name}/spore.pub`
      return await seedTorrent(files, { name })
    }
    const v1 = await version('<h1>relay one</h1>', 'relay-v1')
    const v2 = await version('<h1>relay two</h1>', 'relay-v2')
    const record = await signUpdate(
      me.privateKey, me.publicKey, v2.infoHash, Date.now(), saltFor('relay'))

    watchForUpdates(v1, {
      publicKey: () => me.publicKey,
      salt: () => saltFor('relay'),
      offer: () => record,
      currentInfoHash: () => v1.infoHash,
      onUpdate: () => {}
    })
    return { magnet: v1.magnetURI, v1: v1.infoHash, v2: v2.infoHash }
  })

  // The first reader hears it from the publisher, and takes it.
  await first.evaluate(m => { location.hash = m }, published.magnet)
  let told = false
  for (let waited = 0; waited < 60_000 && !told; waited += 2000) {
    await wait(2000)
    told = await first.$eval('#update', el => !el.hidden).catch(() => false)
  }
  check('the first reader is told by the publisher', told)
  if (told) await first.click('#update-open')
  await wait(3000)

  // Now the publisher leaves. Everything anyone learns from here comes from a
  // reader who was told.
  await publisher.close()
  await wait(2000)

  await second.evaluate(m => { location.hash = m }, published.magnet)
  let passed = false
  for (let waited = 0; waited < 90_000 && !passed; waited += 2000) {
    await wait(2000)
    passed = await second.$eval('#update', el => !el.hidden).catch(() => false)
  }
  check('a reader who took an update passes it to the next reader',
    passed,
    passed ? '' : await second.evaluate(() => ({
      status: document.getElementById('status').textContent,
      hash: location.hash.slice(0, 30)
    })).then(JSON.stringify))

  await first.close()
  await second.close()
}

/**
 * A site kept offline must still hear that a newer version exists.
 *
 * Reported: "if I have a page saved locally I never find out there is a new
 * version." True, and the cause was ordering. Restoring a kept site adds it to
 * the client, peers connect and exchange BEP 10 handshakes at once, and the
 * update watcher was attached afterwards. Those peers never learned this
 * browser spoke sp_update, so they never sent it one.
 *
 * Keeping a site is where this matters most: it is what a reader does with a
 * page they mean to come back to.
 */
async function checkKeptSiteHearsUpdates () {
  const publisher = await browser.createBrowserContext().then(c => c.newPage())
  const reader = await browser.createBrowserContext().then(c => c.newPage())
  reader.on('dialog', d => d.accept())

  for (const page of [publisher, reader]) {
    await page.goto(origin + '/', { waitUntil: 'load' })
    await page.waitForFunction(
      () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })
  }

  // Publishes two versions and offers the second to anyone on the first.
  const published = await publisher.evaluate(async () => {
    const { createIdentity, formatSporePub, saltFor } = await import('/js/identity.js')
    const { seedTorrent } = await import('/js/swarm.js')
    const { signUpdate } = await import('/js/record.js')
    const { watchForUpdates } = await import('/js/updates.js')

    const me = await createIdentity()
    const pub = formatSporePub(me.hex, 'Kept Author', 'kept')

    const version = async (body, name) => {
      const files = [
        new File([body], 'index.html', { type: 'text/html' }),
        new File([pub], 'spore.pub', { type: 'text/plain' })
      ]
      files[0].fullPath = `${name}/index.html`
      files[1].fullPath = `${name}/spore.pub`
      return await seedTorrent(files, { name })
    }

    const v1 = await version('<h1>kept one</h1>', 'kept-v1')
    const v2 = await version('<h1>kept two</h1>', 'kept-v2')

    const record = await signUpdate(
      me.privateKey, me.publicKey, v2.infoHash, Date.now(), saltFor('kept'))

    watchForUpdates(v1, {
      publicKey: () => me.publicKey,
      salt: () => saltFor('kept'),
      offer: () => record,
      currentInfoHash: () => v1.infoHash,
      onUpdate: () => {}
    })

    return { magnet: v1.magnetURI, v1: v1.infoHash, v2: v2.infoHash }
  })

  // The reader opens it and keeps it.
  await reader.evaluate(m => { location.hash = m }, published.magnet)
  await reader.waitForFunction(
    () => !document.getElementById('viewer').hidden, { timeout: 30_000 })
  await reader.click('#keep-toggle')
  // The suite's one intermittent failure lives here, roughly one run in six,
  // always this line. Not a timeout: puppeteer reports "Waiting failed" with no
  // duration, which is a terminated execution context rather than an expired
  // one — the page goes away underneath the wait. Raising the timeout did not
  // stop it, which is the evidence for that reading. Keeping writes a whole
  // torrent to IndexedDB in about the tenth browser context of a run, and
  // another context is holding a seventy-megabyte film at the same time, so a
  // renderer under memory pressure is the obvious suspect and is not yet a
  // demonstrated one. Written down rather than explained away.
  await reader.waitForFunction(
    () => !document.getElementById('kept').hidden, { timeout: 120_000 })

  // Then throws the live torrent away, so reopening has to come off disk. That
  // is a reader coming back tomorrow, which is the case that was broken.
  await reader.evaluate(async hash => {
    const { getClient } = await import('/js/swarm.js')
    location.hash = ''
    await (await getClient().get(hash)).destroy()
  }, published.v1)
  await wait(2000)

  await reader.evaluate(m => { location.hash = m }, published.magnet)

  // Polled rather than waited on in stages: reopening a kept site reads every
  // chunk back out of IndexedDB, which under a loaded suite can take longer
  // than any single timeout worth hard-coding. The offer is the thing being
  // measured, so wait for that and let the rendering happen when it happens.
  let offered = false
  for (let waited = 0; waited < 120_000 && !offered; waited += 2000) {
    await wait(2000)
    offered = await reader.$eval('#update', el => !el.hidden).catch(() => false)
  }
  check('a site kept offline is still told when a newer version exists',
    offered,
    offered ? '' : await reader.evaluate(() => ({
      status: document.getElementById('status').textContent,
      viewer: !document.getElementById('viewer').hidden,
      error: document.getElementById('error').hidden ? null
        : document.getElementById('error-title').textContent
    })).then(JSON.stringify))

  await publisher.close()
  await reader.close()
}

/**
 * Declaring a key must not be the same as holding one.
 *
 * Asked plainly by a reader of the spec: "anyone can download a .pub file, put
 * it with other files and publish under my name?" They could, and nothing
 * caught it. A copied `spore.pub` declares a real key, so a reader comparing
 * the fingerprint against the real person's got a match, and the site passed
 * every check Spore had.
 *
 * `spore.sig` signs every other file, so the three cases below are now
 * distinguishable: signed and intact, declared but unproven, and contradicted.
 */
async function checkContentSignature () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  page.on('dialog', d => d.accept('a phrase for the signing check'))
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  // --- an honestly published site ------------------------------------------
  const real = await page.evaluate(async () => {
    const { identityFromPassphrase, formatSporePub } = await import('/js/identity.js')
    const { manifestEntries, signManifest } = await import('/js/manifest.js')
    const { seedTorrent } = await import('/js/swarm.js')

    const me = await identityFromPassphrase('a phrase for the signing check')
    const pub = formatSporePub(me.hex, 'The Real Author', 'signed-site')
    const enc = new TextEncoder()
    const described = [
      { path: 'index.html', bytes: enc.encode('<h1>the real thing</h1>') },
      { path: 'style.css', bytes: enc.encode('body{color:#111}') },
      { path: 'spore.pub', bytes: enc.encode(pub) }
    ]
    const sig = await signManifest(me.privateKey, {
      key: me.hex, site: 'signed-site', entries: await manifestEntries(described)
    })

    const files = described.map(d => {
      const f = new File([d.bytes], d.path.split('/').pop(), { type: 'text/plain' })
      f.fullPath = `signed-site/${d.path}`
      return f
    })
    const sigFile = new File([sig], 'spore.sig', { type: 'text/plain' })
    sigFile.fullPath = 'signed-site/spore.sig'

    const torrent = await seedTorrent([...files, sigFile], { name: 'signed-site' })
    return { magnet: torrent.magnetURI, key: me.hex, pub, sig }
  })

  await page.evaluate(m => { location.hash = m }, real.magnet)
  await page.waitForFunction(
    () => document.getElementById('author')?.dataset.state &&
          document.getElementById('author').dataset.state !== 'checking',
    { timeout: 40_000 })
  check('a site whose files match its signature reads as verified',
    await page.$eval('#author', el => el.dataset.state === 'verified'),
    await page.$eval('#author', el => el.dataset.state))

  // --- the impersonation: somebody else's spore.pub, their own words -------
  const fake = await page.evaluate(async pub => {
    const { seedTorrent } = await import('/js/swarm.js')
    const files = [
      new File(['<h1>words the key never wrote</h1>'], 'index.html', { type: 'text/html' }),
      new File([pub], 'spore.pub', { type: 'text/plain' })
    ]
    files[0].fullPath = 'impostor/index.html'
    files[1].fullPath = 'impostor/spore.pub'
    return (await seedTorrent(files, { name: 'impostor' })).magnetURI
  }, real.pub)

  await page.evaluate(() => { location.hash = '' })
  await wait(500)
  await page.evaluate(m => { location.hash = m }, fake)
  await page.waitForFunction(
    () => document.getElementById('author')?.dataset.state &&
          document.getElementById('author').dataset.state !== 'checking',
    { timeout: 40_000 })
  check('a copied spore.pub with different content is not called verified',
    await page.$eval('#author', el => el.dataset.state === 'unverified'),
    await page.$eval('#author', el => el.dataset.state))

  // --- and the same trick carrying the real signature too -------------------
  const tampered = await page.evaluate(async ({ pub, sig }) => {
    const { seedTorrent } = await import('/js/swarm.js')
    const files = [
      // The signature is real, the bytes are not the ones it covers.
      new File(['<h1>the real thing, edited</h1>'], 'index.html', { type: 'text/html' }),
      new File(['body{color:#111}'], 'style.css', { type: 'text/css' }),
      new File([pub], 'spore.pub', { type: 'text/plain' }),
      new File([sig], 'spore.sig', { type: 'text/plain' })
    ]
    const names = ['index.html', 'style.css', 'spore.pub', 'spore.sig']
    files.forEach((f, i) => { f.fullPath = `tampered/${names[i]}` })
    return (await seedTorrent(files, { name: 'tampered' })).magnetURI
  }, { pub: real.pub, sig: real.sig })

  await page.evaluate(() => { location.hash = '' })
  await wait(500)
  await page.evaluate(m => { location.hash = m }, tampered)
  await page.waitForFunction(
    () => document.getElementById('author')?.dataset.state &&
          document.getElementById('author').dataset.state !== 'checking',
    { timeout: 40_000 })
  const state = await page.$eval('#author', el => el.dataset.state)
  check('altering a file under a real signature is caught and shown as broken',
    state === 'broken', state)

  // --- and the same trick by *adding* rather than changing --------------------
  // The defence that actually matters against a signed site smuggling unsigned
  // content: every byte a reader can be served has to be one the manifest
  // covers. The altered case above was checked and this one was not, which is
  // how a review came to believe there was a hole here.
  const smuggled = await page.evaluate(async ({ pub, sig }) => {
    const { seedTorrent } = await import('/js/swarm.js')
    const files = [
      // Untouched: the signature over these is genuinely valid.
      new File(['<h1>the real thing</h1>'], 'index.html', { type: 'text/html' }),
      new File(['body{color:#111}'], 'style.css', { type: 'text/css' }),
      new File([pub], 'spore.pub', { type: 'text/plain' }),
      new File([sig], 'spore.sig', { type: 'text/plain' }),
      // And one nobody signed, which the page could reach by relative link.
      new File(['body{background:url(http://tracker.example/x)}'], 'tracker.css',
        { type: 'text/css' })
    ]
    const names = ['index.html', 'style.css', 'spore.pub', 'spore.sig', 'extra/tracker.css']
    files.forEach((file, i) => { file.fullPath = `smuggled/${names[i]}` })
    return (await seedTorrent(files, { name: 'smuggled' })).magnetURI
  }, { pub: real.pub, sig: real.sig })

  await page.evaluate(() => { location.hash = '' })
  await wait(500)
  await page.evaluate(m => { location.hash = m }, smuggled)
  await page.waitForFunction(
    () => document.getElementById('author')?.dataset.state &&
          document.getElementById('author').dataset.state !== 'checking',
    { timeout: 40_000 })
  const smuggledState = await page.$eval('#author', el => el.dataset.state)
  check('a file nobody signed, added under a real signature, is caught too',
    smuggledState === 'broken', smuggledState)

  await page.close()
}

/**
 * A site that breaks after it opens must say so.
 *
 * Reported from an iPhone: a blank page, every diagnostic green, nothing to
 * quote. The cause was that `withMetadata` stops listening for `error` once
 * metadata arrives, so a torrent failing later — a storage layer refusing to
 * write is the realistic case, and WebKit throws exactly that — took the site
 * down silently. An unreportable failure is worse than a loud one.
 */
async function checkLateFailureIsVisible () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  const magnet = await page.evaluate(async () => {
    const { publish } = await import('/js/publish.js')
    const index = new File(['<h1>late failure</h1>'], 'index.html', { type: 'text/html' })
    index.fullPath = 'late-fail/index.html'
    const style = new File(['body{color:#111}'], 'style.css', { type: 'text/css' })
    style.fullPath = 'late-fail/style.css'
    return (await publish([index, style], 'late-fail')).magnetURI
  })
  await page.evaluate(m => { location.hash = m }, magnet)
  await page.waitForFunction(
    () => !document.getElementById('viewer').hidden, { timeout: 30_000 })

  // Exactly what WebKit produced when its storage gave up mid-read.
  await page.evaluate(async () => {
    const { getClient } = await import('/js/swarm.js')
    const torrent = getClient().torrents[getClient().torrents.length - 1]
    torrent.emit('error', new Error(
      'The operation failed for an unknown transient reason (e.g. out of memory).'))
  })
  await wait(500)

  const notice = await page.$eval('#notice', el => el.hidden ? '' : el.textContent)
  check('a site that fails after opening says so, quoting the error',
    /stopped working after it loaded/.test(notice) &&
    /unknown transient reason/.test(notice),
    notice.slice(0, 90))
  await page.close()
}

/**
 * The gate has to work on a phone, which nothing here checked until it did not.
 *
 * Reported as "page slides on the right, modals do not fit". Both were real: a
 * status bar that had quietly grown to seven items was 477px of content in a
 * 390px window and dragged the whole document sideways, and the dialogs were
 * sized in rem with no gutter and no height limit, so on a small screen they
 * touched both edges and ran off the bottom.
 *
 * Checked at three real widths rather than one, because 320 is where rem-sized
 * boxes stop fitting and 390 is not.
 */
async function checkMobileLayout () {
  for (const phone of [
    { width: 320, height: 568, name: 'small phone' },
    { width: 390, height: 844, name: 'typical phone' }
  ]) {
    const page = await browser.createBrowserContext().then(c => c.newPage())
    await page.setViewport({ ...phone, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    await page.goto(origin + '/', { waitUntil: 'load' })
    await page.waitForFunction(
      () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

    // With a site open, so the status bar carries everything it ever carries.
    const magnet = await page.evaluate(async () => {
      const { publish } = await import('/js/publish.js')
      const index = new File(['<h1>phone</h1>'], 'index.html', { type: 'text/html' })
      index.fullPath = 'phone/index.html'
      const style = new File(['body{color:#222}'], 'style.css', { type: 'text/css' })
      style.fullPath = 'phone/style.css'
      return (await publish([index, style], 'phone')).magnetURI
    })
    await page.evaluate(m => { location.hash = m }, magnet)
    await page.waitForFunction(
      () => !document.getElementById('viewer').hidden, { timeout: 30_000 })
    await page.click('#share-open')
    await wait(400)

    const spill = await page.evaluate(() => {
      const width = document.documentElement.clientWidth
      const over = []
      for (const el of document.querySelectorAll('body *')) {
        const box = el.getBoundingClientRect()
        if (box.width === 0 && box.height === 0) continue
        if (box.right > width + 1 || box.left < -1) {
          over.push(el.id || el.tagName.toLowerCase())
        }
      }
      return { scroll: document.documentElement.scrollWidth, width, over: over.slice(0, 5) }
    })
    check(`nothing spills off the side of a ${phone.name}`,
      spill.scroll <= spill.width, JSON.stringify(spill))

    // Not spilling is not the same as being usable, and only the first was ever
    // asked. With a site open the address field is `flex: 1` against two
    // checkboxes and measured twenty-six pixels across — two characters, on the
    // device this path exists for — while this check passed happily.
    const address = await page.$eval('#address', el => Math.round(el.getBoundingClientRect().width))
    check(`the address field is wide enough to paste into on a ${phone.name}`,
      address >= 120, `${address}px`)

    // Every dialog: inside the screen, with a gutter, and scrollable to its
    // buttons rather than running off the bottom.
    for (const id of ['signin-dialog', 'author-dialog', 'diagnostics',
      'isolation-dialog', 'no-entry-dialog']) {
      const fit = await page.evaluate(dialogId => {
        if (dialogId === 'signin-dialog') {
          document.getElementById('signin-step-enter').hidden = false
        }
        const dialog = document.getElementById(dialogId)
        dialog.showModal()
        dialog.scrollTop = dialog.scrollHeight

        const box = dialog.getBoundingClientRect()
        const width = document.documentElement.clientWidth
        const height = document.documentElement.clientHeight
        // The visible step's buttons. signin-dialog carries one .dialog-actions
        // per step and only one is shown; measuring the first in DOM order
        // measures a hidden one, which is never "reachable".
        const shown = [...dialog.querySelectorAll('.dialog-actions')]
          .find(row => row.getBoundingClientRect().height > 0)
        const last = shown.querySelector('button:last-child')
        const lastBox = last.getBoundingClientRect()
        dialog.close()

        return {
          gutter: Math.round(box.left) > 0 && Math.round(box.right) < width,
          withinHeight: box.height <= height + 1,
          lastButtonReachable: lastBox.bottom <= box.bottom + 1 && lastBox.top >= box.top - 1,
          box: `${Math.round(box.left)},${Math.round(box.width)}x${Math.round(box.height)}`
        }
      }, id)
      check(`${id} fits a ${phone.name}, with its buttons reachable`,
        fit.gutter && fit.withinHeight && fit.lastButtonReachable, JSON.stringify(fit))
    }
    // Both ways to choose files are pressed with a thumb here, and the folder
    // picker is the one that does not work on the device this matters most on.
    const buttons = await page.evaluate(() => {
      document.getElementById('welcome').hidden = false
      return [...document.querySelectorAll('.pick .button')].map(el => {
        const box = el.getBoundingClientRect()
        return { w: Math.round(box.width), h: Math.round(box.height), top: Math.round(box.top) }
      })
    })
    check(`both pickers are full-width and stacked on a ${phone.name}`,
      buttons.length === 2 &&
      buttons.every(b => b.w > phone.width * 0.6 && b.h >= 40) &&
      buttons[0].top !== buttons[1].top,
      JSON.stringify(buttons))

    await page.close()
  }
}

/**
 * A reader who meets the wrong peer first must still get the site.
 *
 * This is the failure that prompted the two-clock wait, and it looked exactly
 * like a dead site: one peer connected, nothing arrived, "This site could not
 * be found" — while the seeder was up the whole time and its own log proved it.
 * A browser cannot dial anyone; it meets whoever a tracker introduces it to. So
 * a reader can spend the whole budget talking to another reader, who has
 * nothing to give either.
 *
 * Staged here by seeding a site, taking the seed away, letting a reader find a
 * peer that holds nothing, and bringing the seed back afterwards. Under a
 * single 30s deadline the reader had already given up.
 */
async function checkSlowSwarm () {
  const publisher = await browser.createBrowserContext().then(c => c.newPage())
  const useless = await browser.createBrowserContext().then(c => c.newPage())
  const reader = await browser.createBrowserContext().then(c => c.newPage())

  for (const page of [publisher, useless, reader]) {
    await page.goto(origin + '/', { waitUntil: 'load' })
    await page.waitForFunction(
      () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })
  }

  // Published, then withdrawn: the magnet is live, the bytes are nowhere.
  // Two files, so this is a multi-file torrent and the paths keep their names.
  // A single file produces a single-file torrent whose one path *is* the
  // torrent name — no `.html`, so the gate correctly offers a file listing
  // rather than a page, and the check would be measuring the wrong thing.
  const magnet = await publisher.evaluate(async () => {
    const { seedTorrent, getClient } = await import('/js/swarm.js')
    const page = new File(['<h1>late arrival</h1>'], 'index.html', { type: 'text/html' })
    page.fullPath = 'late/index.html'
    const style = new File(['body{color:#333}'], 'site.css', { type: 'text/css' })
    style.fullPath = 'late/site.css'
    const torrent = await seedTorrent([page, style], { name: 'late' })
    const uri = torrent.magnetURI
    await getClient().remove(torrent.infoHash, { destroyStore: true })
    return uri
  })

  // A peer that joins and can offer nothing — the other reader in the story.
  await useless.evaluate(m => {
    import('/js/swarm.js').then(({ getClient }) => getClient().add(m))
  }, magnet)
  await wait(3000)

  await reader.evaluate(m => { location.hash = m }, magnet)

  // Past the old single deadline of 30s, so this measures the change rather
  // than the interval before it would have mattered.
  await wait(34_000)
  const midway = await reader.evaluate(() => ({
    failed: document.getElementById('error')?.hidden === false,
    peers: document.getElementById('peers')?.textContent
  }))
  check('a reader with a peer that has nothing keeps waiting past the old deadline',
    !midway.failed, JSON.stringify(midway))

  // The seed comes back. A re-announce should introduce them.
  await publisher.evaluate(async () => {
    const { seedTorrent } = await import('/js/swarm.js')
    const page = new File(['<h1>late arrival</h1>'], 'index.html', { type: 'text/html' })
    page.fullPath = 'late/index.html'
    const style = new File(['body{color:#333}'], 'site.css', { type: 'text/css' })
    style.fullPath = 'late/site.css'
    await seedTorrent([page, style], { name: 'late' })
  })

  let loaded = false
  for (let waited = 0; waited < 60_000 && !loaded; waited += 2000) {
    await wait(2000)
    loaded = await reader.evaluate(() => {
      const frame = document.getElementById('viewer')
      return !frame.hidden && frame.src.includes('/webtorrent/')
    })
  }
  check('and gets the site once a peer that has it turns up', loaded,
    loaded ? '' : await reader.$eval('#status', el => el.textContent))
}

/**
 * A key kept on this device, which is the convenient option and the risky one.
 *
 * What is stored is a non-extractable CryptoKey, so the check that matters is
 * not "does it come back" but "does it come back *usable* without the
 * passphrase" — and, just as much, does forgetting it actually forget it.
 */
async function checkRememberedKey () {
  const page = await browser.createBrowserContext().then(c => c.newPage())
  const ready = async () => page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  await page.goto(origin + '/', { waitUntil: 'load' })
  await ready()

  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['<h1>kept key</h1>'], 'index.html', { type: 'text/html' }))
    const input = document.getElementById('folder-input')
    input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForFunction(
    () => document.getElementById('signin-dialog').open, { timeout: 20_000 })
  await page.type('#signin-label', 'kept on this device')
  await page.type('#signin-passphrase', 'a different long phrase entirely')
  await page.click('#signin-continue')
  await page.waitForFunction(
    () => !document.getElementById('signin-step-confirm').hidden, { timeout: 30_000 })

  const expected = await page.$eval('#signin-fingerprint', el => el.textContent)
  await page.click('#signin-remember')
  await page.click('#signin-use')
  await page.waitForFunction(
    () => !document.getElementById('signed-in').hidden, { timeout: 30_000 })

  // The whole point: a reload, and no passphrase.
  await page.reload({ waitUntil: 'load' })
  await ready()
  await page.waitForFunction(
    () => !document.getElementById('signed-in').hidden, { timeout: 30_000 }).catch(() => {})

  const restored = await page.evaluate(() => ({
    shown: !document.getElementById('signed-in').hidden,
    fingerprint: document.getElementById('me-fingerprint').textContent,
    name: document.getElementById('me-name').textContent
  }))
  check('a key kept on this device comes back after a reload, with no passphrase',
    restored.shown && restored.fingerprint === expected, JSON.stringify(restored))
  check('it comes back under the name it was given',
    /kept on this device/.test(restored.name), restored.name)

  // And it must still be able to sign, which a key that survived as bytes but
  // not as a usable CryptoKey would not.
  const signed = await page.evaluate(async () => {
    const { me } = await import('/js/me.js')
    const { signUpdate } = await import('/js/record.js')
    const identity = me()
    if (!identity) return 'no identity'
    const record = await signUpdate(
      identity.privateKey, identity.publicKey, 'a'.repeat(40), 1)
    return record.sig.length
  })
  check('the restored key can still sign', signed === 64, String(signed))

  // Waited for, not assumed. Forgetting deletes a record from IndexedDB, and
  // reloading the instant the button is clicked can outrun the transaction —
  // which fails as "the key came back", a far more alarming thing than the
  // timing bug it actually is.
  await page.click('#signout')
  await page.waitForFunction(async () => {
    const { isRemembered } = await import('/js/me.js')
    return !(await isRemembered())
  }, { timeout: 15_000 })

  await page.reload({ waitUntil: 'load' })
  await ready()
  await wait(1500)
  check('forgetting it actually forgets it',
    await page.$eval('#signed-in', el => el.hidden))
}


/**
 * The signing core: bencode, BEP 44 records, identities.
 *
 * Run in the browser rather than in Node because that is where the code runs
 * and where WebCrypto's Ed25519 lives. Signatures are over exact bytes, so the
 * checks that matter are the ones a self-consistent implementation would still
 * fail: known-answer bencoding, and rejection of records that verify
 * cryptographically but should not be accepted.
 */
async function checkSigningCore (page) {
  const r = await page.evaluate(async () => {
    const { encode, decode, toHex, fromHex } = await import('/js/bencode.js')
    const { signUpdate, verifyUpdate, encodeRecord, decodeRecord, signableBytes } =
      await import('/js/record.js')
    const { createIdentity, identityFromPassphrase, identityFromSeed,
      parseSporePub, formatSporePub, fingerprint, avatar,
      normalizeSite, saltFor } = await import('/js/identity.js')

    const text = bytes => new TextDecoder().decode(bytes)
    const out = {}

    // --- bencode, against the values in the specification itself ------------
    out.bencodeKnown = [
      text(encode(42)) === 'i42e',
      text(encode(-1)) === 'i-1e',
      text(encode(0)) === 'i0e',
      text(encode('spam')) === '4:spam',
      text(encode(['spam', 42])) === 'l4:spami42ee',
      text(encode({ foo: 'bar' })) === 'd3:foo3:bare',
      // keys sorted by byte value, whatever order they were given in
      text(encode({ b: 1, a: 2 })) === 'd1:ai2e1:bi1ee'
    ].every(Boolean)

    out.bencodeRoundTrip = (() => {
      const value = { ih: new Uint8Array([1, 2, 3]), seq: 7, list: ['x', 9] }
      const back = decode(encode(value))
      return toHex(back.ih) === '010203' && back.seq === 7 &&
             text(back.list[0]) === 'x' && back.list[1] === 9
    })()

    out.bencodeRejectsTrailing = (() => {
      try { decode(new TextEncoder().encode('i42ejunk')); return false } catch { return true }
    })()

    // --- the signable buffer is BEP 44's, not a bencoded dictionary ---------
    // "3:seqi1e1:v" + bencoded v, with no enclosing d…e.
    out.signableShape = (() => {
      const v = { ih: fromHex('00'.repeat(20)) }
      const bytes = signableBytes({ seq: 1, v })
      const asText = text(bytes)
      return asText.startsWith('3:seqi1e1:vd2:ih20:') && !asText.startsWith('d')
    })()

    // --- identities ---------------------------------------------------------
    const alice = await createIdentity()
    out.publicKeyLength = alice.publicKey.length === 32 && /^[0-9a-f]{64}$/.test(alice.hex)

    const seed = new Uint8Array(32).fill(9)
    const a = await identityFromSeed(seed)
    const b = await identityFromSeed(seed)
    out.seedDeterministic = a.hex === b.hex

    const p1 = await identityFromPassphrase('correct horse battery staple gadget')
    const p2 = await identityFromPassphrase('correct horse battery staple gadget')
    const p3 = await identityFromPassphrase('correct horse battery staple gadgets')
    out.passphraseDeterministic = p1.hex === p2.hex
    out.passphraseTypoIsDifferentAuthor = p1.hex !== p3.hex

    // A derived key must actually be able to sign for its own public half.
    const derivedRecord = await signUpdate(p1.privateKey, p1.publicKey, 'ab'.repeat(20), 1)
    out.derivedKeySigns = (await verifyUpdate(derivedRecord, p1.publicKey)).ok === true

    // --- spore.pub ----------------------------------------------------------
    const parsed = parseSporePub(formatSporePub(alice.hex, 'Hacker One'))
    out.sporePubRoundTrip = parsed.hex === alice.hex && parsed.claimedName === 'Hacker One'
    out.sporePubNameOptional = parseSporePub(alice.hex + '\n').claimedName === null
    out.sporePubRejectsJunk = (() => {
      try { parseSporePub('not a key'); return false } catch { return true }
    })()

    // --- the record ---------------------------------------------------------
    const target = 'cd'.repeat(20)
    const record = await signUpdate(alice.privateKey, alice.publicKey, target, 2)
    const wire = decodeRecord(encodeRecord(record))

    out.verifies = (await verifyUpdate(wire, alice.publicKey)).ok === true
    out.returnsInfoHash = (await verifyUpdate(wire, alice.publicKey)).infoHash === target

    // Rule 2: signed by a key other than the one the site declares. This is
    // the one that stops a peer announcing a successor of its own.
    const mallory = await createIdentity()
    const forged = await signUpdate(mallory.privateKey, mallory.publicKey, 'ee'.repeat(20), 99)
    const wrongKey = await verifyUpdate(forged, alice.publicKey)
    out.rejectsOtherKey = wrongKey.ok === false && /different key/.test(wrongKey.reason)

    // The series. One key is one author, not one site: a record for the same
    // author's other site is authentic, correctly signed, and about something
    // else. Without this an author's second site announces itself as the
    // successor to their first.
    const blog = saltFor('blog')
    const notes = saltFor('notes')
    const forBlog = await signUpdate(
      alice.privateKey, alice.publicKey, 'ab'.repeat(20), 3, blog)

    out.acceptsMatchingSalt =
      (await verifyUpdate(forBlog, alice.publicKey, { salt: blog })).ok === true
    const crossed = await verifyUpdate(forBlog, alice.publicKey, { salt: notes })
    out.rejectsOtherSeries = crossed.ok === false && /different site/.test(crossed.reason)
    // An unsalted site must not accept a salted record either, nor the reverse.
    out.rejectsSaltedForUnsalted =
      (await verifyUpdate(forBlog, alice.publicKey)).ok === false
    out.rejectsUnsaltedForSalted =
      (await verifyUpdate(record, alice.publicKey, { salt: blog })).ok === false

    out.siteNamesAreCanonical =
      normalizeSite('  Blog  ') === 'blog' && normalizeSite('') === null
    out.siteNamesRefuseSpaces = (() => {
      try { normalizeSite('my blog'); return false } catch { return true }
    })()
    out.sporePubCarriesSite =
      parseSporePub(formatSporePub(alice.hex, 'Alice', 'Blog')).site === 'blog'

    // Rule 3: tampering with the payload after signing.
    const tampered = decodeRecord(encodeRecord(record))
    tampered.v.ih = fromHex('ff'.repeat(20))
    out.rejectsTamperedValue = (await verifyUpdate(tampered, alice.publicKey)).ok === false

    const bumped = decodeRecord(encodeRecord(record))
    bumped.seq = 500
    out.rejectsTamperedSeq = (await verifyUpdate(bumped, alice.publicKey)).ok === false

    // Rule 4 refuses what is older, and only what is older: a record equal to
    // the highest already seen still has to reach a reader who has gone back to
    // an older copy, or keeping a page means never hearing about its successor
    // again.
    const sameSeq = await verifyUpdate(wire, alice.publicKey,
      { knownSeq: 2, currentInfoHash: 'ab'.repeat(20) })
    out.offersWhatIsAlreadyKnown = sameSeq.ok === true

    // Rule 4: authentic but stale.
    const replay = await verifyUpdate(wire, alice.publicKey, { knownSeq: 5 })
    out.rejectsReplay = replay.ok === false && /is older than/.test(replay.reason)
    out.acceptsNewer = (await verifyUpdate(wire, alice.publicKey, { knownSeq: 1 })).ok === true

    // Rule 5: pointing at what is already open.
    out.rejectsSelfPointer =
      (await verifyUpdate(wire, alice.publicKey, { currentInfoHash: target })).ok === false

    // --- how a key is shown -------------------------------------------------
    out.fingerprint = await fingerprint(alice.publicKey)
    out.fingerprintStable = out.fingerprint === await fingerprint(alice.publicKey)
    out.fingerprintDiffers = out.fingerprint !== await fingerprint(mallory.publicKey)
    const svg = await avatar(alice.publicKey)
    out.avatarIsSvg = svg.startsWith('<svg') && svg.includes('viewBox="0 0 5 5"')
    out.avatarDiffers = svg !== await avatar(mallory.publicKey)

    return out
  })

  check('bencode matches the known values in the specification', r.bencodeKnown)
  check('bencode round-trips bytes, integers and nested values', r.bencodeRoundTrip)
  check('bencode refuses trailing junk', r.bencodeRejectsTrailing)
  check('the signed buffer is BEP 44 fields, not a bencoded dictionary', r.signableShape)
  check('a generated identity has a 32-byte public key', r.publicKeyLength)
  check('the same seed always gives the same identity', r.seedDeterministic)
  check('the same passphrase always gives the same identity', r.passphraseDeterministic)
  check('a mistyped passphrase silently gives a different author', r.passphraseTypoIsDifferentAuthor)
  check('a passphrase-derived key can sign for its own public half', r.derivedKeySigns)
  check('spore.pub round-trips a key and a claimed name', r.sporePubRoundTrip)
  check('spore.pub works without a claimed name', r.sporePubNameOptional)
  check('spore.pub refuses anything that is not a key', r.sporePubRejectsJunk)
  check('a signed update verifies and yields its infohash', r.verifies && r.returnsInfoHash)
  check('an update signed by another key is refused', r.rejectsOtherKey)
  check('an update for the same author\'s other site is refused', r.rejectsOtherSeries)
  check('a series and the default series are not interchangeable',
    r.acceptsMatchingSalt && r.rejectsSaltedForUnsalted && r.rejectsUnsaltedForSalted,
    JSON.stringify({ match: r.acceptsMatchingSalt, salted: r.rejectsSaltedForUnsalted, unsalted: r.rejectsUnsaltedForSalted }))
  check('site names are canonical, and refuse what would silently fork a series',
    r.siteNamesAreCanonical && r.siteNamesRefuseSpaces)
  check('spore.pub carries the series', r.sporePubCarriesSite)
  check('tampering with the infohash breaks the signature', r.rejectsTamperedValue)
  check('tampering with the sequence breaks the signature', r.rejectsTamperedSeq)
  check('an authentic but stale update is refused', r.rejectsReplay)
  check('a reader back on an older copy is told about the version they know',
    r.offersWhatIsAlreadyKnown)
  check('a newer update is accepted', r.acceptsNewer)
  check('an update pointing at the current version is refused', r.rejectsSelfPointer)
  check('a key has a stable, distinctive fingerprint',
    r.fingerprintStable && r.fingerprintDiffers, r.fingerprint)
  check('a key has a deterministic, distinctive avatar', r.avatarIsSvg && r.avatarDiffers)
}

/**
 * A torrent that is not a website still shows its contents.
 *
 * Most torrents in the world have no index.html — archives, albums, datasets.
 * Refusing them outright turned every one into a dead end, when their files are
 * perfectly serveable.
 */
async function checkTorrentWithoutIndex (page) {
  const hash = await page.evaluate(async () => {
    const files = [
      new File(['a movie would go here'], 'sintel.mp4', { type: 'video/mp4' }),
      new File(['some notes'], 'readme.txt', { type: 'text/plain' })
    ]
    files[0].fullPath = 'not-a-website/sintel.mp4'
    files[1].fullPath = 'not-a-website/readme.txt'

    const { seedTorrent } = await import('/js/swarm.js')
    const torrent = await seedTorrent(files, { name: 'not-a-website' })
    return torrent.infoHash
  })

  await page.evaluate(h => { location.hash = h }, hash)
  await page.waitForFunction(() => !document.getElementById('listing').hidden, { timeout: 30_000 })

  const listing = await page.evaluate(() => ({
    name: document.getElementById('listing-name').textContent,
    summary: document.getElementById('listing-summary').textContent,
    files: [...document.querySelectorAll('#listing-files .path')].map(el => el.textContent),
    errorHidden: document.getElementById('error').hidden,
    viewerHidden: document.getElementById('viewer').hidden
  }))
  check('a torrent with no index.html lists its files instead of failing',
    listing.files.length === 2 && listing.errorHidden && listing.viewerHidden,
    JSON.stringify(listing))
  check('the listing names the torrent and its size',
    listing.name === 'not-a-website' && listing.summary.includes('2 files'),
    `${listing.name} — ${listing.summary}`)

  // Picking a file opens it in the same sandboxed viewer a site would use.
  await page.click('#listing-files button')
  await page.waitForFunction(() => !document.getElementById('viewer').hidden, { timeout: 15_000 })
  const opened = await page.evaluate(() => ({
    src: document.getElementById('viewer').src,
    sandbox: document.getElementById('viewer').getAttribute('sandbox')
  }))
  check('a file from the listing opens in the viewer, still sandboxed',
    opened.src.includes(hash) && opened.sandbox.trim() === 'allow-same-origin',
    JSON.stringify(opened))

  await page.evaluate(() => { location.hash = '' })
  await wait(500)
}

/**
 * A kept site survives a reload with nobody seeding it.
 *
 * The reported sequence: keep a site, close the tab that published it, reload.
 * The site was lost — which is precisely what keeping it is supposed to
 * prevent. Reloading discards the client, so after it there is no peer
 * anywhere and the only possible source is IndexedDB.
 */
async function checkKeptSiteSurvivesReload (page) {
  const kept = await browser.createBrowserContext()
  const victim = await kept.newPage()
  victim.on('dialog', async dialog => { await dialog.accept() })

  await victim.goto(origin + '/', { waitUntil: 'load' })
  await victim.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  const hash = await victim.evaluate(async (site, paths) => {
    const files = []
    for (const path of paths) {
      const res = await fetch(`/${site}/${path}`)
      const file = new File([await res.blob()], path.split('/').pop())
      file.fullPath = `${site}/${path}`
      files.push(file)
    }
    const { publish } = await import('/js/publish.js')
    return (await publish(files, site)).infoHash
  }, SITE, SITE_FILES)

  await victim.evaluate(h => { location.hash = h }, hash)
  await victim.waitForFunction(() => {
    const frame = document.getElementById('viewer')
    return !frame.hidden && frame.src.includes('/webtorrent/')
  }, { timeout: 30_000 })

  await victim.click('#keep-toggle')
  await victim.waitForFunction(() => !document.getElementById('kept').hidden, { timeout: 30_000 })

  // The reload throws the swarm client away. Nothing else has these bytes.
  await victim.reload({ waitUntil: 'load' })

  let rendered = false
  for (let waited = 0; waited < 45_000 && !rendered; waited += 2000) {
    await wait(2000)
    rendered = await victim.evaluate(() => {
      const frame = document.getElementById('viewer')
      return !frame.hidden && frame.src.includes('/webtorrent/')
    })
  }
  check('a kept site comes back after a reload with nobody seeding it', rendered,
    await victim.evaluate(() => document.getElementById('error-title').textContent ||
      document.getElementById('notice').textContent))

  if (rendered) {
    const frame = victim.frames().find(f => f.url().includes('/webtorrent/'))
    const heading = await frame?.evaluate(() => document.querySelector('h1')?.textContent)
    check('and it renders from disk, not from a peer', heading === 'Spore', heading)
  }

  await kept.close()
}

/**
 * An uncontrolled page must recover on its own.
 *
 * Reported from Chromium as `Worker controlling: NO` with a registration
 * present at `/` — the worker installed and simply never took this page over.
 * A hard reload produces exactly that state, and `clients.claim()` only runs on
 * activate, which happened long before. Asking the worker to claim is the fix;
 * this checks the ask works, starting from a genuinely uncontrolled page.
 */
async function checkUncontrolledPageRecovers (page) {
  const recovered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const before = !!navigator.serviceWorker.controller

    const claimed = await new Promise(resolve => {
      const { port1, port2 } = new MessageChannel()
      const timer = setTimeout(() => resolve(null), 3000)
      port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(data) }
      registration.active.postMessage({ type: 'spore/claim' }, [port2])
    })
    return { before, claimed, after: !!navigator.serviceWorker.controller }
  })

  // Honest about what this proves. A page that is genuinely uncontrolled
  // cannot be manufactured here — a hard reload is the way to get one and no
  // automation API performs one — so this covers the round-trip and the
  // resulting state, not the recovery itself. The recovery is the same call.
  check('the worker answers a request to claim this page',
    recovered.claimed?.claimed === true, JSON.stringify(recovered))
  check('the page is controlled after claiming', recovered.after === true, JSON.stringify(recovered))
}

/**
 * A viewer that never navigates must be detected, not left blank.
 *
 * Reported as "I see the frame of the website but not the content", with the
 * only trace a console line showing the frame still on about:blank. The silence
 * was as much the bug as the blank frame.
 *
 * Driving Viewer directly is deliberate. The obvious approach — blocking the
 * frame's request — cannot work, and finding out why was the useful part: the
 * service worker answers that request, so it never reaches the network layer an
 * automation tool can interfere with. A URL the gate's own `frame-src` refuses
 * leaves the frame exactly where the report described it.
 */
async function checkStuckViewerIsDetected (page) {
  const result = await page.evaluate(async () => {
    const { Viewer } = await import('/js/viewer.js')
    const frame = document.createElement('iframe')
    frame.src = 'about:blank'
    document.body.append(frame)
    const viewer = new Viewer(frame)

    const refused = await viewer.show('https://example.invalid/nope.html', { scripts: false })
    const accepted = await viewer.show(location.origin + '/example-site/index.html', { scripts: false })
    frame.remove()
    return { refused, accepted }
  })

  check('a viewer that never navigates is detected', result.refused === false, JSON.stringify(result))
  check('a viewer that does navigate is not falsely accused', result.accepted === true, JSON.stringify(result))
}

/**
 * Content isolation: each site on an origin of its own.
 *
 * A second gate, served with the option on. `spore.localhost` and
 * `<hash>.content.spore.localhost` reach the same local server: the browser
 * resolves `*.localhost` to loopback and treats it as a secure context, so no
 * certificate or DNS is involved. The gate's hostname is the *parent* of the
 * content domain on purpose — that makes them same-site but cross-origin, which
 * is the relationship a real deployment has and the one storage partitioning
 * cares about. See spec/second-origin-isolation.md.
 *
 * What is checked is the boundary, not only that pages arrive: that a site
 * with scripts on cannot reach the gate's storage or worker, and that the gate
 * answers a content origin about its own torrent and no other.
 */
async function runIsolated () {
  const isoPort = await freePort()
  const gate = `http://spore.localhost:${isoPort}`
  const content = `content.spore.localhost:${isoPort}`
  const isoServer = spawn(process.execPath, [
    fileURLToPath(new URL('serve.mjs', import.meta.url)), String(isoPort),
    '--isolation', `${gate},${content}`,
    ...(tracker ? ['--trackers', trackerURL] : [])
  ], { stdio: 'ignore' })

  const page = await browser.newPage()
  const asked = []
  page.on('dialog', async dialog => { asked.push(dialog.message()); await dialog.accept() })

  try {
    await wait(500)
    await page.goto(gate + '/', { waitUntil: 'load' })
    await page.waitForFunction(
      () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })
    check('isolation: a gate configured for it boots', true)

    const infoHash = await page.evaluate(async (site, paths) => {
      const files = []
      for (const path of paths) {
        const res = await fetch(`/${site}/${path}`)
        const file = new File([await res.blob()], path.split('/').pop())
        file.fullPath = `${site}/${path}`
        files.push(file)
      }
      const { publish } = await import('/js/publish.js')
      return (await publish(files, site)).infoHash
    }, SITE, SITE_FILES)
    const siteOrigin = `http://${infoHash}.${content}`

    await page.evaluate(hash => { location.hash = hash }, infoHash)
    await page.waitForFunction(() => {
      const frame = document.getElementById('viewer')
      return !frame.hidden && frame.src.includes('/relay.html')
    }, { timeout: 20_000 })

    const viewer = await page.$eval('#viewer', f => ({ src: f.src, sandbox: f.getAttribute('sandbox') }))
    check('isolation: the viewer frames the site\'s own origin, not the gate\'s',
      viewer.src.startsWith(`${siteOrigin}/relay.html?`), viewer.src)
    check('isolation: the relay is sandboxed with only what it needs',
      viewer.sandbox === 'allow-same-origin allow-scripts', viewer.sandbox)

    const site = await siteFrame(page)
    const rendered = await site.evaluate(() => ({
      origin: location.origin,
      heading: document.querySelector('h1')?.textContent,
      colour: getComputedStyle(document.querySelector('h1')).color,
      image: document.images[0]?.complete && document.images[0]?.naturalWidth > 0,
      probe: document.getElementById('probe')?.textContent,
      sandbox: window.frameElement?.getAttribute('sandbox')
    }))
    check('isolation: the site renders from its own origin', rendered.origin === siteOrigin &&
      rendered.heading === 'Spore', `${rendered.origin} ${rendered.heading}`)
    check('isolation: its stylesheet and image arrive through the relay',
      rendered.colour === 'rgb(47, 143, 69)' && rendered.image === true, rendered.colour)
    check('isolation: scripts are off by default',
      rendered.probe === 'Scripts are off.' && rendered.sandbox === 'allow-same-origin', rendered.probe)
    check('isolation: the gate does not call a site that arrived stuck',
      await page.$eval('#notice', n => n.hidden || !n.textContent.includes('stayed blank')))

    // The policy the site's own worker sends. Read from the relay, which shares
    // the site's origin and is allowed to fetch.
    const relay = page.frames().find(f => f.url().includes('/relay.html'))
    const entry = viewer.src.includes('path=') ? new URL(viewer.src).searchParams.get('path') : ''
    const policy = await relay.evaluate(async url => {
      const res = await fetch(url)
      await res.text()
      return res.headers.get('content-security-policy')
    }, `/webtorrent/${infoHash}/${entry}`)
    check('isolation: the site may be framed by the relay and the gate, and nothing else',
      policy?.includes(`frame-ancestors 'self' ${gate}`), policy?.match(/frame-ancestors [^;]*/)?.[0])
    check('isolation: the site\'s policy still denies scripts and egress',
      policy?.includes("script-src 'none'") && policy?.includes("connect-src 'none'"))

    const otherHash = 'b'.repeat(40)
    // Refused by the site's own worker, before the gate is even asked — the
    // text says which layer answered, so each one is checked on its own.
    const foreign = await relay.evaluate(async url => {
      const res = await fetch(url)
      return `${res.status} ${await res.text()}`
    }, `/webtorrent/${otherHash}/index.html`)
    check('isolation: a site\'s origin serves no other torrent',
      foreign === '403 This address serves one site only.', foreign)

    // The gate is the one that must refuse, whatever a content origin asks.
    // Posted from the relay's own window — the only one the gate listens to —
    // naming another torrent's file.
    const answer = await relay.evaluate((gateOrigin, other, own) => new Promise(resolve => {
      const ask = url => new Promise(done => {
        const { port1, port2 } = new MessageChannel()
        port1.onmessage = ({ data }) => { port1.postMessage(false); done(data.status) }
        parent.postMessage({ spore: 'relay/request', request: { url, method: 'GET', headers: {} } },
          gateOrigin, [port2])
        setTimeout(() => done('no answer'), 5000)
      })
      Promise.all([
        ask(`${location.origin}/webtorrent/${other}/index.html`),
        ask(`http://${other}.${location.host.split('.').slice(1).join('.')}/webtorrent/${other}/index.html`),
        ask(`${location.origin}/webtorrent/${own}`)
      ]).then(resolve)
    }), gate, otherHash, `${infoHash}/${entry}`)
    check('isolation: the gate refuses a content origin asking for another torrent',
      answer[0] === 403 && answer[1] === 403, JSON.stringify(answer))
    check('isolation: and answers it about its own', answer[2] === 200, JSON.stringify(answer))

    // --- scripts on: the boundary this whole mode exists for -----------------
    asked.length = 0
    await page.click('#scripts-toggle')
    const on = await settle(page, () => document.getElementById('probe')?.textContent,
      text => text === 'Scripts are on for this site.')
    check('isolation: the reader can still turn scripts on', on === 'Scripts are on for this site.', on)
    check('isolation: and is told the site is kept apart, not warned it reaches everything',
      /address of its own/.test(asked[0] ?? '') && !/every site:/.test(asked[0] ?? ''),
      (asked[0] ?? '').split('\n')[2])

    await page.evaluate(() => localStorage.setItem('spore.isolation-canary', 'gate-only'))
    const scripted = await siteFrame(page)
    const reach = await scripted.evaluate(async () => {
      const attempt = fn => { try { return fn() } catch (err) { return `refused: ${err.name}` } }
      const result = {
        readGate: attempt(() => top.localStorage.getItem('spore.isolation-canary')),
        writeGate: attempt(() => { top.localStorage.setItem('spore.scripts-allowed', '["x"]'); return 'wrote' }),
        gateDocument: attempt(() => top.document.title),
        ownStorage: attempt(() => localStorage.getItem('spore.isolation-canary'))
      }
      // Relaxation needs both sides; the gate never opts in, so this must not help.
      attempt(() => { document.domain = 'spore.localhost' })
      result.afterDomain = attempt(() => top.localStorage.getItem('spore.isolation-canary'))
      // The gate listens to the relay it framed and to nothing else, even from
      // the same origin: a request posted by the site itself goes unanswered.
      result.gateAnswersSite = await new Promise(resolve => {
        const { port1, port2 } = new MessageChannel()
        port1.onmessage = ({ data }) => { port1.postMessage(false); resolve(data.status) }
        top.postMessage({ spore: 'relay/request',
          request: { url: document.URL, method: 'GET', headers: {} } }, '*', [port2])
        setTimeout(() => resolve('no answer'), 3000)
      })
      // Its worker's questions go to the relay, never to the site: count what
      // reaches this window while it makes a request that needs an answer.
      let overheard = 0
      navigator.serviceWorker.addEventListener('message', () => { overheard++ })
      navigator.serviceWorker.startMessages()
      await (await fetch(document.URL, { cache: 'no-store' })).text()
      await new Promise(resolve => setTimeout(resolve, 500))
      result.overheard = overheard
      // Everything it can see of workers is its own origin's.
      const registrations = await navigator.serviceWorker.getRegistrations()
      result.workers = registrations.map(r => new URL(r.scope).origin)
      await Promise.all(registrations.map(r => r.unregister()))
      return result
    })
    check('isolation: a scripted site cannot read the gate\'s storage',
      String(reach.readGate).startsWith('refused'), reach.readGate)
    check('isolation: nor write to it', String(reach.writeGate).startsWith('refused'), reach.writeGate)
    check('isolation: nor reach the gate\'s document', String(reach.gateDocument).startsWith('refused'),
      reach.gateDocument)
    check('isolation: and setting document.domain changes nothing',
      String(reach.afterDomain).startsWith('refused'), reach.afterDomain)
    check('isolation: its own storage is its own, empty of the gate\'s', reach.ownStorage === null,
      reach.ownStorage)
    check('isolation: the gate ignores a request posted by the site instead of its relay',
      reach.gateAnswersSite === 'no answer', reach.gateAnswersSite)
    check('isolation: the site\'s worker asks the relay, and the site overhears nothing',
      reach.overheard === 0, reach.overheard)
    check('isolation: the only workers it can see are its own origin\'s',
      reach.workers.every(o => o === siteOrigin), JSON.stringify(reach.workers))

    const gateSide = await page.evaluate(async () => ({
      canary: localStorage.getItem('spore.isolation-canary'),
      allowed: localStorage.getItem('spore.scripts-allowed'),
      worker: !!(await navigator.serviceWorker.getRegistration())
    }))
    check('isolation: the gate\'s storage is untouched', gateSide.canary === 'gate-only' &&
      !String(gateSide.allowed).includes('"x"'), JSON.stringify(gateSide))
    check('isolation: unregistering every worker it could see left the gate\'s alone',
      gateSide.worker === true)

    // It broke its own origin's worker; showing it again must repair that.
    await page.click('#scripts-toggle')
    const off = await settle(page, () => document.getElementById('probe')?.textContent,
      text => text === 'Scripts are off.')
    check('isolation: turning scripts off takes effect, and the relay re-registers its worker',
      off === 'Scripts are off.', off)
  } finally {
    await page.close()
    isoServer.kill()
  }
}

/**
 * Read something out of the site frame until it settles on an expected value.
 * The frame reloads underneath us whenever the policy changes, so a fixed sleep
 * either flakes or wastes time.
 */
async function settle (page, read, done, attempts = 40) {
  let last
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      last = await (await siteFrame(page)).evaluate(read)
      if (done(last)) return last
    } catch { /* the frame is mid-navigation; try again */ }
    await wait(250)
  }
  return last
}

/** The site's frame, once its document has actually settled. */
async function siteFrame (page) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const frame = page.frames().find(f => f.url().includes('/webtorrent/'))
    if (frame) {
      try {
        if (await frame.evaluate(() => document.readyState === 'complete')) return frame
      } catch { /* context swapped mid-navigation; look again */ }
    }
    await wait(250)
  }
  throw new Error('the site frame never finished loading')
}

function fetchHeaders (page, infoHash, path) {
  return page.evaluate(async (hash, file) => {
    const res = await fetch(`/webtorrent/${hash}/${file}`)
    await res.text()
    return Object.fromEntries(res.headers.entries())
  }, infoHash, path)
}

/**
 * A local WebTorrent tracker, or nothing.
 *
 * Optional on purpose: `bittorrent-tracker` is a dev dependency and a fresh
 * clone should still run this suite. Without it the checks fall back to the
 * public trackers, which is slower and flakier but not wrong.
 */
async function startTracker (port) {
  let Server
  try {
    ({ Server } = await import('bittorrent-tracker'))
  } catch {
    console.log('  (no local tracker: npm install bittorrent-tracker for faster, ' +
      'deterministic peer discovery)')
    return null
  }

  const server = new Server({ udp: false, http: false, ws: true, stats: false })
  server.on('error', () => {}) // a tracker complaining is not a test failure
  server.on('warning', () => {})
  await new Promise(resolve => server.listen(port, resolve))
  return server
}

function freePort () {
  return new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * The seeder still serves its newest version after a restart.
 *
 * Nothing in this suite ran `tools/seed.mjs` at all, which is how the following
 * reached production. `client.seed` on bytes the client already holds does not
 * fail — it warns and hands the callback the *live* torrent instead. On every
 * restart the seeder re-seeded each version from disk, hashed the live folder,
 * found it identical to the newest, concluded there was nothing to publish, and
 * destroyed what it had been handed: the seed of the version whose magnet it
 * had just printed. It went on announcing, went on reporting three versions and
 * no errors, and answered nothing. Readers got "This site could not be found"
 * from a server that was up.
 *
 * So the check is the restart, and the assertion is the file count — the one
 * number that was wrong, and the one a monitor can watch.
 */
async function checkTheSeederSurvivesARestart () {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'spore-seeder-'))
  const site = join(root, 'site')
  await mkdir(site, { recursive: true })
  await writeFile(join(site, 'index.html'), '<h1>restarted</h1>')
  await writeFile(join(site, 'style.css'), 'body{color:#333}')

  const seeder = fileURLToPath(new URL('seed.mjs', import.meta.url))

  // Signed, because the second defect this guards is about offers, and there
  // are none without a key. Signing adds spore.pub and spore.sig to the two
  // written above, so the site the seeder publishes is four files.
  const FILES = 4
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [seeder], {
      env: {
        ...process.env,
        SPORE_CONTENT: site,
        SPORE_DATA: join(root, 'data'),
        SPORE_SITE_NAME: 'restart-me',
        SPORE_SITE: 'restart-me',
        SPORE_PASSPHRASE: 'a passphrase long enough to sign a site with',
        SPORE_STATUS_PORT: '0',
        SPORE_WATCH_SECONDS: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    const finish = value => { clearTimeout(timer); child.kill('SIGKILL'); resolve(value) }
    const read = () => ({
      out,
      files: Number(/newest is (\d+) files/.exec(out)?.[1] ?? NaN),
      offering: Number(/Offering \w+ to readers of (\d+) older/.exec(out)?.[1] ?? NaN)
    })
    const timer = setTimeout(() => finish(read()), 90_000)

    child.on('error', reject)
    child.stderr.on('data', data => { out += data })
    child.stdout.on('data', data => {
      out += data
      // "Leave this running" is the last line of the opening report, so it is
      // the point at which every number this check reads has been printed.
      if (/Leave this running/.test(out)) finish(read())
    })
  })

  const first = await start()
  check('the seeder serves its files on a first start', first.files === FILES,
    `${first.files} files`)

  // The same data directory, unchanged content: every version is restored from
  // disk and the live folder duplicates the newest. This is the shape that was
  // broken, and it is what every `docker compose up` does.
  const second = await start()
  check('and still serves them after a restart with the folder unchanged',
    second.files === FILES, `${second.files} files`)
  check('the restart is the duplicate path, not a different one',
    /same id is already being seeded/.test(second.out),
    second.out.split('\n').find(line => /same id/.test(line)) ?? 'no duplicate warning')

  // An edit, so there is an older version for the newest to be offered to.
  await writeFile(join(site, 'index.html'), '<h1>restarted, and edited</h1>')
  const third = await start()
  check('publishing a second version offers it to readers of the first',
    third.offering === 1, `offering ${third.offering}`)

  // And the restart again, which is where the offer used to disappear:
  // `refreshOffers` was reached only from the branch that publishes, and an
  // unchanged folder returns before it. The seeder went on holding the old
  // version and never mentioned the new one to anybody reading it.
  const fourth = await start()
  check('and still offers it after a restart with the folder unchanged',
    fourth.offering === 1, `offering ${fourth.offering}`)

  await rm(root, { recursive: true, force: true })
}
