# deploy/

Two containers that do unrelated jobs. Picking the wrong one is easy, so they
are named and separated rather than sharing a compose file at the repository
root — where `docker compose up` would read as "start the project" and quietly
have meant "seed a folder".

| | you want this if | what it is |
|---|---|---|
| **[`gate/`](gate/)** | *"let people open and publish sites"* | nginx serving the static bundle |
| **[`seeder/`](seeder/)** | *"keep my published site up when my tab is closed"* | a WebRTC seeder for one folder |

They are independent. Running the gate seeds nothing; running a seeder serves
no web page. A working setup for one person will often be the gate on a host
with TLS and a seeder wherever the content lives — but you can run either
alone, and most people only ever need the gate.

## Architectures

The seeder is published as a multi-arch image, so on a supported architecture
there is nothing to build:

```sh
docker pull dangerblack/spore-seeder:latest   # linux/amd64, linux/arm64
```

Releases are built by `.github/workflows/seeder.yml` rather than by hand:

```sh
git tag seeder-v0.2.4 && git push origin seeder-v0.2.4
```

It builds both architectures, pushes the version and `latest`, then starts the
published image and fails the release unless it reports `complete: true`,
`signed: true` and has written a `spore.sig`. Needs two repository secrets,
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.

Both images build and run on **x86-64** and on **64-bit ARM** — a Raspberry Pi
5 running 64-bit Raspberry Pi OS or Ubuntu is fine, and so is an Apple Silicon
machine. Docker picks the right architecture for the host on its own; there is
nothing to configure.

What that rests on, since one of these is a native module:

- `nginx:1.27-alpine` and `node:22-slim` both publish `linux/arm64/v8`.
- `node-datachannel` ships a prebuilt binary per platform, and the arm64 one is
  a genuine `ELF 64-bit … ARM aarch64` object for glibc. npm downloads it, so
  no compiler is needed on the Pi.

**32-bit ARM is the exception.** There is no prebuilt binary for `armv7`/
`armhf`, so on 32-bit Raspberry Pi OS the seeder would have to compile
node-datachannel from source and the image, which carries no toolchain, will
fail to build. Use the 64-bit OS — on a Pi 5 there is no reason not to. The
gate has no native code and runs on 32-bit ARM regardless.

Verified here by inspecting the published images and binaries, not by running
them on ARM hardware: this machine is x86-64 and has no emulation registered.
If it matters to you, `docker compose build` on the Pi itself is the test, and
it either downloads the arm64 binary or fails loudly.

## gate/

```sh
cd deploy/gate
docker compose up -d          # http://localhost:8080
```

Serves `index.html`, `app.css`, `sw.js`, `js/` and `vendor/`. It stores nothing
and learns nothing about what is read through it: the site being viewed lives
in the URL fragment, which browsers never send to a server.

**HTTPS is required in production.** A service worker needs a secure context
and the gate serves every site through one, so on a plain-HTTP LAN address the
whole thing simply will not work. `localhost` is the one exemption browsers
make. Put this behind Caddy, Traefik or nginx for a real deployment — or skip
containers entirely and drop the bundle on any static host, which is what
[GitHub Pages](../README.md#hosting-it) does.

### Optional: each site on an origin of its own

Off by default, and a plain static mirror cannot turn it on. With it off, a site
whose scripts a reader enables shares the gate's origin, and so can reach what
Spore stores for every other site — the gate says so before it asks. With it on,
each site is shown at `<infohash>.<content domain>`, which the browser keeps
apart from the gate.

The content domain must be **a different registrable domain** from the gate's
(`spore-content.example` for a gate at `spore.example`, not
`content.spore.example`): under the gate's own, a site could set cookies the
gate receives, so the gate refuses that configuration. Putting the content
domain on the [Public Suffix List](https://publicsuffix.org) as well — the way
`github.io` is — stops sites sharing cookies with each other too, which is the
last thing two hostile sites could use to recognise the same reader.

It needs, all three:

- **a wildcard DNS record**, `*.<content domain>` pointing at this host;
- **a wildcard certificate** for it — only a DNS challenge (ACME DNS-01) can
  issue one, so the TLS proxy in front needs a plugin for your DNS provider;
- **the content host serving the relay and nothing else.**
  [`gate/content-isolation.conf.example`](gate/content-isolation.conf.example)
  is an nginx server block that does exactly that, and says why it has to: a
  service worker's script is always fetched from the network, so the content
  host must never serve anything at a torrent's paths.

Then set `CONTENT_ISOLATION` in `js/config.js` and add the content domain to
`frame-src` in `index.html`'s policy; both files say how. Diagnostics shows
whether it is on. The whole design, and what was measured to justify it, is in
[`spec/second-origin-isolation.md`](../spec/second-origin-isolation.md).

## seeder/

```sh
cd deploy/seeder
cp .env.example .env && $EDITOR .env    # name, site, signing passphrase
mkdir -p site data
cp -r /path/to/your-website/. site/
docker compose up -d
docker compose logs                     # the magnet, printed at startup
curl -s localhost:8081                  # and is it actually serving?
```

Everything is configured in `.env`, including `SPORE_PASSPHRASE`, which is
read from the environment and never from an argument: a command line is
visible in `docker inspect`, in `ps`, and in shell history. `.env` is
gitignored — `chmod 600` it.

`site/` is the folder being served and is mounted read-only; the seeder never
writes there. `data/` holds a frozen copy of every version it has published.
**Keep `data/`**: it is what makes each magnet permanent, and what lets a
reader on an old version ever be told about a new one.

Editing the site publishes a new version within `SPORE_WATCH_SECONDS`, signed
with your key and offered to readers still on the older ones — which keep being
seeded, because a successor travels between peers and only something holding
the old version can pass it on.
