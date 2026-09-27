# Mutable sites

**Status: implemented in part.** Signed successors are built — `spore.pub`,
`spore.sig`, records carried peer to peer by the `sp_update` extension, and
the offer a reader can take or leave. The rendezvous swarm, introductions,
flagging and key rotation are not. [What is implemented](#what-is-implemented)
has the exact line. Where something is unproven it says so; the open questions
at the end are real, not rhetorical.

## The problem

A magnet addresses content. `xt=urn:btih:<hash>` is the SHA-1 of the torrent's
`info` dictionary, which contains every file's name, length and piece hashes.
Change one byte and the address changes. That is not a limitation to be worked
around — it is why any stranger can serve you a site and you can still trust
what you got.

But a website that cannot be edited is barely a website. So we need a stable
name that resolves to a changing infohash, without introducing a host, because
a host is the thing the project exists to remove.

## What already exists, and why it does not reach a browser

[BEP 44] defines signed mutable items in the BitTorrent DHT: an Ed25519
keypair, a sequence number, a value of at most 1000 bytes, and a signature that
anyone can verify. [BEP 46] uses one to hold the current infohash of a
"torrent series", addressed as `magnet:?xs=urn:btpk:<pubkey>`.

That is precisely the right design, and a browser cannot use it. The DHT is a
Kademlia overlay speaking bencoded UDP datagrams to arbitrary hosts. Browsers
have no UDP socket API, by design — arbitrary outbound UDP would make every
browser a port scanner. WebRTC is not a substitute: a data channel needs an
out-of-band SDP handshake, then ICE, DTLS and SCTP framing, none of which a
libtorrent DHT node understands. The same limitation is why WebTorrent needs
`wss://` trackers, and why the `udp://` trackers in a typical public magnet are
silently ignored by every browser client.

## The approach

**Keep BEP 44's signed object exactly. Add one transport for it.**

Nothing here invents crypto, a payload format, or an address format. The only
new thing is a way to deliver an existing kind of signed record to peers that
cannot speak UDP: a BitTorrent wire extension, negotiated through [BEP 10],
which every client already implements and which ignores extensions it does not
know.

The consequence is that the peer serving you a site can also tell you a newer
one exists, over the connection you already have. No lookup service, no bridge,
no DHT.

## `spore.pub`

A site declares its identity by including a file named `spore.pub` in the top
level of its folder — beside `index.html`.

- First line: 64 lowercase hexadecimal characters, the Ed25519 public key.
- Optional `name=` line: what the key calls itself. A claim, not a fact — see
  [The claimed name is a claim](#the-claimed-name-is-a-claim).
- Optional `site=` line: which of this author's sites this is. It becomes the
  BEP 44 salt, so `(key, site)` is what an update addresses. Canonical form is
  NFC, lower-case and free of whitespace, at most 64 UTF-8 bytes. Absent means
  the empty salt — the author's default series. See
  [One key, many sites](#one-key-many-sites).
- It is ordinary file content. It is covered by the torrent's own hashes, so it
  cannot be altered without changing the infohash, and any BitTorrent client
  downloads it like any other file.

```
7962e2fa4c1b0d5e8a3f76b21c9d0e4a5f8b3c6d1e2a7f04b9c8d3e6a1f5b0c4
name=Lara from work
site=blog
```

A site without `spore.pub` is immutable and any update message concerning it
**must** be ignored.

The key is deliberately carried in the content rather than only in the magnet,
so that a link reshared as a bare infohash still carries the identity.

### What its presence does not prove

This is the easiest thing here to get wrong, so it is worth stating flatly:
**`spore.pub` is not a signature over the site.** Nothing signs the torrent.
The file is ordinary content, and anyone can put any public key in a folder and
publish it. Its presence says nothing about whether whoever built the torrent
holds the matching private key.

What it establishes is *continuity*, not origin. It names the only key whose
successors this site will accept, and the signature that exists lives on the
update record, not on the content. Three consequences follow, and readers are
entitled to all of them:

- **A first version is unauthenticated.** Trust on first use, exactly as with a
  stranger on the telephone saying a name.
- **Impersonation is possible.** Copy a site, replace `spore.pub` with your own
  key, keep the `name=`, publish. Different bytes mean a different infohash, so
  it is a different site at a different address, but nothing inside the protocol
  tells a reader which one was the original.
- **Hijacking is not.** An impostor cannot update somebody else's site: rule 2
  requires the record's key to equal the key in the `spore.pub` the reader
  already has, and putting the victim's key in a copy yields a site the
  impostor can never sign a successor for.

So the property is narrow and worth saying in one sentence: *the people who can
move the readers of a given site forward are exactly the holders of the key that
site declared.* Whether that key is the one you meant to follow is a question
this protocol cannot answer, and must be settled out of band, by comparing a
fingerprint against one obtained from somewhere already trusted.

Half of that gap is closed by `spore.sig`, below: it makes *declaring* a key
different from *holding* one, so the impersonation above is detectable offline
from the torrent alone. What remains out of band is only the last step, whether
the key is the one you meant, and no protocol answers that.

## `spore.sig`

A site **should** also carry `spore.sig` beside `spore.pub`: a list of every
other file with the SHA-256 of its bytes, signed with the declared key.

```
spore-sig/1
key=<64 hex>
site=<series name, omitted when there is none>
<64 hex sha256> <path>
<64 hex sha256> <path>
sig=<base64 ed25519 signature>
```

- Entries cover every file in the site **except `spore.sig` itself**, which is
  why there is no circularity: the manifest signs the others, and the infohash
  then covers the manifest.
- Paths are relative to the directory holding `spore.pub`, not to the torrent.
  A torrent's name is metadata, and renaming a site must not invalidate what
  its author signed.
- Entries are sorted by path compared as raw UTF-8 bytes, so two
  implementations produce the same file for the same input.
- The signature covers every byte before `sig=`, including the trailing
  newline. A verifier re-derives that region from the file it received rather
  than rebuilding it from parsed fields, so what is checked is what was sent.

A client presents three distinct states, and **must not** collapse them:

| State | Meaning |
| --- | --- |
| verified | every file present matches the manifest, and the manifest verifies under the declared key |
| declared | `spore.pub` is present, `spore.sig` is absent: a claim with nothing behind it |
| broken | the signature fails, a file does not match, a listed file is missing, or a file is present that the manifest never covered |

A file in the torrent that the manifest does not list is a failure, not an
omission: it is content travelling under a signature that never covered it.

This makes the first version of a site checkable, which the update record alone
never did. It needs no peer to serve anything extra, no DHT, and no prior
knowledge of the site.

The design that would close the remaining step is [BEP 46][]: address a site by
`(key, salt)` rather than by infohash, so resolving the address *is* checking a
signature, and there is no unsigned first version to reason about. Spore cannot
use that as its entry point, because resolving it requires the DHT and a browser
has no UDP. Records reach a browser only from peers, which means being in the
swarm already. The rendezvous swarm under
[Bootstrapping from an identity alone](#bootstrapping-from-an-identity-alone) is
the intended way out, and it is not built.

## The record

Byte-for-byte a BEP 44 mutable item, bencoded, with BEP 46's value:

| key | type | meaning |
|---|---|---|
| `k` | 32 bytes | Ed25519 public key |
| `seq` | integer | monotonically increasing version counter |
| `v` | dict | `{ "ih": <20-byte infohash of the new version> }` |
| `sig` | 64 bytes | Ed25519 signature |
| `salt` | bytes | optional; see Open questions |

What gets signed, and how the DHT target is derived, are defined by BEP 44 and
are **not** restated here. Implementations must follow BEP 44 rather than any
paraphrase, so that the same record is valid in the DHT and on the wire.

## The wire extension

Extension name: **`sp_update`**.

A peer that supports it advertises it in the BEP 10 extended handshake:

```
{ "m": { "ut_metadata": 1, "sp_update": 3 } }
```

A peer holding a newer version of a torrent it is serving SHOULD send one
`sp_update` message, carrying the bencoded record above, after the extended
handshake completes. A peer MAY send another if it learns of a newer version
while the connection is open. Peers that did not advertise `sp_update` are
never sent one.

The message is advisory. It carries no content, only an address.

### Verification

On receiving an `sp_update` for a torrent, a client **must** reject it unless
all of the following hold:

1. The torrent being served contains `spore.pub`.
2. `k` equals the key in that `spore.pub`. *(Without this check a peer could
   announce a successor signed by a key of its own choosing.)*
3. `sig` verifies over the record per BEP 44.
4. `seq` is not *older* than the highest `seq` previously accepted for this
   key and salt, remembered locally across sessions. Strictly older is refused;
   equal is not, because a record equal to what is already known names the
   version the reader has already accepted and therefore cannot pin them
   backwards. Refusing equality broke a real case: a reader who takes an update
   and later opens an older copy they kept is reading something stale, and was
   never told so.
5. `v.ih` differs from the infohash currently being read.

A record that fails any check is discarded silently. A record that passes means
only that *the holder of this key says there is a newer version at this
address* — the new version is then fetched and verified like any other torrent.

### Why rule 4 exists

Without it, a peer can replay an older signed record and pin a reader to a
stale version. The content is still authentically the author's, so this is a
freshness problem rather than a forgery one, and for most sites it is a minor
one. It matters when the update *is* the point: a correction, a retraction, or
"the previous version has a security bug". Remembering the highest `seq` per
key costs a row in storage the gate already has.

A consequence: reverting is done by publishing the old content forward under a
higher `seq`, never by going back.

## Authors, names and trust

A key is an author. Once a reader has seen one, the useful question is not "who
is this" but "is this the same one as last time" — which needs no authority,
no registry and no network.

### Nothing is remembered unless the reader acts

An author is recorded **only** when the reader explicitly trusts them. Merely
opening a site records nothing.

This keeps a property the gate otherwise has: reading leaves no trace on disk.
An address book written on sight would be a durable log of everything you had
ever read, which is exactly what Spore avoids elsewhere.

A consequence, accepted deliberately: `seq` memory (the downgrade check, rule 4
above) only exists for trusted authors. A reader with no relationship to an
author gets no replay protection, which is proportionate — there is nothing
established to protect.

### The claimed name is a claim

`spore.pub` MAY carry a second line:

```
9a3f…64 hex characters…
name=Hacker One
```

Because it lives in the site's content, it is covered by the torrent hashes: no
peer can alter it. **Tamper-proof is not the same as true.** Anyone can
generate a key and claim any name; a signature proves the holder said it, never
that it is so. Rendering such a name as the author's identity would rebuild the
self-signed-certificate problem — authority in appearance, nothing behind it.

Implementations therefore **must not** display a claimed name as the author's
name. It is shown as a claim, in quotation, and never on its own.

### Petnames

The name shown with authority is the one the reader assigns. This is the
standard resolution of Zooko's triangle — of *memorable*, *globally unique* and
*securely yours*, one name gets two:

| | memorable | globally unique | secure |
|---|---|---|---|
| the key | ✗ | ✓ | ✓ |
| the claimed name | ✓ | ✗ | ✗ |
| the petname you assign | ✓ | to you | ✓ |

Petnames are also immune to homograph tricks — `hackerone` against `hackerοne`
with a Greek omicron — because the reader typed them.

Two different keys claiming the same name is **ordinary, not suspicious**.
There are many people called Lara, and both of them are entitled to say so. The
reader resolves it the way people always have, by qualifying: *Lara from work*
and *Lara Croft*. So an implementation should offer the claimed name as a
starting suggestion, let it be edited, and when it collides with a petname
already in the book, ask for a distinguishing one rather than warning about an
attack that probably is not happening.

What helps at that moment is context, not alarm: where this key just came from,
whether it published the site being read, when the introduction arrived. That
is what answers *which* Lara.

Impersonation cannot present itself as a petname, because petnames never travel
— they exist only in one reader's book. An unknown key is always shown as
unknown, whatever it claims to be called. The two states that carry weight are
therefore narrow and worth stating exactly:

- a key you have **not** trusted appears — shown as unknown, always, no matter
  what name it claims;
- a key you **have** trusted is superseded by a different key on a site you
  associate with it — the loud case, and the reason keys are stored at all.

A trusted key that changes its *claimed* name is unremarkable; people rename
themselves. Your petname for them is unaffected, because it was never theirs to
set.

One key has one petname, and one petname belongs to one key.

The states an implementation should distinguish:

```
never seen     ◈ unknown author · claims to be "Hacker One" · zebra-monk-tidal-fern
                 [ Trust this author as… ]

trusted        ◈ Hacker One ✓  · trusted 12 March · 3 sites
                 (the reader's own name, shown plainly)

mismatch       ◈ ⚠ this is NOT the key you know as "Hacker One"
                 same claimed name, different author
```

The last state is the entire point of storing keys, and the only one that
catches a substitution.

### Marking an impostor

Trust has an opposite, and a reader needs to record it. You read an article by
a key claiming to be Lara Croft, you conclude from the article itself that it
is not the Lara Croft you follow, and you want that conclusion to survive —
so the next time this key turns up you are not doing the analysis again.

So the book holds one kind of entry with a sign, rather than two lists:

| field | |
|---|---|
| key | the 32 bytes; the entry's real identity |
| your name for it | *Lara Croft*, or *fake Lara Croft* |
| status | trusted, or flagged |
| note | optional, in the reader's words — "pretends to be Lara Croft" |
| when, and where | the date, and the infohash it was read on |

Recording the infohash matters: months later the note means little without the
article that produced it, and the article is still addressable.

A flagged key, met again, produces a full stop rather than a footnote — the
same treatment a missing site gets, not a line of small text. But the gate
**should not refuse to render it.** Deciding what a reader may look at is the
posture this project exists to oppose, and the reader has already demonstrated
they can judge. Say it loudly, name the date and the note, offer to continue.

### What flagging is actually worth

Less than it feels, and it is worth being straight about that.

An impostor who is flagged simply generates another key. Flagging therefore
does not prevent impersonation; it prevents *repeat* impersonation by the same
key, which is a much smaller claim.

The actual defence is elsewhere and is already specified: an untrusted key is
displayed as untrusted no matter what name it claims, so the impostor never
receives the presentation that would make the lie work. The flag is a memory
aid on top of that — it saves the reader from re-reaching a conclusion they
have already reached. Useful, and not a security boundary.

### Flags stay local

The obvious next feature is sharing them: my flags, published, so my friends
inherit them. This specification says no, and the reason is not squeamishness.

A propagating "this author is a liar" record is a takedown mechanism. It is
precisely as effective as the ones the project exists to resist, aimed inward
and easier to operate: no host to petition, no jurisdiction, just a signed
claim that spreads through the same channels the content does. Someone with
reach flags an author and that author is functionally erased for everyone
downstream. There is no revocation here, no appeal, and no way for the accused
to answer — and a false accusation is as portable as a true one.

Trust may be shared by introduction, because an introduction is an offer the
recipient chooses to act on and can verify against the key. Distrust broadcast
at strangers is a different instrument, and this design does not build it.

### The phone book

The model is caller ID. A call announcing "this is Abraham Lincoln" tells you
nothing — the display is under the caller's control. A number already in your
phone book tells you a great deal, and the reason is not the phone: it is that
the entry got there through some earlier event you trusted. Someone gave you
the number.

Everything above is the caller ID. What follows is how an entry gets into the
book.

### Introductions

An author can present themselves as a link:

```
https://<any-gate>/#author=<64 hex>&name=Hacker%20One
```

Opening it does not fetch or publish anything. The gate shows the avatar, the
word fingerprint, the claimed name — as a claim — and offers to save the author
under a petname.

The link is not secret and proves nothing on its own; a public key is public,
and anyone who copies it can send it on. **The trust comes from the channel,
not the link.** Received in a message from someone you already know, or read
off a slide by a speaker you are watching, it is exactly the out-of-band step
the model needs. Scraped from a random page, it is worth what the page is
worth. Implementations should say so at the moment of trusting, because that is
the only moment the distinction is actionable.

The same key travels a second way: in `spore.pub`, inside every site the author
publishes. Someone who reads a site and later receives an introduction — or the
reverse — ends up at the same key, and the gate can say they match.

### Deriving a key from a passphrase

An author's key may be derived from a passphrase rather than stored in a file,
which means nothing to back up and the ability to publish from any machine.

This is not a login, and calling it one would mislead. There is no account, no
server, and nothing to check the passphrase against: **every passphrase
produces a valid key**, just a different one. A typo does not fail, it silently
makes you a different author, and the first symptom is readers seeing a
stranger.

Two consequences for any implementation offering it:

- Show the avatar and fingerprint the instant a passphrase is entered, before
  anything is signed. A wrong passphrase is then visible as a wrong picture.
- The gate MAY remember the *public* key of the identity used on that device,
  purely to warn that a freshly entered passphrase produced a different one.
  This stores nothing secret and catches the common failure.

The private key SHOULD be held in memory only and never written to storage.
Publishing is rare; re-entering a passphrase for it is a small cost against
keeping the one irrecoverable secret out of the disk entirely.

The security caveat from earlier applies with full force: the public key is
public, so a passphrase can be attacked offline with no rate limit, exactly
like a cryptocurrency brain wallet. A generated multi-word passphrase, not a
free-text field.

### Verifying a claim

Spore has no messaging and should not grow any — that would be another service
to run and to take down. Verification is out of band and always was: the
author's existing HTTPS site linking the key, a signed post somewhere you
already associate with them, a conference talk, a business card, a message on a
platform where you already know them.

A site MAY name a URL where the author says the key is also published. The gate
**must not fetch it** — that would be exactly the egress the security model
forbids. It may only display it, for the reader to check themselves.

### Fingerprints and avatars

Two derived, unstored representations of a key, both computed from
`SHA-256(key)`:

- **A word fingerprint** — four words from a wordlist fixed by this
  specification, roughly 44 bits. Words are what make comparison possible
  aloud, over a phone, or in a talk. Sixty-four hex characters are not.
- **An avatar** — a symmetric cell grid with colours drawn from the same
  digest. Symmetry aids memory; the point is that a change is *noticed*.

Neither is a verification mechanism, and implementations should not imply that
they are. SSH says the same of its randomart, for the same reason: an attacker
can grind keypairs until the picture looks approximately right, and people
compare pictures coarsely. The avatar answers "does this look like last time";
the full key answers "is this the same key".

## One key, many sites

**Decided.** A site declares a series name in its `spore.pub`, and that name is
the BEP 44 salt. An update addresses `(public key, salt)`, never the key alone.

```
7962e2fa…c1d4
name=Lara from work
site=blog
```

The alternative was tried and is a trap: with history keyed by public key alone,
an author who publishes a second thing signs it as the *successor to the first*.
Their blog readers are offered an unrelated page as the blog's next version, and
the record is perfectly authentic — correctly signed, by the right key, about
something else. Nothing on the reader's side can catch it, because from the
reader's side there is nothing wrong with it. A key is an author; an author has
many sites.

The name is chosen and typed by the publisher rather than generated, because
that is what makes a series reproducible: passphrase plus `blog` continues the
blog from any machine, with nothing to back up and no state to lose. It is
canonicalised — NFC, lower-cased, no whitespace — since the salt is compared
byte for byte and `Blog` would otherwise silently fork the series.

A site with no `site=` uses the empty salt, which is an ordinary unsalted BEP 44
item. So "the author's default series" needs no special case, and a `spore.pub`
written before this existed keeps working.

## Versions are timestamps

**Decided.** `seq` is `Date.now()` — milliseconds since the epoch.

BEP 44 requires only that a successor's seq be strictly greater than the one
before it; it says nothing about counting. A counter has to be remembered, and
in a browser the only place to remember it is that browser's storage — so
publishing the same site from a second machine restarted at 1 and every reader
correctly refused it as stale. Your own laptop could not update your own blog.
A clock needs nothing remembered and agrees with itself across machines.

The cost is that a wrong clock publishes a wrong number, and one running far
ahead burns the series until real time catches up. That is a broken clock's
problem to fix. Readers do not second-guess it: strictly-greater wins, exactly
as specified. A reader cannot audit someone else's clock, and refusing
"suspiciously future" records would reject valid ones.

It also reads better. `Version 1757620488123` is noise; rendered as a date it
tells a reader something `Version 7` never could.

## Offer, never follow

**Decided.** A verified successor is shown to the reader and applied only when
they act on it.

The argument for switching automatically is that most readers will otherwise
stay on stale content out of inertia, and that is true. It loses anyway. A
signature establishes *who* wrote a version, not that the reader consents to be
moved to it — and the key that signs the successor is the same key an attacker
would hold after stealing it, so silent replacement turns one compromise into
retroactive control over what everyone is currently reading. A specific version
may also have been linked deliberately, by someone quoting it.

So verification is automatic and the navigation is manual. It is the same shape
as the per-site script permission: the gate does the work of deciding whether
something *could* be trusted, and leaves whether to trust it to the person.

Declining is remembered only in the sense that nothing changes: the reader stays
where they are, the record is still held, and it is offered again on the next
visit. A declined update is not a rejected one.

## Publishing an update

1. Edit the folder. Keep `spore.pub` in it — same key.
2. Create the new torrent. Its infohash is M2.
3. Build the record: `seq` = previous + 1, `v.ih` = M2. Sign with the private
   key.
4. **Keep seeding the old version**, now also offering the record over
   `sp_update`.
5. A seeder that has UDP SHOULD also publish the identical record to the DHT
   per BEP 46, so that non-browser clients resolve it the standard way.

Old links keep working and now point forward. They upgrade for exactly as long
as someone keeps the old swarm alive; when nobody does, an old link is dead —
which is what it would have been anyway.

## Bootstrapping from an identity alone

Everything above requires the reader to already hold *some* infohash: you join
that swarm and meet a peer who tells you the current one. A `btpk:`-only
address — an identity with no content address — has nothing to join. That is
the case the DHT genuinely exists to solve.

**Unproven idea, offered for scrutiny:** derive a meeting point from the key.

Construct a torrent deterministically from the public key — one file whose
content is the 32 raw bytes of the key, with the file name, torrent name and
piece length fixed by this specification. Every implementation computes the
same infohash from the same key without communicating. Publishers join that
swarm; a reader holding only `btpk:P` constructs it identically, joins through
the ordinary `wss://` trackers, meets the publisher and receives the record.

This would make identity-addressed sites work in a browser with no DHT and no
bridge, using only infrastructure that already exists. It is also the least
examined idea in this document. See Open questions.

## What this does not do

- **It does not tie a key to a person.** A signature proves the same key
  published both versions, nothing more. `P` means "you" only because you
  announced it somewhere already trusted — a talk, an existing site, a business
  card. Same as an SSH or PGP key. A name carried in `spore.pub` is a claim by
  the key holder and evidence of nothing.
- **There is no revocation.** A key is the identity; a compromised key cannot
  be retired by any mechanism here.
- **Losing the key ends the site's history.** No recovery. If the key is
  derived from a passphrase, forgetting the passphrase is losing the key.
- **It does not resurrect abandoned sites.** Nobody seeding, nothing to find.
- **It is not anonymity.** Peers see each other's addresses, as always.

## What is implemented

Everything above from `spore.pub` through verification, plus the reader and
publisher halves in the gate: `js/bencode.js`, `js/record.js`, `js/identity.js`,
`js/updates.js`, `js/authors.js`, `js/me.js`. Covered end to end by
`tools/e2e.mjs`, including the whole loop driven through the gate's own UI
across three browser contexts.

`tools/seed.mjs` publishes and signs from a server using those same modules
unmodified — Node's WebCrypto has Ed25519 — and keeps every version seeded,
which is what lets an update reach anyone at all: the record travels between
peers, so only something still holding the version a reader is on can pass it
to them.

Two implementation notes that the design above does not imply and that cost real
time to find:

The extension must be attached to a torrent **before** it has peers, not once it
is ready. BEP 10 advertises capabilities exactly once, in the extended
handshake. A watcher attached after metadata arrives is invisible to every peer
already in the swarm — which is precisely the set most likely to be holding an
update — and since the exchange is symmetric, those peers never send anything
either. Attaching that early means the site's own key is not yet readable, so
the key is resolved through a promise and any record arriving first waits for
it.

Petnames are implemented, in the narrow sense the design calls for: a reader
can name a key, the name is stored only in that browser, it is never published,
and it replaces the key's self-declared claim wherever that reader sees it.
Nothing exports or shares them, which is deliberate — see
[Flags stay local](#flags-stay-local).

`spore.sig` is implemented in `js/manifest.js`, written by both publishers (the
gate when signed in, and `tools/seed.mjs` on every version it publishes) and
checked by the gate on every read.

Not implemented: the rendezvous swarm, introductions, flagging, and key
rotation.

## Interoperability

A Spore site remains an ordinary torrent. Clients that do not know `sp_update`
never receive it — BEP 10 makes unknown extensions a non-event — and download
the site normally. They simply do not learn about updates, which is
unsurprising given they were not going to render it either.

Because the record is a BEP 44 item and not an invention, a seeder with UDP can
publish it to the DHT, where any BEP 46-capable client resolves it without
knowing this document exists.

## Open questions

**The rendezvous swarm.** Do public `wss://` trackers accept a swarm with no
real content? What stops a stranger squatting an identity's rendezvous with
noise — signature checks make it correct but not quiet? Joining the rendezvous
tells the tracker you are interested in that identity, which is a different
disclosure from asking for an infohash. And is the deterministic construction
stable enough to specify exactly, across implementations?

**The introduction link format.** `#author=<hex>&name=…` is readable and cannot
be confused with a magnet or a bare infohash, which are the other things a
fragment can hold. It is not otherwise defended; a shorter or signed form may
be better. A signed introduction would prove the key holder authored the
claimed name, which is a smaller guarantee than it sounds — the name is still
self-asserted — so it probably is not worth the bytes.

**The wordlist.** Fingerprint words must be fixed by this specification or two
implementations will disagree about the same key, which is worse than having no
fingerprint. BIP-39's English list is 2048 words, widely available and already
chosen for being hard to confuse when spoken — reusing it costs nothing and
avoids inventing a list badly. Not decided.

**How much avatar is enough.** A symmetric grid with a few colours is a small
visual space, and grinding keypairs to land near a given picture is cheap.
Since the avatar is explicitly not the verification mechanism this may be
acceptable, but the size of the space should be chosen deliberately rather than
by whatever looks nice.

**Pressure to share flags.** The prohibition above will be asked about, because
inheriting a friend's judgement is genuinely convenient and the mechanism is
trivial to build. If it is ever revisited, the questions to answer first are
who can be held to a false accusation, how an author answers one, and what
stops a flag propagating further than the reader who accepted it — none of
which have good answers today, which is why the answer is no.

**Exporting trust.** A reader's petnames and trusted keys are the only thing
here that cannot be regenerated. Losing a browser profile loses them. Whether
they can be exported, and in what format, is unspecified.

**Key rotation.** A record signed by the old key naming a new key is the
obvious mechanism and has an obvious flaw: whoever stole the key can rotate
first. Out of scope here, deliberately.

**Passphrase-derived keys.** Attractive — nothing to back up, publish from any
machine. But the public key is public and offline-grindable, exactly like a
cryptocurrency brain wallet. If offered at all it needs a generated multi-word
passphrase rather than a free-text field. Ed25519 and PBKDF2 are both native in
current Chrome, Chromium and Firefox, and a derived 32-byte seed can be
imported by wrapping it in the fixed PKCS#8 prefix — measured at 290–912 ms for
600k iterations of PBKDF2-SHA-512, so the cost can go higher.

[BEP 10]: https://www.bittorrent.org/beps/bep_0010.html
[BEP 44]: https://www.bittorrent.org/beps/bep_0044.html
[BEP 46]: https://www.bittorrent.org/beps/bep_0046.html
