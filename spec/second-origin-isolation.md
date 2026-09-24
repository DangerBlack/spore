# A second origin for content

**Status: draft. Nothing in this document is implemented, and nothing here is
scheduled.** It exists so the idea has one place to live between now and
whenever it gets built, in the manner of [mutable-sites.md](mutable-sites.md).
The open questions at the end are unresolved, not rhetorical — several of them
would need to be settled before this could be designed properly, let alone
built.

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
`CONTENT_ORIGIN_TEMPLATE` in `js/config.js`, `null` unless a mirror operator
sets and rebuilds with their own — read the same way `DEFAULT_TRACKERS` already
is: a constant a mirror operator edits and recompiles with, not something
fetched or negotiated at runtime. `null` (the default, and what any plain
`username.github.io` mirror ships) means the gate behaves exactly as it does
today — same origin, same known hole, same honestly-worded warning. Only a
mirror that has set the value attempts anything in this document at all.

That default has one more consequence worth stating plainly: because most
mirrors will never set it, `SCRIPTS_WARNING` in `js/app.js` has to keep telling
the truth about the *common* case, not the aspirational one. The dialog text
must read the current value of `CONTENT_ORIGIN_TEMPLATE` and say one of two
different things — the honest "this shares Spore's own storage and can disrupt
every other open tab" when it is `null`, or "this site is isolated on its own
address" when a mirror has enabled it. Shipping one warning that is only true
on the rare mirror, while implying it everywhere, would be worse than the
warning that exists today.

What still has to be solved, and is not solved by picking this shape:

1. **Delivery — the hard part, worked through below**, because the first pass
   at this document underestimated it: it is not a hosting change, it is a
   second, parallel way to turn torrent bytes into an HTTP response.
2. **Discovery.** The gate's own page has to learn, or be told, the address of
   its paired content origin. A fixed relationship (`gate.example` implies
   `*.content.example`) is the simplest answer and couples the two at deploy
   time, which is at least honest about the fact that they are one system with
   two hostnames. This is what `CONTENT_ORIGIN_TEMPLATE` above already answers.
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

### Why a plain relay does not work

`js/swarm.js` does not implement the page-side half of serving a torrent as
HTTP. It calls `client.createServer({ controller: registration })` and the
vendored WebTorrent bundle does the rest: it listens for genuine
`navigator.serviceWorker` message events — from *its own* registered worker,
on *its own* origin — and answers them using the torrent's pieces directly.
That listener cannot be redirected to answer messages relayed from a foreign
iframe, because the browser will not let a page fabricate a message whose
`event.source` looks like a real `ServiceWorker`. Nothing in the platform lets
one page pretend to be another origin's service worker, and nothing here
should try to defeat that.

So a request that lands on `<hash>.content.example`'s worker cannot simply be
forwarded, verbatim, into the gate's existing pipeline and expect an answer.
There is no listener on the gate's side shaped to receive it.

### What has to be built instead

A **second, minimal implementation** of "turn a path in this torrent into an
HTTP-shaped response," living in the gate's own page and callable directly —
not through `createServer()`, on top of WebTorrent's public per-file API
instead: `torrent.files.find(...)` to locate the entry, `file.createReadStream
({ start, end })` to read it (confirmed present as a public method on the
vendored bundle's `File` objects), by hand:

- parse a `Range: bytes=start-end` header the same way a real static file
  server would, and answer `206 Partial Content` with `Content-Range` when one
  was sent, `200` with the whole file otherwise
- a small extension-to-MIME-type table, since nothing here can rely on a real
  HTTP server's content-type sniffing
- `Content-Length` from `file.length` (or the requested range's length)
- stream the bytes across the relay channel in chunks, the same shape `sw.js`'s
  own `streamFromPort` already uses for its (same-origin) case, so the content
  origin's local service worker can turn them into a `ReadableStream` response
  exactly as `sw.js` does today

This is real, new, security-relevant code — not configuration, not plumbing.
**It is also the single largest risk in this whole document**, for a reason
this codebase's own commit history keeps proving out loud: two
implementations that are each individually correct but must behave
*identically* — here, "serve this file as HTTP" implemented once inside the
vendored bundle for the same-origin case and once by hand for the relayed
case — are exactly how this project has shipped its worst bugs before (a
manifest and a torrent disagreeing about a path, a seeder and a reader
disagreeing about what a signature covers). A byte range handled slightly
differently, a MIME type guessed differently, a streaming edge case
(zero-length file, a range past the end, a mid-stream torrent-piece failure)
handled differently between the two paths would not fail loudly — it would
render wrong, or hang, only for whoever's mirror has this flag on, and be
brutal to reproduce. Whatever gets built here needs the same treatment
`site.js`'s entry-finding logic got: one shared module the tests can call
directly with every input shape both paths might see, rather than two
call sites that happen to agree today.

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

Files this implies, none written yet:

- `js/config.js` — `CONTENT_ORIGIN_TEMPLATE` (default `null`).
- `relay.html`, `js/relay.js` — the bootstrap/bridge, new.
- a shared module for "serve this path from this torrent as an HTTP response,"
  written once and called from both the relay path and — ideally — refactored
  into what `sw.js` already does for the same-origin path, so there is
  provably one implementation rather than two that are meant to agree.
- `js/app.js` — branches the iframe's `src` on `CONTENT_ORIGIN_TEMPLATE`; a new
  gate-side listener answering relayed requests via the shared serve module;
  `SCRIPTS_WARNING` reads the config value and says one of two true things.
- `index.html` — a comment noting that enabling the flag requires adding
  `https://*.<content-domain>` to `frame-src` and `connect-src` in the CSP
  `<meta>` tag by hand; the gate cannot do this for an operator, since the
  domain is theirs.
- `sw.js` — unchanged. The same file is deployed a second time, at the content
  origin; its own behavior does not need to know which origin it is running
  on.

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

Resolved since the first draft: the delivery mechanism now has a concrete
shape (above), the nested iframe's purpose is corrected (cleanliness, not a
trust boundary — `event.origin` provides that), and the config default/warning
behavior is settled (`CONTENT_ORIGIN_TEMPLATE = null`, `SCRIPTS_WARNING` reads
it). What is still genuinely open:

- **Can the relayed-serving path and `sw.js`'s existing same-origin path share
  one implementation, or only agree by discipline?** The "single largest risk"
  section above assumes a shared module is possible. It may not be: `sw.js`'s
  path gets its response shape from WebTorrent's own `createServer` internals,
  which are opaque vendored code, while the relay path would be hand-written
  against the public `File` API. If the two genuinely cannot share code, the
  fallback is a test suite that feeds *identical* request shapes (fresh file,
  mid-file range, past-the-end range, zero-length file, a range spanning a
  piece boundary) to both paths and asserts byte-identical responses — written
  before the relay path ships, not after a mismatch is reported.
- **Is per-infohash granularity actually right, or is per-*torrent-series*
  (per `spore.pub` key) enough?** Two versions of the same site sharing an
  origin might be desirable (a reader mid-update reasonably expects continuity)
  or might not (a compromised key's old and new versions should probably not
  trust each other either). Not yet argued through.
- **What does a relayed request time out to?** `sw.js`'s own `PAGE_TIMEOUT_MS`
  turns a wedged same-origin request into a readable error after 20 seconds.
  The relay adds a hop (content-origin SW → `relay.html` → `postMessage` →
  gate page → back), each of which can fail independently — the timeout
  budget and the error surfaced to the reader need their own design, not an
  assumption that the existing constant still means the same thing once it is
  spent partly on a cross-origin round trip.
- **Who issues the wildcard certificate, and how does a self-hosted mirror
  get one without a manual step per infohash?** ACME's DNS-01 challenge covers
  a wildcard in one certificate, which answers this for a mirror willing to
  automate DNS updates — worth confirming that is an acceptable operational
  bar rather than assuming it.
- **How does the reader's address bar represent a site that rendered on a
  different hostname than the one they typed a magnet into?** This needs an
  answer before the trust chip can be redesigned around it, not after.
- **Is this worth doing before or after Fase 2's BEP 46/DHT bridge work?**
  They are independent (one is about *where* content is served, the other
  about *finding* newer versions of it), but both are large, and only one
  browser-facing change should probably land at a time.

None of these need to be answered to keep using Spore as it is today. They
need to be answered before this is designed, which is why this document stops
here instead of proposing one.
