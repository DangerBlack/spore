# Why not IPFS

Show Spore to anyone who knows this space and the question arrives within a
minute: *IPFS already does content addressing in a browser, so what is this
for?* It is the right question, and it deserves better than a slogan. This
document answers it with measurements rather than opinion, including the three
places where the measurements contradicted what we expected.

The short version: **IPFS solves reading without trusting the server. Spore is
trying to solve being found while you read.** Those are different problems, and
the second one is narrower than it sounds.

## What IPFS does, and does well

IPFS is the more powerful system, and pretending otherwise would be the fastest
way to lose the argument.

- **Content routing that works.** A DHT, plus delegated routing over HTTP for
  clients that cannot speak to it directly. Spore has two public `wss://`
  trackers, which is this project's most fragile dependency and is written down
  as such in the README.
- **Retrieval that nearly always succeeds.** `@helia/verified-fetch` configures
  two block brokers by default — bitswap and trustless-gateway — and falls back
  to recursive gateways if no provider can be reached directly. Spore has no
  fallback at all: if no peer holds a site, the site is dormant.
- **A real ecosystem.** Libraries with maintainers, content that already
  exists, specifications with more than one implementation.
- **Verification as a library.** `verified-fetch` is a reviewed implementation
  of a careful idea. Spore's equivalent is `js/sha256.js`, which exists because
  `crypto.subtle` has no streaming digest, and which one person wrote.

The closest thing to Spore in that ecosystem is
[ipfs/service-worker-gateway](https://github.com/ipfs/service-worker-gateway):
"Decentralizing IPFS Gateways by verifying hashes in the user's browser." It
registers a service worker, intercepts `/ipfs/*` and `/ipns/*`, verifies hashes
in the page, and runs **exclusively in subdomain mode** so each site gets
origin isolation from the browser itself.

That is the same shape as Spore: service worker as the single chokepoint,
hashes verified in the page, origin isolation per site. Two projects arriving
independently at one architecture is evidence the architecture is right — and
worth saying plainly, because it is the strongest thing you can tell a sceptic.
They are stricter than we are on the third point: their subdomain mode is
mandatory, while our `CONTENT_ISOLATION` is off by default because a plain
static mirror cannot do DNS and a wildcard certificate.

## What we measured

Three claims about IPFS get repeated, including by us, and all three turned out
to be wrong. Measured 2026-10-09 with `helia@5` and `@helia/unixfs@4` from
esm.sh, two separate browser contexts in one Chrome, default configuration.

The content is **random bytes, created in the page**. No gateway anywhere can
hold a copy, so whoever serves it is the other browser. That is what makes the
result mean something.

| what was tried | result |
| --- | --- |
| B asks for the CID, defaults, no help | **failed** after 120 s, with B connected to 38 peers |
| B asks after being handed A's multiaddr | **4 KB in 9 s** |
| the same, 2 MB | **2 MB in 2 s** |

The transfers ran over a connection reporting `limited: true` — a Circuit Relay
v2 connection, the kind libp2p's own documentation describes as too constrained
for bitswap. At these sizes the constraint did not bite.

So, corrected:

- **"The bytes come from a server."** False. Bitswap, peer to peer.
- **"Browser-to-browser does not work."** False. It works, and it is fast.
- **"They cannot publish from a browser."** Too strong. That *project* is a
  reader, but the stack publishes from a page without difficulty: node A
  created the content in the browser.

What failed is none of those. It is **discovery**. A browser does not become
findable as a provider. The same bytes that never arrive in 120 seconds arrive
in 9 the moment somebody performs an introduction.

This is consistent with libp2p's own guidance: browser peers tend not to live
long enough to appear in DHT or delegated-routing results, which is why the
[WebRTC connectivity guide](https://libp2p.io/docs/webrtc-browser-connectivity/)
reaches for GossipSub peer exchange instead, and why
[bitswap and kad-dht are not run over relayed connections](https://github.com/libp2p/js-libp2p/discussions/2230)
in the general case.

## Why Spore exists anyway

Spore's whole claim reduces to one sentence, and after the measurements above
it is a narrow one: **it introduces peers that only live for minutes.**

A BitTorrent `wss://` tracker exists for exactly that. It is a matchmaker, not
a peer list: a browser announces, the tracker parks a batch of WebRTC offers,
and hands them to whoever turns up. A reader is announced seconds after opening
a site, and is a source from then until the tab closes. The DHT is built for
nodes that stay; a tracker is built for nodes that do not.

That is what makes the README's claim about adoption literal rather than
rhetorical. A hundred readers are a hundred copies in a hundred jurisdictions
because each of them was introduced to the next. Remove the introduction and
they are a hundred verifiers of bytes that came from somewhere else.

The second difference is publishing, and it is a difference of product rather
than of capability: the gate's second promise is that you drop a folder and
walk away with a link, having become its first host. The service worker gateway
does not do that. The IPFS stack could.

## Where this reasoning could be wrong

Four ways, in descending order of how much they would cost us.

1. **The gap is one component, not an architecture.** Add a rendezvous for
   browser providers to Helia and Spore's advantage is gone in a release. That
   is not a far-fetched addition; it is an obvious one.
2. **It runs the other way too.** Spore could be rebuilt on Helia and keep the
   trackers for discovery, inheriting a better-maintained stack. Nothing
   measured here argues against that — it is a live option, not a dismissed
   one.
3. **Availability may not be the problem people have.** Spore trades a reliable
   gateway fallback for an unreliable swarm, which only pays off when somebody
   is trying to remove something. If that case is rarer than we think, the
   trade is bad.
4. **The seeder is a host.** `deploy/seeder/` is how a site stays up when
   nobody has a tab open, and a machine that stays on, with an address, is the
   thing this project says it is removing from the picture. The tension is real
   and is not resolved by calling it a seeder.

The honest summary is that IPFS is the more capable system, that it does not
currently make readers into hosts, and that Spore is a bet on that one
difference being the one that matters.

## Reproducing it

Serve a page that starts a Helia node:

```html
<!doctype html><meta charset="utf-8">
<script type="module">
  const { createHelia } = await import('https://esm.sh/helia@5')
  const { unixfs } = await import('https://esm.sh/@helia/unixfs@4')
  const helia = await createHelia()
  window.__helia = helia
  window.__fs = unixfs(helia)
  window.__ready = true
</script>
```

Open it in two browser contexts. In A, add bytes nobody else can have:

```js
const bytes = new Uint8Array(2 * 1024 * 1024)
for (let i = 0; i < bytes.length; i += 65536) {
  crypto.getRandomValues(bytes.subarray(i, i + 65536))
}
const cid = await window.__fs.addBytes(bytes)
```

Wait about 45 seconds for A to reserve a relay, then in B ask for that CID with
`window.__fs.cat(CID.parse(cid))`. It will not arrive.

Now take A's addresses — `window.__helia.libp2p.getMultiaddrs()` — dial one of
them from B with `window.__helia.libp2p.dial(multiaddr(addr))`, and ask again.
It arrives in seconds.

The difference between those two runs is the entire argument of this document,
in both directions: the transport is theirs and it is good, and the
introduction is the part nobody has made for browsers.
