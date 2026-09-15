# Publishing without a folder

**Status: S1 and Z1 are implemented. Z2, Z3 and Option B are not.** This was
written to be argued with before any code existed, in the manner of
[mutable-sites.md](mutable-sites.md), and the argument changed it twice — an
editor became a zip, and the zip turned out to be the second thing to build
rather than the first. The open questions at the end are still real; the first
two are answered by one test on a real iPhone, which has not been run.

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

So: some way for a site to arrive that is not a folder. Three were considered,
and they are not equivalent — one of them is mostly already built.

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
    files   ──►  File[] with fullPath  ──┤
    zip     ──►  File[] with fullPath  ──┘

## Option zero: accept a single page

**Do this first. Most of it already exists.**

Before any container format, there is a case the gate already half-supports and
refuses for no good reason. `findEntry` in `site.js` says, in as many words,
that "a torrent of a single page, however it was named, is still a site", and it
works: given one `.html` file under any name, it renders it. But
`checkPublishable` in `publish.js` insists on an `index.html`, so the gate
refuses to publish something it is perfectly happy to read:

    reading   one page, any name   ->  il-mio-post.html   (rendered)
    publishing one page, any name   ->  refused: "A site needs an index.html"

That asymmetry is the whole bug. Removing it means making the publish rule the
same rule the read path already uses, and adding one input without
`webkitdirectory` — which is the plain file picker that *does* work on iOS,
reaching Files, iCloud Drive and every other document provider.

Nothing is renamed and nothing is rewritten. The page keeps the name its author
gave it, in the torrent and in the magnet's `dn=`, because the reader already
knows what to do with it. `spore.pub` and `spore.sig` sit beside it exactly as
they do beside an `index.html`.

It is also the shape most pages actually arrive in. A self-contained page with
its CSS in a `<style>` block is what a person writes for a single post, and it
is what a language model hands back when asked for one.

Selecting several files at once works too, with one limit worth stating plainly:
a file picker yields no relative paths, so everything lands at the root of the
torrent. A flat site — `post.html`, `style.css`, `photo.jpg` — publishes
correctly. A site with `css/style.css` cannot be expressed this way at all, and
that, precisely, is what the zip is for.

Two details to get right rather than assume:

- **The site's root is the torrent's root, and the rules live there.**
  `index.html`, `spore.pub` and `spore.sig` sit directly inside the single
  folder BitTorrent wraps a torrent in, and nowhere else. A file elsewhere
  carrying one of those names is not one of those things.

  What was here before *searched*: the shallowest `index.html` anywhere in the
  tree was the entry, and the site's root was wherever that turned out to be.
  That flexibility was the single largest source of defects in this branch,
  because "which directory is the site?" then had an answer that depended on who
  was asking — and the publisher and the reader asked with different code. A
  signature went into one directory while readers looked in another; a stray
  file at a second top level was signed and then reported missing, so the site
  accused itself of having been altered. Neither can be expressed now.

- **A single page becomes `index.html`.** Somebody who picks `il-mio-post.html`
  on a phone means it to be the site, and the alternative is telling them to
  rename a file with tools they do not have. It renames a path, not any bytes;
  the original name is kept for the magnet, and the publisher is told. Anything
  more ambiguous than one page is published as the list of files it is.

- **`__MACOSX/` is dropped by name.** It is resource forks rather than content,
  and macOS writes it beside anything its Compress command touches. Left in, an
  ordinary Mac archive has two top levels and therefore no `index.html` in its
  root, so the commonest way of making a zip would produce a list of files
  instead of a site. One named exception, for the one piece of rubbish common
  enough to earn it.

- **Republishing has two outcomes and no third.** Either a publication verifies
  exactly as it arrived — in which case it goes out untouched, still its
  author's, and hashes to precisely what it hashed before, so the mirror *is*
  the original — or its key and its signature are thrown away and the publisher
  signs their own. Everything in between was an attempt to be helpful, and every
  one of them produced a site that told its readers it had been tampered with.
  "Did it verify?" is answered by the reader's own functions, which is the whole
  point: one question, one implementation.

- **A file list cannot be signed, and is not offered the chance.** A reader's
  check reads `spore.pub` and `spore.sig` from beside the entry page, and a
  listing has no entry page, so the gate shows one as "unsigned" whatever it
  contains. Asking for a passphrase would take a real key, write a real
  signature and produce a site that reads as unsigned to everyone including its
  author. The dialog says so instead. Revisit only by defining what verifying a
  listing means, which is a change to the verification story rather than to this.
- **The publish rule is the read rule**, not a copy of it. `chooseEntry` is one
  function called from both sides; anything else diverges the first time one of
  them is touched. If it would not — two
  pages and no index — say so before the signing dialog, listing what was
  picked, and let the author go back or publish it as the file list it is. A
  question, not a refusal: the gate renders such a torrent perfectly well.
- **The torrent's name.** A folder gives one; a handful of loose files does not.
  What appears in `dn=`, and therefore in every shared link, needs deciding
  rather than inheriting whatever the client picks.

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
- **Decompression bombs.** A ratio, refused from the index before anything is
  inflated, because a ratio is what a bomb is. Sizes are not capped: an archive
  is never held whole, and a stored entry is handed to the swarm as a slice of
  the file on disk, so a film costs nothing to publish.
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

**S1 — a single page, and flat sets of files. Done.** Make the publish rule the read
rule, add a picker without `webkitdirectory`. Almost nothing to write, and it
covers the commonest thing anyone publishes. It is also the smallest possible
test of whether the iOS wall is really where this document claims it is.

**Z1 — accept a zip. Done.** For everything with a subdirectory in it, which a file
picker can never express. The reader unpacks in memory and the entries go to
`seed()` unchanged.

**Z2 — say what the gate will refuse.** Not built. A site arriving from elsewhere will
often contain a `<script>`, a font from Google, an analytics pixel or a
hotlinked image. Under the CSP these do not fail loudly, they silently never
happen, and the author finds out from a reader or not at all. Report them, with
paths.

**It must not rewrite anything** — not to inline the font, not to strip the
script, not to fix a path. The moment the gate edits an author's bytes, what was
published is no longer what was reviewed, and the signature covers something
nobody read.

**Z3 — "edit this site".** Not built. When reading a site whose key is the key you are
signed in with, offer it back as a zip, so the round trip closes with the tools
the author already uses. The update machinery exists and already reaches
readers.

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
3. **What are the caps?** Partly answered, and the first answer was wrong. There
   is no limit on how large a published site may be, and there must not be: this
   is a BitTorrent client and people will put films in it. The byte ceilings
   that were here were covering an implementation — a reader that held the whole
   archive and every entry in memory — rather than protecting anybody, and the
   folder and picker paths never had one. A stored entry is handed to the swarm
   as a slice of the file on disk and never becomes memory, so only what
   actually inflates is counted. What remains a guess is *that* number, and the
   bomb ratio beside it.
4. **Preview before publishing?** A zip from elsewhere is unreviewed content,
   and publishing is signing. Seeding it locally and opening it in the ordinary
   viewer before announcing would show the author the real thing, through the
   real service worker under the real CSP. Whether that is worth the extra hash
   on a phone is the second thing to measure.
5. ~~**What goes in `dn=` for a set of loose files?**~~ Answered, and it was
   sharper than it looked: a `name` passed for a *single* file becomes the file,
   extension and all, so naming a one-page torrent turns `index.html` into
   `index` and the site opens as a one-item file list. Nothing is passed for one
   file; loose files take the entry page's name, since leaving it to WebTorrent
   produced `post.html/post.html`.
6. **Is the remaining gap real?** Someone with a phone, no tools, and something
   to say. If that person exists in practice, Option B comes back — narrow.
