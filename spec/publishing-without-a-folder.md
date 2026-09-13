# Publishing without a folder

**Status: draft. Nothing in this document is implemented.** It exists to be
argued with before any code is written, in the manner of
[mutable-sites.md](mutable-sites.md). The open questions at the end are real.

## The problem

The second MVP goal is "publish a site from the page". It is reachable today
only if you already have a folder on a disk, with an `index.html` in it, laid
out with relative paths. That is a reasonable demand of a developer at a desk
and an unreasonable one of everybody else — and on a phone it is not a demand
at all, it is a wall:

> **To confirm on a real device before anything is built.** iOS Safari (and
> every other iOS browser, since they are all WebKit) appears to offer no
> directory picker at all: `<input webkitdirectory>` falls back to picking
> single files, and there is no drag-and-drop of a folder. If that holds,
> publishing from an iPhone is impossible, and no amount of layout work on the
> "Choose a folder…" button changes it.

So: some way for a site to arrive that is not a folder. Two were considered,
and they are not equivalent.

## What is not changing

**The folder button stays.** Dropping a folder is the primary path, it is faster
than anything else for a site that already exists, and it imposes nothing on the
author's choice of tools. Whatever is added here is an additional way in, never
a replacement.

**Whatever arrives becomes `File[]` and nothing else.** `seed(files, name)` in
`app.js` already asks about signing, adds `spore.pub`, writes `spore.sig`, seeds
the torrent and announces a successor. Any new entry point produces that array
and hands it over. A second publishing path would be a second place for the
security model to be subtly wrong, and the security model is the project.

    folder  ──►  File[] with fullPath  ──►  seed()  ──►  (unchanged)
    zip     ──►  File[] with fullPath  ──┘

## Option A: accept a .zip

**Recommended.**

A zip is a folder that fits through a file picker. On iOS, `<input type="file">`
reaches the Files app, iCloud Drive, Dropbox and anything else with a document
provider; the folder picker that does not exist is the only thing missing, and a
zip routes around exactly that gap and nothing else.

What makes this the better option is not convenience, it is that **it is not a
new pillar**. CLAUDE.md says the MVP does two things and that anything else is
Phase 2+ and must not be built "even if it is easy". An editor is a third thing
— a writing tool inside a reading and publishing gate — and has to be justified
as an exception. A zip reader is the *second* thing with one more container
shape. Nothing new is promised, nothing new has to be maintained conceptually,
and the feature list does not grow.

It also refuses to have an opinion. Any tool that produces a folder produces a
zip: a text editor, a static site generator, VS Code, a language model that
hands back an archive, a colleague sending one over a chat app. The gate stays
out of the business of how pages get written, which is the correct business for
it to stay out of.

### What it costs

`DecompressionStream` is native and needs no dependency — Safari 16.4, iOS 16.4
(March 2023), Chrome 80, Firefox 113. `deflate-raw` is the format a zip stores,
and should be feature-detected at startup rather than assumed, because a
one-line `try` is cheaper than a failure the author cannot interpret.

Around it goes a reader of the zip container: roughly 150 lines, lazily imported
the first time someone picks a zip, so a reader who never publishes never
downloads it. For scale, the gate's own source is already 243 KB and WebTorrent
is 218 KB; this is a rounding error, and an editor's UI would not be.

### What it must refuse

The risks are well understood and each is a bounded check, which is the main
reason to believe the 150 lines stay 150 lines:

- **Path traversal.** An entry named `../../etc/x`, an absolute path, a Windows
  drive letter or a backslash separator. Reject the archive with a plain message
  rather than sanitising quietly: an archive containing one of these is either
  broken or hostile, and neither should be published under a signature.
- **Decompression bombs.** A running total of uncompressed bytes, with a cap,
  and a per-entry cap. Streaming means the cap is enforced as it inflates rather
  than discovered afterwards.
- **The central directory is authoritative.** Local file headers can disagree
  with it; read the directory at the end of the file and use that, which is also
  what makes the entry list known before a byte is inflated.
- **Only stored and deflate.** Method 0 and method 8. Anything else, including
  an encrypted entry, is refused by name.
- **No symlinks, no modes, no metadata.** A zip can carry unix mode bits; ignore
  all of it and treat every entry as a regular file.
- **The same root-stripping as a drop.** `filesFromDrop` already removes the
  single shared top folder so `index.html` lands at the top of the torrent. A
  zip must behave identically, or the same site published two ways produces two
  different layouts.

### What it does not solve

Someone with a phone, no tools and a paragraph to publish. They cannot make a
zip without first making files, and making files on a phone is the thing they
did not have a way to do. That gap is real, and it is the entire remaining case
for Option B.

## Option B: an editor in the gate

A textarea holding the literal bytes of `index.html`, published through the same
path. Considered in detail in the history of this document; the summary is that
it is genuinely small in its first form and genuinely useful for the gap above.

The case against it is the one raised while planning it, and it is convincing:

- **It loads a lot of nothing onto a minimal product.** Every reader downloads
  the gate. An editor is dead weight for everyone who only ever reads, and the
  gate's claim to be a small bundle anybody can re-host is not decoration — it
  is how the project survives losing a host.
- **It is a third pillar**, and the justification for adding one rests on the
  iOS claim at the top of this document. A zip reader needs no such exception.
- **It becomes the second way to do everything.** Every later feature acquires
  an editor half and a folder half, and they drift.
- **It requires an opinion about writing.** Where a zip accepts whatever any
  tool produced, an editor has to decide what a page is: plain HTML, or a
  structured document, or something between. Each answer is code, and prose mode
  in particular would need a renderer, a block format and a source file shipped
  in the torrent.

The narrow version worth remembering, if the gap above turns out to matter: a
textarea and a filename, no preview of its own, no prose mode, no renderer. If
it ever gets larger than that in the planning, it is the wrong thing.

## Phases

**Z1 — accept a zip.** The picker takes `.zip` beside the folder input, the
reader unpacks it in memory, the entries go to `seed()` unchanged. Same signing
dialog, same `spore.sig`, same sandbox. This alone makes an iPhone sufficient to
publish, and it is where the effort should go first.

**Z2 — say what the gate will refuse.** A site arriving from elsewhere will
often contain a `<script>`, a font from Google, an analytics pixel or a hotlinked
image. Under the CSP these do not fail loudly, they silently never happen, and
the author finds out from a reader or not at all. Report them, with paths.

**It must not rewrite anything** — not to inline the font, not to strip the
script, not to fix a path. The moment the gate edits an author's bytes, what was
published is no longer what was reviewed, and the signature covers something
nobody read.

**Z3 — "edit this site".** When reading a site whose key is the key you are
signed in with, offer to download it back as a zip, so the round trip closes
with the same tools the author already uses. The update machinery exists and
already reaches readers.

Deferred until wanted: the editor of Option B, in its narrow form only.

## What would make this a mistake

- **The zip reader grows.** Zip64, split archives, unusual encodings, then a
  general archive layer. The refusal list above should be treated as the whole
  specification; anything it does not name is refused, and widening it should
  require a case.
- **It turns out nobody has a zip either.** If the realistic path on a phone is
  "an app gave me files, not an archive", this solves a problem no one has. Ask
  before building: how would *you* actually get a site onto a phone?

## Open questions

1. **Is the iOS folder picker really absent?** Everything here rests on it. One
   test on a real iPhone settles it, and it should be run before Z1 starts.
2. **Does the iOS file picker accept a `.zip` from the Files app**, and does
   `accept=".zip,application/zip"` help or hinder it? Some iOS versions have
   been restrictive about extensions; measure rather than assume.
3. **What are the caps?** Total uncompressed size and per-entry size have to be
   numbers. They should come from what a browser can hold and seed without
   dying, which is a measurement, not a preference.
4. **Preview before publishing?** A zip from elsewhere is unreviewed content,
   and publishing is signing. Seeding it locally and opening it in the ordinary
   viewer before announcing would show the author the real thing, through the
   real service worker under the real CSP. Whether that is worth the extra hash
   on a phone is the second thing to measure.
5. **Is the remaining gap real?** Someone with a phone, no tools, and something
   to say. If that person exists in practice, Option B comes back — narrow.
