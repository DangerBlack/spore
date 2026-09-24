# Security model

Spore renders code and markup written by strangers. This document says what the
gate defends against, how, and — just as importantly — what it does not defend
against. Every claim here corresponds to something in the code; where a defence
is incomplete it is written down as incomplete rather than left implied.

## What we are protecting

1. **The reader's network identity from the *content*.** A site must not be able
   to make the browser touch anything outside its own torrent. This is the
   priority: it holds even when JavaScript is off, because an `<img>`, a
   `background-image`, a webfont or a form is enough to report a reader's IP
   address to a third party.
2. **The gate from the site.** A hostile site must not be able to reach the
   address bar and controls, or read another site's files.
3. **Integrity of what is shown.** A magnet addresses content by hash, and
   WebTorrent verifies every piece against it. Bytes that do not match are not
   rendered — there is nothing to trust about the peer that sent them.

## What we are *not* protecting

**Anonymity.** Peers in a swarm see each other's IP addresses; that is how
BitTorrent works. Spore makes content hard to take down. It does not hide who
published it or who is reading it, and it must never be described as if it did.

## The chokepoint

Everything a site loads is a request to `/webtorrent/<infoHash>/<path>` on the
gate's origin, answered by [`sw.js`](sw.js). A service worker sees *every*
request its clients make, which is why the gate does not rewrite HTML or invent
custom elements to fetch resources: there is no request it could overlook, and
response headers — where the policy actually lives — are ours to set.

## Layer 1 — Content-Security-Policy, per site

`sw.js` attaches a policy to every response:

```
default-src 'none';
base-uri 'none'; object-src 'none'; form-action 'none';
frame-ancestors <gate-origin>;
img-src     'self' data: blob:;
media-src   'self' blob:;
font-src    'self' data:;
style-src   'self' 'unsafe-inline';
frame-src   'self';
child-src   'self';
script-src  'none'  |  'self' 'unsafe-inline'   (opt-in)
connect-src 'none'  |  'self'                   (opt-in)
worker-src  'none'  |  'self'                   (opt-in)
```

Why it is written this way:

- **`default-src 'none'` with an explicit allowlist.** Anything we did not think
  of is denied rather than allowed. New CSP-governed features arrive denied.
- **No external origins anywhere.** This is the egress block, and it is the job
  CSP does here. It applies to images, stylesheets, fonts, media and frames, not
  only to scripts.

### Why isolation between torrents is *not* done with CSP

The first version pinned every source to `<gate-origin>/webtorrent/<infoHash>/`
and leaned on CSP path-prefix matching to keep one torrent out of another's
files. Chrome and Chromium enforce that correctly. Firefox refused a site's own
worker-served stylesheets and images under the same policy — `site.css` and
`leaf.svg` came back `NS_ERROR_CONTENT_BLOCKED`, and pages rendered unstyled
with broken images, while an identical path-scoped policy over plain HTTP
worked fine in Firefox. Adding `'self'` fixed it, which is what identified the
path-scoped source as the cause.

A boundary that one browser enforces and another over-enforces is in the wrong
place. The check moved into the worker, below.
- **`'unsafe-inline'` for styles.** Real static sites use `<style>` blocks and
  `style=` attributes, and forbidding them would break most of the web we want
  to host. A stylesheet cannot exfiltrate by itself: what it may *load* is still
  pinned to the torrent, and `form-action 'none'` closes the CSS-injection
  trick of submitting a form to a third party.
- **`form-action 'none'`.** A form is a network request a reader can be talked
  into making.

`Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` are set on
the same responses. The `Access-Control-Allow-Origin: *` that WebTorrent would
otherwise send is narrowed to the gate itself.

## Layer 2 — the worker refuses cross-torrent reads

Sites share the gate's origin (see below), so nothing in the platform separates
them by default. `sw.js` does it directly: before serving
`/webtorrent/<A>/<path>`, it works out which torrent is asking and refuses with
**403** if that is some other torrent `<B>`.

Who is asking comes from `event.clientId`, which names the document making the
request — the worker's own view of it, not anything the site can set. Navigation
requests arrive with no client, so the referrer stands in; that is why responses
carry `Referrer-Policy: same-origin` rather than `no-referrer`. Nothing leaks by
doing so, because a site cannot reach anything off this origin anyway.

This holds in the hardest case — a site with scripts enabled, whose
`connect-src 'self'` permits same-origin requests. It may read its own torrent
(`200`) and is refused another's (`403`), and `tools/e2e.mjs` asserts exactly
that pair. It behaves identically in every browser, because it is our code
rather than a policy feature we hoped was uniform.

## Layer 3 — the sandboxed iframe

Sites render in an iframe whose sandbox grants only `allow-same-origin`
(plus `allow-scripts` when opted in). Everything else is withheld: no top-level
navigation, so a site cannot replace the gate; no popups, which would otherwise
be an egress channel CSP does not cover; no forms, no downloads, no plugins, no
pointer lock, no modals.

### WebKit will not serve a sandboxed frame

Measured with two frames in one document differing only in the attribute:
WebKit served the plain one and answered the sandboxed one with the host's 404;
Chrome and Firefox served both. Since every browser on iOS is WebKit, layer 3
is unavailable there, and a site shown inside it would never render.

Spore detects this by trying, not by reading the user agent, and asks the
reader before showing anything. What the fallback actually costs, measured the
same way: a clicked link can open an outside tab, and that site sees the
reader's IP. Nothing else moves. Scripts stay impossible, requests stay inside
the torrent, and a site still cannot navigate itself elsewhere — that last one
is held by the gate's own `frame-src 'self'`, not by the sandbox. The per-site
script permission is withdrawn entirely in this mode.

Declining is respected: the site is downloaded and verified, and not displayed.

### Why `allow-same-origin` is there — and why it cannot be removed

The design one would reach for first is a fully sandboxed frame with an opaque
origin. Chrome answers it directly:

> Service worker is disabled because the context is sandboxed and lacks the
> `allow-same-origin` flag.

A document with an opaque origin is never controlled by a service worker. Its
navigation is not intercepted and neither is any subresource, so the site loads
nothing at all — this is verified behaviour, not a guess. Serving the sandbox
flags through `Content-Security-Policy: sandbox` on the response fails the same
way one step later: the document itself arrives, then every stylesheet and image
inside it 404s.

So content shares the gate's origin, and isolation comes from the two layers
above rather than from the origin boundary.

**With scripts off — the default — this is sound.** There is no code inside the
site that could make use of the shared origin: scripts are blocked twice over,
by the sandbox and by `script-src 'none'`.

## The known hole: sites with scripts enabled

Scripts are off until the reader turns them on for one specific infohash, and
the gate states the trade-off before accepting.

A site running with scripts shares the gate's origin, so it can reach
`window.parent` and tamper with the gate's own chrome — the address bar above it
is no longer trustworthy. And because `localStorage`, IndexedDB and the service
worker registration belong to the origin, not to a site, the reach is not
limited to the site that was granted scripts:

- It can read and rewrite what Spore stores for **every** site: kept sites,
  which authors the reader trusts and how far each series has advanced (so it
  can make a genuine update from someone else look like a replay and be
  refused), and which other infohashes may run scripts.
- It can unregister the service worker every open Spore tab depends on, and
  keep doing so. The gate notices and re-registers, but a site that repeats
  the call can keep other tabs from rendering for as long as it stays open.
- If a publishing key is kept on this device, it can *use* that key — not
  export it — to sign whatever it likes. Signing is not network egress, so no
  CSP directive applies to it.

The question the gate asks before enabling scripts says all of this, because a
reader deciding whether to trust one site is in fact deciding whether to trust
it with all of the above. What still holds:

- It cannot reach the network outside its torrent (`connect-src`, and every
  other fetch directive, stay pinned to the infohash).
- It cannot read another torrent's files over the network for the same reason.
- It cannot install a service worker of its own: a registration's script fetch
  bypasses the active worker and hits the network, and even if it did not, the
  scope of a script under `/webtorrent/<hash>/` is limited to that path because
  the gate never sends `Service-Worker-Allowed`.
- The permission is keyed by infohash, so it is bound to the exact bytes it was
  granted to and cannot be transferred to different content.

**The fix is a second origin for content**, which turns the shared-origin
problem into a real boundary. It has to be one origin *per infohash*, not one
shared second hostname, or sites would share an origin with each other instead
of with the gate — which means wildcard DNS, wildcard TLS and a cooperating
proxy, so it can only ever be an option for mirrors that run those, never the
default on a plain static host. What it takes is worked through in
[spec/second-origin-isolation.md](spec/second-origin-isolation.md).

This is also the reason the next section exists: anything a script can reach on
this origin includes whatever Spore has stored there.

## The gate's own policy

The gate declares its policy in a `<meta>` tag in `index.html`, because a static
host cannot be relied on to send headers and the policy has to travel with the
bundle to every mirror. `connect-src` there must allow arbitrary `wss:`: tracker
URLs come out of whatever magnet the reader pasted.

## Privacy of the address itself

The site reference lives in the URL fragment (`https://gate/#<magnet>`).
Browsers never send a fragment to the server, so whoever hosts or mirrors the
gate does not learn which site is being read. Navigating between sites only
rewrites the fragment; the gate is never reloaded.

Trackers are the exception: joining a swarm tells the tracker, and every peer,
which infohash you want. This is inherent to BitTorrent, not something the gate
can paper over.

**Reading a site also seeds it.** Once a site's pieces are verified, the gate
keeps offering them to the swarm — that is how a site survives its publisher
closing their tab, and it is objective, not a side effect. But it means you go
on announcing that you hold that infohash for as long as the tab is open, past
the point where you have navigated away to something else. Every site opened in
a tab is seeded until that tab closes.

If that announcement is a problem for a particular site, close the tab.

## Keeping a site on this device

By default Spore writes **nothing** to disk. A site you read lives in memory and
is gone when the tab closes. There is no cache, no history, no record of what
you opened.

"Keep offline" is the reader deliberately changing that, for one site, after
being told what it means. It is off by default, it is per infohash, and it is
never inferred from behaviour — visiting a site often does not start keeping it.

What it buys: the site opens instantly, works with no peer online, and is seeded
from the moment Spore starts rather than only once someone else shows up. For a
site you care about surviving, that is the difference between depending on a
stranger's open tab and depending on your own.

What it costs, and both are real:

- **The site's contents are written to this device**, in IndexedDB under the
  gate's origin. Anyone who can use this browser profile can read what you have
  kept. This is the only durable trace Spore leaves.
- **You announce it, repeatedly.** A kept site is seeded on every launch, not
  only while you are reading. Over time that is a much stronger signal to
  trackers and peers that this device holds this content than a single visit.
- **You are hosting it.** Whatever is in that torrent, your device serves to
  strangers who ask.

"Forget" deletes the record and every stored byte, and the code deletes chunks
by key range rather than relying on the record alone, so nothing is orphaned.
The gate asks the browser for persistent storage when you keep something; the
browser may refuse and may evict later, so a kept site is never promised to be
there forever.

The metadata (`.torrent`) is stored alongside the pieces, which is what lets a
kept site come back without asking a peer for it first.

## Keeping a publishing key on this device

Signing is optional, asked once per publication, and by default the key exists
only for as long as the passphrase sits in memory — it is derived, used, and
never written anywhere. A publisher can choose to keep it, so that everything
published from this browser is signed without retyping. That choice has a cost,
and the gate states it before accepting.

**What is stored is a non-extractable `CryptoKey`, not the passphrase and not
the key bytes.** It is imported with `extractable: false` and put in IndexedDB
by structured clone. The browser will sign with it and will not export it — not
to us, not to a script, not to anything. So it cannot be copied out and used on
another machine, and it cannot be exfiltrated and kept after the fact.

**It can still be used, in place, by anything running on this origin.** That is
not hypothetical here. The gate has to serve sites from its own origin — a
service worker cannot reach an opaque one — so a site the reader has granted
scripts to is same-origin with the gate and can reach its IndexedDB. Enabling
scripts for a hostile site while a key is kept means that site can sign as the
publisher for as long as it runs.

What follows from that:

- **There is no revocation.** A record signed while the key was reachable stays
  validly signed forever. Ed25519 signatures do not expire and there is no
  authority to complain to.
- **Forgetting actually ends it.** Because the key cannot leave the browser,
  deleting it is a real remedy rather than a gesture — unlike a stolen
  passphrase, which is compromised permanently the moment it is read.
- **The advice is specific**: do not keep a key in a browser where you enable
  scripts for sites you do not trust. Those are the same two switches, and they
  are dangerous together rather than apart.

The second origin for content closes this the same way it closes the section
above, and for the same reason.

## Reporting

This is a young project with a deliberately small threat model. If you find
something that breaks one of the guarantees above — especially an egress path
out of a scriptless site, or a way for one torrent to read another — please open
an issue describing the path.
