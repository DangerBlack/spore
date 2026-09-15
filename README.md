# Spore

A browser inside the browser. Static sites live in torrents; opening one helps
host it.

Spore is a single static page — the **gate**. Paste a magnet link and the site
inside it renders, fetched from the swarm by peers rather than from a server.
Give the gate a folder, a `.zip` of one, or a single page, and it becomes a
torrent that your tab seeds, with a link you can share. No account and no
backend — your files go to readers, not
to a host.

The name: a spore is self-contained, spreads, survives dormant, and any one of
them can regrow the whole organism — which is exactly what a content-addressed
site is.

## Try it

```sh
node tools/serve.mjs          # http://localhost:8080/
```

Any static host over HTTPS works just as well; `tools/serve.mjs` exists only
because service workers need a secure context and `file://` is not one
(`localhost` is exempt).

### Hosting it

Any static host over HTTPS will do, because the gate is only files. GitHub
Pages is the least-effort option:

1. Push this repository to GitHub.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder
   `/ (root)`.

Or run it yourself, behind your own TLS:

```sh
cd deploy/gate
docker compose up -d      # http://localhost:8080
```

Those are two of the three ways to host, and they do different jobs —
[`deploy/`](deploy/) says which is which. In short: **`deploy/gate/` serves the
page people browse with; `deploy/seeder/` keeps one published site alive.** A
compose file at the repository root would have implied that starting "the
project" meant one specific thing, and it does not.

That is the whole deployment. There is no build step to configure, and nothing
in the bundle assumes a particular hostname or path — verified running from a
subpath, which is what a project page (`https://you.github.io/spore/`) gives
you: the service worker takes its scope from wherever it was registered.

Two details that matter on a static host:

- `.nojekyll` is committed so Pages serves the files as they are.
- The worker is registered with `updateViaCache: 'none'`. Pages serves assets
  with a ten-minute `max-age`, and a cached `sw.js` outliving a fix is a bug
  that looks exactly like the fix never happened.

One caveat once you are on HTTPS: a magnet whose trackers are `ws://` rather
than `wss://` is blocked as mixed content, and the site will never find a peer.
Spore's own default trackers are `wss://`.

### Testing on a phone, or any other device

```sh
node tools/serve.mjs 8080 --tls    # prints the LAN URLs to type
```

`--tls` is not optional here, and the reason is worth knowing before you file a
bug against a browser. A service worker requires a **secure context**, and
`localhost` is the only insecure origin browsers exempt. Reaching the dev server
at `http://192.168.x.x` therefore gets you no service worker at all — the API is
switched off entirely — and Spore serves every site through one. Mobile Firefox
and Chrome will report exactly this under **Diagnostics**.

The certificate is self-signed, so each device accepts the warning once. After
that the origin is a secure context and everything behaves normally.

**In production this is a non-issue**: served over HTTPS from any static host,
mobile browsers get a service worker like desktop ones do.

Then drop `example-site/` onto the page to publish it. That folder is the
Spore whitepaper — what it is, why adoption is the mechanism rather than the
scoreboard, who it is for, and what it refuses to promise. It is also the test
fixture, which is deliberate: every claim it makes about the security model is
demonstrated live on the page, so a broken guarantee shows up as a broken
document.

## How it works

```
  ┌─ gate (this bundle) ─────────────────────────────────┐
  │  address bar, controls, publish            page JS   │
  │                                        WebTorrent ───┼── WebRTC ── peers
  │  ┌─ <iframe sandbox> ──────────────┐         ▲       │
  │  │  the site, from the swarm       │         │       │
  │  │  GET /webtorrent/<hash>/…  ─────┼──► service worker│
  │  └─────────────────────────────────┘                 │
  └──────────────────────────────────────────────────────┘
```

- **The magnet lives in the URL fragment** (`https://gate/#<magnet>`). Browsers
  never send a fragment to the server, so whoever hosts the gate does not learn
  what you are reading.
- **WebTorrent runs in the page**, not in the service worker — a worker cannot
  open WebRTC connections.
- **The service worker serves the site** at `/webtorrent/<infoHash>/<path>`, so
  every request a site makes — stylesheets, images, fonts, nested frames —
  passes through one chokepoint. Nothing is rewritten and no custom tags are
  invented; there is nothing for the gate to miss.
- **The site renders in a sandboxed iframe** and is governed by a
  Content-Security-Policy that the worker attaches to every response. See
  [SECURITY.md](SECURITY.md) — it is the heart of the project, not a detail.

WebKit refuses to serve a sandboxed frame, so on iOS that layer is unavailable
and Spore asks before showing sites without it. The cost is narrow and
measured: a clicked link can open an outside tab that sees your IP. Scripts and
off-torrent requests stay blocked either way.

## Publishing

Three ways in, because a folder cannot always be chosen:

- **Drop a folder**, or pick one — the fastest path where it exists.
- **Pick a `.zip`** of that folder. It is unpacked in your browser, with no
  library: a zip is a folder that fits through an ordinary file picker, which
  on some devices is the only picker there is. iOS appears to offer no folder
  picker at all — reported, not yet confirmed on a device, so the folder button
  is still offered everywhere and this is the way round it if it is missing.
- **Pick a page and its files.** A picker reports no relative paths, so
  everything lands at the top of the site: a flat page publishes, and anything
  in a subdirectory needs the zip.

Relative links inside, and an `index.html` if you have one — a single page under
any name works too, and a set of files with no entry page publishes as a
browsable file list, which Spore says before it seeds anything rather than
after.

The site is the entry page's folder and everything under it. An archive with a
second top level — `__MACOSX/` beside your folder, say, which is what macOS
produces — has that second part named and left out before anything is signed,
because a reader can only check what sits beside the page they opened. And a
folder that already declares somebody else's `spore.pub` is published without
being re-signed by you — if it carries their signature too, it stays verified
under their key, which is what a faithful mirror should be. A signature from you
beside a key that is not yours would read to every reader as the site having
been altered. The files are hashed in your browser and never sent to a server. You get
a magnet and a shareable link, and your tab becomes the site's first seed.

Every reader who opens the link seeds it too, for as long as their tab is open.

## Updating a site

A magnet is the hash of its content, so editing a site gives it a new address.
That is not a limitation to route around — it is what makes a site verifiable
without trusting anyone. What it costs is continuity: readers holding the old
link have no way to learn the new one.

Signing fixes the continuity without giving up the verification.

**Drop your folder, and Spore asks whether to sign it** before anything is
hashed. Signing is a decision about that publication, not a login: a site
published without a key is a perfectly good site that simply can never be
updated.

Say yes and you give a name and a passphrase. **The name is what readers see** —
it goes into the site's `spore.pub` as the name your key claims for itself, and
it is what your password manager files the passphrase under. Leave it blank to
publish under the key alone. The passphrase *is* the key —
it is derived here, never stored, never sent, and there is nothing to back up
and nobody who can reset it. Spore then shows you the key it derived, as a
picture and a fingerprint, before signing anything with it. That step is the
only check that exists: there is no account to be wrong at, so a mistyped
passphrase produces a *different valid identity* rather than an error. Compare
it to what you saw last time; the second time on the same browser it greets you
by the name you gave it.

Then you say **which site this is** — `blog`, `notes` — picking from what you
have published before or naming a new one. This matters more than it looks: a
key is an *author*, and an author has many sites. The name goes in the site's
`spore.pub` and is what an update actually addresses, so publishing your CV
never announces itself as the new version of your blog. Type the same name on
another machine and you are publishing the same site.

Your folder then gets a `spore.pub` naming your public key and that site, so the
site says who it belongs to and which of their sites it is.

You can tick **keep this key on this device** to stop retyping. What gets stored
is the key itself in a form the browser will sign with but will not hand back —
not your passphrase — so it cannot be copied out. It can still be *used* by
anything running on Spore's origin, which includes a site you grant scripts to,
and there is no revocation. Don't do it in a browser where you enable scripts
for sites you don't trust. The full reasoning is in
[SECURITY.md](SECURITY.md#keeping-a-publishing-key-on-this-device).

Publish again later, same key and same site name, and Spore signs a small record
saying "the newest `blog` from this key is at *this* infohash" and offers it to
peers still on the old version. A reader there sees:

> **"Lara from work" has published a newer version.**
> Published 11 September 2026, signed by `2317-e451-c8f8-2b8c` — the same key as
> the version you are reading. **[Open it]** [Not now]

They are offered it. They are never moved. A signature proves *who* wrote a
version, not that the reader wants to be taken to it — and silently swapping
the page would hand anyone who ever stole the key control over what everyone is
currently reading.

Three things worth being plain about:

- **The name is a claim.** Anyone can put `name=Lara Croft` in their
  `spore.pub`. The key cannot be faked; the name is decoration. That is why the
  fingerprint is shown next to it.
- **It travels between peers, not through the DHT.** BEP 46 resolves successors
  over the DHT, which is UDP, which a browser cannot open at all. The record is
  the identical BEP 44 item — a seeder with UDP can put the same bytes in the
  DHT and an ordinary BEP 46 client resolves it — but in a browser it moves over
  the wire between peers. So an update reaches someone only if a peer they
  connect to holds it. **Keep the old version seeded.**
- **Versions are timestamps, so your clock matters.** There is no counter to
  keep, which is what lets you publish from any machine — but a clock running
  far ahead burns the series until real time catches up.

## Checking who published something

A signed site shows its author in the status bar — their avatar and either the
name *you* gave them or, in quotes, the name the key claims for itself. Click it
and you get the whole picture: the fingerprint, the full public key, which of
their sites you are reading, when this version was published, and whether this
browser has ever seen the key before.

You can give the author your own name for them. It is stored only in your
browser, never published, and it replaces their self-declared name everywhere
you see them. This is the answer to two people both calling themselves Lara: one
becomes "Lara from work" because you said so, and the other stays a claim in
quotes.

**Be clear about what the key proves, because it is less than it looks.**
`spore.pub` is an ordinary file in the torrent. Anyone can put any public key in
a folder and publish it, so its presence does not show that whoever built the
site holds the matching private key. Nothing signs the content itself.

What it names is the only key whose *successors* this site will accept, and the
signature lives on the update record rather than on the page. So a first version
is unauthenticated, trust on first use; someone can copy a site, swap in their
own key and keep the claimed name, producing a different site at a different
address that the protocol cannot tell you is a copy; but nobody can update a
site they do not hold the declared key for, because an update is refused unless
its key matches the one already in front of the reader.

A site that also ships **`spore.sig`** closes most of that. It lists every other
file with the hash of its bytes and signs the list, so copying somebody's key
into a folder of your own text no longer passes: the gate shows **verified**
only when every file matches what that key signed, **declared** when a key is
claimed with nothing behind it, and **broken** when they disagree. It is checked
offline, from the torrent alone, on a first read. Publishing from the gate or
with `tools/seed.mjs` writes it automatically.

What is left is narrow: *whoever holds the key a site declared is exactly who
can move that site's readers forward, and a verified site is exactly the bytes
that key signed.* Whether it is the key you meant to follow
is settled out of band, by comparing the fingerprint with one you got from
somewhere you already trust. That is what the fingerprint and the petname are
for, and it is why a declared `name=Lara Croft` is shown in quotes as a claim
rather than as a fact.

Sites nobody signed say **unsigned** rather than showing nothing, because a
missing signature and a page that has not finished loading should not look the
same.

The design, the threat model and what is deliberately not built are in
[spec/mutable-sites.md](spec/mutable-sites.md).

## Seeding from a server

A browser seeds only while its tab is open. To keep a site up regardless, run a
seeder that stays running — but it has to speak **WebRTC**, because that is the
only transport a browser peer can use. An ordinary BitTorrent client
(transmission, rtorrent, a NAS) cannot serve a Spore site no matter how
correctly it seeds the same infohash. That single fact is what most guides on
this are really working around.

Modern WebTorrent does WebRTC in Node directly, so it takes one dependency and
one line — `webtorrent-hybrid`, which older guides install, is no longer
needed.

### With Docker

There is a published image, so this needs no clone:

```sh
mkdir spore-seeder && cd spore-seeder
mkdir -p site data && cp -r /path/to/your-website/. site/

curl -O https://raw.githubusercontent.com/DangerBlack/spore/main/deploy/seeder/.env.example
cp .env.example .env && $EDITOR .env     # name, site, passphrase
chmod 600 .env                           # it holds your signing passphrase

docker run -d --name spore-seeder --restart unless-stopped \
  --env-file .env -v "$PWD/site:/site:ro" -v "$PWD/data:/data" \
  -p 127.0.0.1:8081:8081 dangerblack/spore-seeder:latest

docker logs spore-seeder                 # the magnet is printed at startup
curl -s localhost:8081                   # is it actually serving?
```

`linux/amd64` and `linux/arm64`, so a Raspberry Pi 5 is a perfectly good
seeder. Or from a clone, with compose:

```sh
cd deploy/seeder
cp .env.example .env && $EDITOR .env
mkdir -p site data && cp -r your-website/. site/
docker compose up -d
```

Everything is configured in `.env`, so there are no arguments to get wrong and
the passphrase never reaches a command line — where `docker inspect`, `ps`, and
shell history would all have it.

`site/` is your website and can be mounted read-only; the seeder never writes
there. `data/` holds a frozen copy of every version it has published, plus
`versions.json`. **Keep `data/`.** It is what makes each magnet permanent and
what lets readers on an old version ever hear about a new one.

Nothing needs to be exposed. WebRTC connections are established outbound
through the trackers, so there are no ports to forward. The only published port
is the status endpoint, on `127.0.0.1`.

### Editing the site

Change anything in `site/` and within `SPORE_WATCH_SECONDS` the seeder hashes
it, publishes it as a new version, signs a successor with your key, and offers
that to anyone still reading an older version. You do not restart anything and
you do not hand out a new link — readers of the old one are told.

It keeps seeding the old versions, up to `SPORE_KEEP_VERSIONS`. That is not
politeness, it is the mechanism: the successor travels between peers, so only
something holding the version a reader is on can tell them there is a newer
one. Drop the old version and the news reaches nobody.

Without `SPORE_PASSPHRASE` the site is still served, and new versions are still
published — but nothing is signed, so nobody is ever told about them. Readers
have no key to check a successor against.

Verified end to end: a browser opened version 1 from this seeder, the file was
edited on the server, and the offer appeared in the browser a few seconds later
without touching the tab.

### Is it alive?

A seeder's characteristic failure is not crashing. It is staying up while
serving nothing, and every log line reading healthy while it happens. So it
answers on `SPORE_STATUS_PORT` with what actually matters:

```sh
curl -s localhost:8081
{
  "site": "blog", "signed": true, "complete": true,
  "current": "de1306c4…", "peers": 2, "uploaded": 15982,
  "versions": [ { "infoHash": "27f3c615…", "complete": true, "peers": 1 }, … ]
}
```

`complete: false` is the one to alert on. It is also the Docker `HEALTHCHECK`,
so `docker compose ps` reports `healthy` rather than merely `Up`.

That check exists because the failure was real and cost an afternoon: the
seeder was announcing a torrent it could not read a single byte of, reporting
itself complete the whole time, because `progress` comes from the piece map
built while hashing rather than from the disk. It now reads every file back
before announcing it, and refuses to publish a version it cannot read.

## Keeping a site

Spore writes nothing to disk by default — no cache, no history. **Keep offline**
is you deciding otherwise for one site: its contents are stored in IndexedDB, it
opens instantly with no peer online, and it is seeded from the moment Spore
starts rather than only once someone else turns up.

It asks before it does that, because it is not free: the site's contents sit on
your device where anyone using the browser profile can read them, and you
announce that you hold it every time Spore opens rather than only while reading.
**Forget** deletes the record and every stored byte. Full reasoning in
[SECURITY.md](SECURITY.md#keeping-a-site-on-this-device).

This is not the same as always-on availability: a kept site is still only
reachable while one of your tabs is open. A seeder that runs without a browser
is a later phase.

Keeping a site does not cost you the ability to pass it on. The list links to
the magnet the site was kept with — trackers and all — and **Share** in the
status bar hands you a link for whatever is on screen, however you got there.
A bare infohash is not a substitute: it names the content and says nothing
about where to ask for it, so it opens on the device that already has the
bytes and is useless to anybody else.

## What this is not

- **Not anonymity.** Peers in a swarm see each other's IP addresses. Spore
  protects *content* from being taken down; it does not hide who publishes or
  reads it. Do not use it as if it did.
- **Not persistent yet.** Browser peers only reach other WebRTC peers, and
  seeding stops when the tab closes. Close every tab that has a site open and it
  goes dormant until someone with a copy seeds it again. Always-on seeding is a
  later phase.
- **Not updatable yet.** A magnet addresses fixed bytes, so editing a site
  changes its address. A design for fixing that without introducing a host is
  drafted in [spec/mutable-sites.md](spec/mutable-sites.md) — signed
  successors delivered peer to peer, reusing BEP 44's record unchanged. It is
  a draft, not an implementation.

## Checking it still works

The security model is a set of claims about what a browser will and will not
do, so it is checked in one rather than argued about:

```sh
npm install                    # dev dependencies, needed only for this
npm test                       # or: node tools/e2e.mjs --chrome /path/to/chrome
```

It publishes `example-site/`, opens it the way a reader would, and asserts each
guarantee: the site renders from the swarm with its stylesheet and images,
scripts stay dead until opted in, an off-site image is refused, and a site
cannot climb out of its own torrent into another one. Signing and updates are
driven through the gate's own UI across three browser contexts — one publisher,
one reader who is offered the successor, one who expects a different author and
must refuse it.

It runs a **local tracker** for the duration. The two public `wss://` trackers
are this project's most fragile dependency, and a suite that fails when one of
them is having a bad afternoon teaches nobody anything. What is exercised —
real WebRTC between real browser peers — is the same either way.

## Layout

```
index.html          the gate
app.css
sw.js               service worker: serves the swarm, sets each site's CSP
js/
  app.js            wiring: fragment routing, address bar, publish, status
  swarm.js          WebTorrent client and worker registration
  site.js           finds a torrent's entry page
  viewer.js         the sandboxed iframe
  policy.js         per-site script opt-in, and the bridge to the worker
  publish.js        a folder, a zip or loose files → seeded torrent
  zip.js            reads a .zip with DecompressionStream, no dependency
  keep.js           opt-in offline storage: keep, forget, restore on boot
  idb.js            IndexedDB — the only thing that writes to disk
  magnet.js         parsing whatever the user pasted
  config.js         trackers and timeouts
  identity.js       ed25519 keys from a passphrase, spore.pub, fingerprints
  record.js         BEP 44 signed records: sign, encode, verify
  bencode.js        canonical bencode, because a signature covers exact bytes
  updates.js        sp_update: moving signed successors between peers
  authors.js        keys this browser has met, and their highest version
  me.js             the identity signed in to this tab (memory only)
deploy/gate/        container that serves the gate (nginx)
deploy/seeder/      container that seeds one site, permanently
vendor/             WebTorrent, committed verbatim (see vendor/README.md)
tools/serve.mjs     dev server
tools/e2e.mjs       browser check of both MVP promises and the security model
tools/seed.mjs      seed a site from a server: signs, versions, health endpoint
spec/               protocol drafts, for anyone writing a second gate
example-site/       the Spore whitepaper, published through Spore
```

There is no build step and no dependency to install. Clone it, serve the
directory, and it is the same gate — which is the point: any mirror runs it
identically.

`package.json` lists dev dependencies, and they are only for `tools/` and
`deploy/`: the browser check, the local tracker it runs, and the server seeder.
None of them is needed to host or mirror the gate.

## License

MIT.
