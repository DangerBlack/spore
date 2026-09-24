# A second origin for content

**Status: implemented behind `CONTENT_ISOLATION` in `js/config.js`, off by
default.** Delivery, the relay, the content-mode worker, Diagnostics and the
deploy example are built and covered by `tools/e2e.mjs` in Chromium; Firefox was
checked by hand. Not done: the trust chip and address bar for a site on a
second hostname (deliberately deferred, below), and any measurement on WebKit.
The document keeps its earlier, wrong plans visible where the design changed,
in the manner of [mutable-sites.md](mutable-sites.md), because why a thing is
not built a certain way is as useful as how it is.

## The problem

A site with scripts disabled — the default — cannot use the gate's origin for
anything, because there is no code inside it to use it with. Two layers hold:
the sandboxed iframe, and the Content-Security-Policy `sw.js` attaches to every
response. Both are described in `SECURITY.md`.

A site the reader has opted scripts on for is a different matter. It runs on
the gate's own origin — same hostname, same `localStorage`, same IndexedDB,
same service worker registration — because `viewer.js` explains why it has to:
a document with an opaque origin is never controlled by a service worker, and
the worker is the only thing that can serve torrent bytes as HTTP responses at
all. So the choice, today, is same origin or no content.

That means a site the reader trusted enough to run scripts *at all* can also,
by the ordinary rules of the same-origin policy and nothing more exotic:

- read and rewrite `localStorage['spore.authors']`, `spore.scripts-allowed`,
  `spore.published` — every other site's trust state, not only its own
- unregister the one service worker every open Spore tab depends on to render
  anything, repeatedly, faster than a watchdog can re-register it
- if the reader has chosen to keep a signing key on this device, invoke it —
  not export it, invoke it — to sign as the publisher, from outside the app's
  own consent dialogs entirely

None of this needs a bug. It is what "same origin" grants by design, and the
reader agreed to exactly one thing: run this site's scripts. What they get is
every other site's data too, for as long as the malicious tab stays open, and
in the case of a remembered key, a capability that outlives the tab closing.

This is already written down as "the known hole" in `SECURITY.md`, and the fix
named there is one line: *a second origin for content*. This document is about
what that line actually costs, because it is not one line to build.

## What isolation already exists, and where it stops

`sw.js` refuses a request for `/webtorrent/<A>/…` made by a document that
belongs to torrent `<B>` — that is *torrent-to-torrent* isolation, and it is
enforced in code, not by the platform, precisely because CSP path-prefix
matching turned out to be enforced differently by different browsers (see
`SECURITY.md`'s account of the Firefox/Chrome disagreement). It holds
regardless of scripts.

What does not exist, at any layer, is *content-to-gate* isolation once scripts
are on. The sandbox withholds top-level navigation, popups, forms — but not
the origin itself, because the origin is shared on purpose, for the reason
above. A second origin for content would close this gap by making the
platform's own same-origin policy do the work `askingTorrent()` currently does
by hand for torrents — but between content and the gate, not between one
torrent and another.

## The approach, sketched

**Serve content from an origin the gate does not share**, so that a scripted
site's reach stops at the platform boundary instead of at application code.

The obvious version — one fixed second hostname, `content.example` — is not
enough on its own. It would isolate every site from the gate, but it would not
isolate sites from *each other*: torrent A's script could reach torrent B's
`localStorage` on `content.example` exactly as a scripted site reaches the
gate's today. The isolation `askingTorrent()` provides now is per torrent, and
a structural fix should not regress it. So the address space has to be
per-torrent, not a single second hostname:

    https://<infoHash>.content.example/index.html

Each infohash gets the browser's own origin boundary for free, the same way
each `.onion` or each Netlify preview deploy does. No code has to remember
which torrent a request belongs to; the browser already knows, because it is
part of the hostname.

**Behind one flag, off by default.** Whatever gets built here has to cost
nothing for a mirror that cannot run it. The plan is one configuration value —
`CONTENT_ISOLATION` in `js/config.js`, `null` unless a mirror operator
sets and rebuilds with their own — read the same way `DEFAULT_TRACKERS` already
is: a constant a mirror operator edits and recompiles with, not something
fetched or negotiated at runtime. `null` (the default, and what any plain
`username.github.io` mirror ships) means the gate behaves exactly as it does
today — same origin, same known hole, same honestly-worded warning. Only a
mirror that has set the value attempts anything in this document at all.

That default has one more consequence worth stating plainly: because most
mirrors will never set it, `SCRIPTS_WARNING` in `js/app.js` has to keep telling
the truth about the *common* case, not the aspirational one. The dialog text
must read the current value of `CONTENT_ISOLATION` and say one of two
different things — the honest "this shares Spore's own storage and can disrupt
every other open tab" when it is `null`, or "this site is isolated on its own
address" when a mirror has enabled it. Shipping one warning that is only true
on the rare mirror, while implying it everywhere, would be worse than the
warning that exists today.

What still has to be solved, and is not solved by picking this shape:

1. **Delivery — worked through below.** It is not a hosting change: a request
   on the content origin has to reach a WebTorrent client that lives in the
   gate's page, across an origin boundary, and be answered only if it asks
   for its own torrent.
2. **Discovery.** The gate's own page has to learn, or be told, the address of
   its paired content origin. A fixed relationship (`gate.example` implies
   `*.content.example`) is the simplest answer and couples the two at deploy
   time, which is at least honest about the fact that they are one system with
   two hostnames. This is what `CONTENT_ISOLATION` above already answers.
3. **The trust chip.** `js/app.js`'s "verified" indicator, and the address bar
   itself, live in the gate's chrome. If content renders on a different
   origin, the reader is looking at two hostnames for one site — the one they
   asked for and the one it actually rendered on — and the UI has to make that
   legible rather than confusing. This did not need solving before, because
   there was only ever one hostname to show. **Deliberately deferred**: get
   delivery right first, on a second pass redesign the chip around it.

## Delivery, worked through

The first pass of this document said the content origin needs "a second
service worker... that bridges each request back to the gate's page over
`postMessage`," as if that were the whole of it. It is not, and the gap
matters enough to spell out before anyone starts writing this.

### Why a relay needs more than forwarding

`js/swarm.js` does not implement the page-side half of serving a torrent as
HTTP. It calls `client.createServer({ controller: registration })` and the
vendored WebTorrent bundle does the rest: it listens for message events on
`navigator.serviceWorker` — from *its own* registered worker, on *its own*
origin — and answers them from the torrent's pieces. A message relayed from a
content frame arrives on `window` instead, from a different origin, and that
listener never sees it. Something on the gate has to receive it, decide
whether to answer at all, and only then hand it on.

The first version of this section concluded from this that the listener could
not be reused and a second serving path had to be written. That was wrong, as
the next section explains: the listener's handler can simply be *called*.

### What has to be built instead — and what does not

An earlier draft of this section called for a **second, hand-written
implementation** of "turn a path in this torrent into an HTTP response" on
WebTorrent's public `File` API, and named it the largest risk in the document:
two implementations of range handling, content types and streaming that must
agree forever. Reading WebTorrent's own source (`lib/server.js`, the same
3.0.21 the vendored bundle is built from — byte-identical) removed that risk
entirely, and the correction matters enough to keep the earlier plan visible.

`BrowserServer.wrapRequest(event)` reads exactly two things from its argument:
`event.data`, the request (`url`, `method`, `headers`, `destination`), and
`event.ports[0]`, the port to answer on. It never checks that the event came
from a service worker. `client.createServer()` returns that server, and the
method name survives minification. So the gate answers a relayed request by
handing it to **the same `wrapRequest` that answers its own worker today**,
with the `MessagePort` the content origin's worker created, transferred to the
gate through `relay.html`. Ranges, content types, streaming, the chunk
protocol `sw.js`'s `streamFromPort` already speaks — all of it is the existing
code. There is one implementation, and nothing to keep in agreement.

The relay therefore carries no bytes at all. It passes a port along and gets
out of the way; the content origin's worker and WebTorrent's server then talk
directly over that port, across the origin boundary, exactly as they would
within one.

What the gate must still do itself, because `wrapRequest` will serve any
torrent in the client to anyone who asks:

- **Take the infohash from `event.origin`, never from the message.** The
  relayed request's URL is rebuilt on the gate from the hash in the sender's
  hostname, and refused unless its own path names that same hash. A content
  frame can only ever be answered with its own torrent's files.
- **Accept only frames it created**: `event.source` must be the viewer frame's
  `contentWindow`, and `event.origin` must be exactly the origin the gate
  computed for that hash.
- **Answer the scripts-policy question the same way** — from `localStorage`,
  for the hash in `event.origin`, whatever hash the message claims.

### `sw.js` does change

An earlier draft said `sw.js` would be deployed unchanged at the content
origin. It cannot be, for three reasons found while designing this:

- **`frame-ancestors`.** `sw.js` sends `frame-ancestors <its own origin>`. On
  the content origin that forbids the one embedding that matters, because the
  site's ancestors are `relay.html` (the content origin) *and* the gate. In
  content mode it must be `frame-ancestors 'self' <gate origin>`.
- **Who it asks.** Today the worker sends each file request and each policy
  question to every window it can see and takes the first answer. On the
  content origin those windows include the site itself. A site with scripts
  on could answer first — about nothing but itself, since that is all its
  origin reaches, but still ahead of the relay. In content mode the worker
  asks `relay.html` and nothing else.
- **Which torrent.** A content origin exists for one infohash. The worker
  reads it from its own hostname and refuses any other, instead of relying on
  the gate to notice.

The worker learns which mode it is in from its own script URL: the gate
registers `sw.js`, `relay.html` registers `sw.js?gate=<gate origin>`. A site
with scripts on could re-register it with a different value — on its own
origin, affecting only itself, which is the boundary this whole design is
about.

### How the viewer knows the site arrived

`viewer.js` confirms a navigation by reading the frame's document, which it can
do today because the site shares its origin. A content-origin frame is
cross-origin to the gate, so that check reports every isolated site as stuck.
In content mode `relay.html` — same-origin with the site — makes the same
check on the inner frame and reports the result to the gate by `postMessage`.

### The nested-iframe question, resolved

Earlier drafts of this discussion treated a second, nested iframe — a small
Spore-authored `relay.html` sitting between the gate and the site's own
document — as a security boundary protecting the relay from a hostile site's
script. **It is not one, and should not be sold as one.** The gate
authenticates every relayed request by `event.origin`, which a page script
cannot forge; a message arriving from `https://<hash>.content.example` can
only ever be answered with that same torrent's own bytes, whether it came from
a well-behaved relay or from the hostile site forging the message itself. A
script that skipped the relay and messaged `window.parent` directly would gain
nothing it cannot already reach — its own torrent's files.

The actual reason to keep a separate `relay.html` (plus a small `js/relay.js`)
rather than running the bridge in the same document as the site is **to avoid
ever rewriting the hosted page's HTML** — injecting a bootstrap script into
someone's `index.html` response is exactly the kind of thing `site.js`'s own
header explicitly rules out project-wide ("the gate does not rewrite HTML...
there is nothing to miss"), and it would be fragile besides (malformed HTML,
an early competing `<meta charset>`, a page that clobbers globals). Nesting
buys architectural cleanliness, not an additional trust boundary — document it
that way in the code, not as a security control, so nobody later relies on it
being one.

### Measured, not assumed

Before any of this was written into the gate, the platform behavior it relies
on was checked with a standalone probe — two tiny pages and a trivial worker,
no Spore code — in Chromium 151 and Firefox 142, gate at `spore.localhost`,
content at `<40 hex>.content.spore.localhost`. That pair was chosen on purpose:
in production `gate.example` and `<hash>.content.example` are *same-site but
cross-origin*, and storage partitioning treats cross-site frames differently,
so a test on two unrelated hostnames would have measured the wrong thing.

Both engines agreed on everything that matters:

- Both hostnames are secure contexts over plain `http`, because `*.localhost`
  is treated like `localhost`. Development and CI therefore need no
  certificate, no DNS and no proxy — only real deployments do.
- A content-origin frame nested in the gate registers its own service worker
  and is controlled by it.
- The gate sees the relay's exact origin in `event.origin`, and can confirm
  `event.source` is the frame it created.
- A document on the content origin cannot read the gate's `localStorage`
  (`SecurityError`), before or after trying `document.domain`.
- A request made by the innermost document, answered by the content origin's
  worker, relayed through `relay.html` to the gate and back, arrives intact.
- The innermost document *can* reach `relay.html`'s DOM. Expected: they share
  an origin. This is the nested-iframe point above, confirmed.

One difference, and it produces an invariant: **Firefox honours
`document.domain = 'spore.localhost'` from the content origin; Chromium
ignores it** (origin-keyed agent clusters). Access stays blocked in both,
because relaxation only works when both sides opt in and the gate never does.
So the gate must never assign `document.domain`, and nothing can enforce that
from a static host — the header that would (`Origin-Agent-Cluster`) needs a
server. It is a rule for the code, and the end-to-end suite should assert that
a content frame which sets `document.domain` is still refused.

Two more rules fell out of building the probe:

- **The hostname is built from the infohash, so the infohash must be validated
  as exactly `/^[0-9a-f]{40}$/` at the point the hostname is built**, not
  trusted because it came from WebTorrent. A value containing a dot would
  address a different subdomain — someone else's torrent. Forty characters
  also fits DNS's 63-character label limit; a BitTorrent v2 infohash (64 hex)
  would not, which is fine only because Spore reads v1 magnets alone
  (`js/magnet.js`). If v2 support ever arrives, this scheme has to change with
  it.
- **Tests must use a gate hostname that is the parent of the content
  hostnames** (`spore.localhost` / `*.content.spore.localhost`), never two
  sibling names, for the same-site reason above.

### Sketch of the pieces

    gate.example                                 (has the WebTorrent client)
     └─ iframe: <hash>.content.example/relay.html      (new, Spore-authored)
         registers <hash>.content.example's own copy of sw.js,
         bridges its messages to window.parent via postMessage
         └─ iframe: <hash>.content.example/webtorrent/<hash>/index.html
             the site itself, sandboxed exactly as it is today

**Every site, not only scripted ones.** With isolation on, every site renders
on its content origin, scripts or not. One path instead of two means the relay
is exercised on every page view rather than only after an opt-in, so a fault in
it shows up at once; the scripts switch no longer changes which hostname a site
lives on; and a site with scripts off gains a second boundary it did not need
but costs nothing to have.

Files, and what each one does:

- `js/config.js` — `CONTENT_ISOLATION`, `null` by default, or
  `{ gate: 'https://spore.example', content: 'content.spore.example' }` on a
  mirror that runs the infrastructure. Both are needed: the gate uses
  `content` to build frame addresses, and the content side uses `gate` to know
  whom to answer to.
- `js/isolation.js` — new. Reads the config, builds and validates content
  origins from infohashes, and answers relayed messages on the gate: file
  requests through the server's own `wrapRequest`, policy questions from
  `localStorage`, "shown" reports for the viewer.
- `relay.html`, `js/relay.js` — new. Registers `sw.js?gate=…`, forwards the
  worker's ports to the gate, frames the site, reports whether it arrived.
  Imports nothing that loads WebTorrent.
- `sw.js` — content mode as above: own infohash only, `frame-ancestors 'self'
  <gate>`, questions to `relay.html` only.
- `js/swarm.js` — keeps the server `createServer()` returns, so it can be
  handed relayed requests.
- `js/viewer.js`, `js/app.js` — frame the relay instead of the site when the
  config is set, and wait for the relay's report instead of reading a
  cross-origin document.
- `index.html` — the gate's CSP `<meta>` must list the content domain in
  `frame-src` (`https://*.content.spore.example`). The gate cannot write that
  for an operator; the comment above the policy says so, and the config
  comment points at it.
- `SCRIPTS_WARNING` — two texts, chosen by whether the config is set.
- `tools/serve.mjs`, `tools/e2e.mjs` — a test hook that turns isolation on for
  one run (the same way `--trackers` already rewrites `DEFAULT_TRACKERS`), and
  a suite that opens sites through `spore.localhost` and
  `<hash>.content.spore.localhost`.

**One requirement on the proxy, not on the code:** the content domain must
serve the gate's own static files — `relay.html`, `js/`, `sw.js` — and nothing
else. A service worker's script is always fetched from the network, never
through an existing worker, so a site with scripts on that tries to register a
worker from one of its own torrent paths gets the host's 404. That is the same
protection the gate's origin has today, and it holds only as long as the host
does not serve torrent content at those paths.

## What it costs to run

This is the part `SECURITY.md`'s one-line mention does not spell out, and it
is why this stays a draft rather than a plan:

- **Wildcard DNS.** `*.content.example` has to resolve, for infohashes nobody
  has published yet at deploy time.
- **Wildcard TLS**, or per-request certificate issuance — a service worker
  requires HTTPS, and a certificate scoped to one hostname does not cover an
  address space shaped like `<any 40 hex characters>.content.example`.
- **A cooperating reverse proxy.** `deploy/gate/nginx.conf` today is a handful
  of fixed `location` blocks. This needs a proxy configured to accept and
  route an unbounded, unpredictable set of subdomains to the same backend —
  a materially different, and materially more maintained, piece of
  infrastructure than "serve some static files."
- **A domain, specifically.** A mirror on the free tier of a static host with
  no custom domain — `username.github.io/spore`, and nothing else — cannot do
  any of the above. There is no wildcard subdomain to hand out under someone
  else's hostname.

Put together: this trades "one static bundle, any mirror, no server assumed" —
the property `CLAUDE.md` names as the whole architecture of Phase 1 — for "one
static bundle, plus a mirror willing to run wildcard DNS, wildcard TLS, and a
proxy that understands both." That is a real trade, not a free upgrade, and it
should be made in the open rather than discovered by whoever tries to mirror
the gate on a host that cannot do it.

## What does not change

Nothing about content addressing, signing, or the mutable-update mechanism in
[mutable-sites.md](mutable-sites.md) is affected. A second origin changes
*where* bytes are served from, not how they are hashed, verified, or updated.
A site with scripts off is exactly as isolated as it is today, on either
design — this entire document is about narrowing what scripts *on* costs, not
about the default case.

## Open questions

Resolved since the first draft:

- The delivery mechanism has a concrete shape (above), and it needs **no second
  serving implementation**: relayed requests go to WebTorrent's own
  `wrapRequest`. The parity suite this section once called for is not needed,
  because there is nothing to be in parity with.
- The nested iframe's purpose is corrected: cleanliness, not a trust boundary.
  `event.origin` is the boundary.
- A relayed request times out exactly as a same-origin one does. The relay
  forwards a port and adds no wait of its own, so `sw.js`'s `PAGE_TIMEOUT_MS`
  still measures the whole round trip from the content origin's worker, and
  its error page is still what the reader sees.
- Config and warning: `CONTENT_ISOLATION = null` by default, and
  `SCRIPTS_WARNING` says the true thing for whichever mode is running.

Decided for now, open to argument:

- **Per infohash, not per torrent series (per `spore.pub` key).** Two versions
  of one author's site could reasonably share an origin — a reader mid-update
  expects continuity — or reasonably not, since a compromised key's old and new
  versions should not trust each other either. Per infohash is chosen because it
  is exactly the boundary `askingTorrent()` enforces today, so isolation adds a
  boundary without moving one.

Still genuinely open:
- **Who issues the wildcard certificate, and how does a self-hosted mirror
  get one without a manual step per infohash?** ACME's DNS-01 challenge covers
  a wildcard in one certificate, which answers this for a mirror willing to
  automate DNS updates — worth confirming that is an acceptable operational
  bar rather than assuming it.
- **How does the reader's address bar represent a site that rendered on a
  different hostname than the one they typed a magnet into?** This needs an
  answer before the trust chip can be redesigned around it, not after.
- **Does it work on WebKit at all?** Every browser on iOS is WebKit, which
  already refuses to serve a sandboxed frame from a worker (see `viewer.js`).
  Whether it registers and applies a worker inside a same-site, cross-origin
  frame — the whole of this mode — is unmeasured. The standalone probe in
  "Measured, not assumed" is the test to run on an iPhone first.
- **Should scripts stay refused where the sandbox is unavailable?** On an engine
  that will not serve a sandboxed frame, the gate refuses scripts outright,
  because shared origin with no sandbox is too much to give. With isolation on,
  the origin is no longer shared, and that reasoning may no longer hold. Left as
  it was until WebKit is measured, since that is the engine it concerns.

None of these block using Spore as it is, with isolation on or off. The address
bar question is the one to answer before a second pass redesigns the trust chip.
