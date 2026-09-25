# vendor/

Third-party code, committed verbatim so the gate stays a **static bundle with no
build step**: clone, serve the directory over HTTPS, done. No npm install, no
bundler, no transpiler — anyone can re-host a mirror.

| file                 | source                                   | version | license |
|----------------------|------------------------------------------|---------|---------|
| `webtorrent.min.js`  | npm `webtorrent`, `dist/webtorrent.min.js` | 3.0.21  | MIT (`webtorrent.LICENSE`) |

To upgrade:

```sh
npm pack webtorrent@<version>
tar xzf webtorrent-<version>.tgz
cp package/dist/webtorrent.min.js vendor/
cp package/LICENSE vendor/webtorrent.LICENSE
```

Then check the oldest browsers still work, because the bundle is what sets the
minimum in the README's "Browser support". Version 3.0.21 calls four built-ins
younger than everything else (`Uint8Array.prototype.toHex`, `toBase64`,
`Uint8Array.fromHex`, and `AbortSignal.timeout` on its HTTP path), which is why
`js/polyfills.js` exists. Search the new bundle for others, update the
polyfills or the table, and run:

```sh
node tools/e2e.mjs --only-older
```

Note: we deliberately do **not** vendor `dist/sw.min.js`. Our own `sw.js` is a
re-implementation of that worker's message protocol which additionally injects a
per-torrent Content-Security-Policy — see the comments in `sw.js`.
