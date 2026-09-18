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

What still has to be solved, and is not solved by picking this shape:

1. **Delivery.** The WebTorrent client — the actual WebRTC connections — has to
   live in a page, and today that page is the gate's. A request landing on
   `<hash>.content.example` needs some way to reach bytes that live in a swarm
   the *gate's* tab joined. The plausible shape is a second service worker,
   registered on the content origin, that does not speak WebRTC itself but
   bridges each request back to the gate's page over `postMessage` or a
   `BroadcastChannel` — essentially `sw.js`'s current `requestFromPage`, moved
   across an origin boundary instead of within one. This is a protocol of its
   own, not a hosting change.
2. **Discovery.** The gate's own page has to learn, or be told, the address of
   its paired content origin. A fixed relationship (`gate.example` implies
   `*.content.example`) is the simplest answer and couples the two at deploy
   time, which is at least honest about the fact that they are one system with
   two hostnames.
3. **The trust chip.** `js/app.js`'s "verified" indicator, and the address bar
   itself, live in the gate's chrome. If content renders on a different
   origin, the reader is looking at two hostnames for one site — the one they
   asked for and the one it actually rendered on — and the UI has to make that
   legible rather than confusing. This did not need solving before, because
   there was only ever one hostname to show.

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

- **Is per-infohash granularity actually right, or is per-*torrent-series*
  (per `spore.pub` key) enough?** Two versions of the same site sharing an
  origin might be desirable (a reader mid-update reasonably expects continuity)
  or might not (a compromised key's old and new versions should probably not
  trust each other either). Not yet argued through.
- **Does every mirror have to support this, or can a mirror decline?** If
  support is optional, the gate needs to detect its absence and fall back to
  something — presumably today's shared-origin behavior, with today's warning
  — rather than failing silently. That fallback is itself a piece of the
  design, not an afterthought.
- **Who issues the wildcard certificate, and how does a self-hosted mirror
  get one without a manual step per infohash?** ACME's DNS-01 challenge covers
  a wildcard in one certificate, which answers this for a mirror willing to
  automate DNS updates — worth confirming that is an acceptable operational
  bar rather than assuming it.
- **What does the content-origin service worker's bridge protocol actually
  look like**, and does it reproduce `sw.js`'s existing `requestFromPage`
  message shape, or does crossing an origin boundary change what is safe to
  ask the gate's page for? `postMessage` between origins needs an explicit
  target origin and a sender check on both ends — the trust properties
  `askingTorrent()` gets from `event.clientId` today do not obviously carry
  over unchanged.
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
