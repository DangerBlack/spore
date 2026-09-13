# Writing a page inside the gate

**Status: draft. Nothing in this document is implemented.** It exists to be
argued with before any code is written, in the manner of
[mutable-sites.md](mutable-sites.md). The open questions at the end are real.

## The problem

Spore can publish a folder. It cannot publish a *thought*.

To put a page into the swarm today you must already have a folder on a disk,
with an `index.html` in it, laid out with relative paths. That is a reasonable
demand of a developer at a desk and an unreasonable one of everybody else, and
on a phone it is not a demand at all — it is a wall:

> **To confirm on a real device before this is built.** iOS Safari (and every
> other iOS browser, since they are all WebKit) appears to offer no directory
> picker at all: `<input webkitdirectory>` falls back to picking single files,
> and there is no drag-and-drop of a folder. If that holds, publishing from an
> iPhone is not inconvenient, it is impossible, and no amount of layout work on
> the "Choose a folder…" button changes it.

That is the sharp edge of a blunter problem. The project's second MVP goal is
"publish a site from the page". Right now the page is only the last ten metres
of a journey that starts in a text editor.

## What this is not

**It does not replace the folder button.** Dropping a folder stays the primary
path and keeps working exactly as it does: it is faster than any editor for
anything that already exists, it is the only way to publish a site somebody else
built, and it is the only path that imposes nothing at all on the author's
choice of tools. The editor is a *third* entry alongside "open a magnet" and
"drop a folder", never a replacement for either.

**It is not a CMS, a site builder or a theme system.** One author, writing one
page, on the device in their hand.

## The one architectural commitment

**The editor is a source of files. Nothing else.**

`seed(files, name)` in `app.js` already takes an array of `File` objects tagged
with `fullPath`, asks about signing, adds `spore.pub`, writes `spore.sig`, seeds
the torrent and announces a successor. The editor's entire job is to produce
that array. It gets the same dialog, the same signature, the same sandbox, the
same CSP, the same everything.

This is the difference between a feature and a fork. A second publishing path
would be a second place for the security model to be subtly wrong, and the
security model is the project. If a change to the editor requires a change to
how publishing works, the change is wrong.

    editor  ──►  File[] with fullPath  ──►  seed()  ──►  (unchanged)
    folder  ──►  File[] with fullPath  ──┘

## What the author writes

An early draft of this document proposed a structured block editor and argued
against accepting HTML, on the grounds that turning author text into markup is
where a missed escape becomes an injection.

That argument is sound and was applied too widely. It holds for a renderer that
interprets text the author expected to stay text. It does not hold for HTML the
author wrote deliberately: someone writing their own page already has full
authority over it, so there is nothing to inject into. And the reader is not
protected by us sanitising the author — the reader is protected by the sandbox,
the CSP and `script-src 'none'`, which are exactly the same for pasted HTML as
for the HTML inside a dropped folder. The threat model does not change.

So there are two modes, and the plain one comes first.

### HTML mode

A textarea holding the literal bytes of `index.html`. What is typed is what is
in the torrent, byte for byte. No parser, no renderer, no transformation — the
smallest possible amount of our code between an author and the swarm:

    new File([textarea.value], 'index.html')  ──►  seed()

This is the mode that answers the obvious question: *what if I want to write
HTML, or have something else write it for me?* A page generated elsewhere —
by hand, by a static site generator, by a language model — is pasted in and
published. On a phone, where there is no folder to drop, pasting is the only
way that content arrives at all, and it would be strange to accept every folder
on a laptop and refuse the same bytes on a phone.

More than one file, when needed: each is a name and a body, so `style.css`
beside `index.html` costs nothing new. Binary files come from the image picker
below, not from a textarea.

### Prose mode

For writing rather than pasting: a title and an ordered list of blocks
(paragraph, heading, quote, image, code, rule), rendered by a loop with
escaping. Author text is escaped first and interpreted second, so there is no
input that becomes markup by accident, and a deliberately tiny inline set —
`*bold*`, `_italic_`, `[label](url)` — is applied to the already-escaped text,
where it cannot inject because there are no live angle brackets left to produce.

This is a convenience for writing a post with a thumb. It is *not* a
prerequisite for publishing from a phone, which is why it moved to the last
phase: HTML mode alone removes the wall.

## Telling the author what will break, without touching their bytes

A page arriving from outside will often contain things this gate refuses: a
`<script>`, a font from Google, an analytics pixel, an image hotlinked from
another site. Under the CSP those do not fail loudly, they simply never happen,
and the author finds out from a reader — or does not find out at all.

The editor should read the HTML and say so: *three requests to other sites will
be blocked; one script will not run; these will not fail with an error, they
will silently do nothing.* Listed, with line numbers where possible.

**It must not rewrite anything.** Not to inline the font, not to strip the
script, not to helpfully fix a path. The author's bytes are the author's bytes;
the moment the editor edits them on the author's behalf, what was published is
no longer what was reviewed, and the signature covers something nobody read.
Warn, and publish exactly what was typed.

## Images

`<input type="file" accept="image/*">` works on iOS — camera roll and camera
both — which is what makes an editor viable there at all. Chosen images become
real files in the torrent under `assets/`, not data URIs: a data URI would be
re-encoded into the HTML at 4/3 the size, would break sharing between pages, and
would defeat the piece-level verification that makes a torrent worth using.

A modern phone photo is several megabytes, and every reader of the site pays for
it twice, in transfer and in the storage a kept site occupies. The editor should
offer to downscale (canvas, longest edge ~1600px) and should state the page's
total weight as it grows, because the author is the only person in a position to
care and currently has no way to know.

## Drafts, and editing from a device that never saw the draft

Drafts live in IndexedDB via the existing `idb.js`. That covers "close the tab,
come back tomorrow" and nothing else.

The harder case is the one that makes this worth building: you published from a
laptop, you are on a train with a phone, and you want to fix a sentence. The
draft is on the laptop.

In HTML mode this problem does not exist. The source *is* `index.html`, it is
already in the torrent, and "edit this page" means reading it back out into the
textarea. Nothing extra to ship, nothing to keep in sync, and the round trip is
exact.

It exists only in prose mode, where the blocks are not recoverable from the
generated HTML. There the document JSON would have to travel in the torrent as
one more file, covered by `spore.sig` like everything else — which is a real
cost (the site carries its own text twice) attached to a mode that is a
convenience. Another reason for prose mode to come last: it is the only part
that asks the format to grow.

## Phases

**E1 — HTML mode.** A textarea, a filename, preview, publish through the
existing path. Almost no code of our own: the value of this phase is entirely in
what it removes, which is the requirement to have a folder on a disk. It alone
makes an iPhone sufficient to publish, and it alone covers the page written
somewhere else and pasted in. If only one phase is ever built, this is the one.

**E2 — images, and the lint.** The file picker (`accept="image/*"` works on
iOS, camera roll and camera), the downscale offer, the page weight, and the
report of what the CSP will refuse. This is what turns a pasted page into one
that actually renders the way its author expected.

**E3 — "edit this page".** When you are reading a site whose key is the key you
are signed in with, offer to edit it: read `index.html` back out of the torrent,
open it, republish as a signed successor. The update machinery already exists
and already reaches readers. This is the phase that makes a phone a sufficient
tool for running a site, with nothing else involved.

**E4 — prose mode.** Writing rather than pasting. Genuinely optional, and worth
building only if someone wants to write a post on a phone rather than publish
one. Everything it needs that HTML mode does not — a renderer, a block format, a
source file in the torrent — is a reason to defer it until that want is real.

Multi-page sites, navigation, drafts synced between devices: out of scope, and
should stay out until someone has actually wanted one.

## What would make this a mistake

Worth writing down while it is still cheap to abandon.

- **It becomes the second way to do everything.** Every feature acquires an
  editor half and a folder half, and they drift. Mitigated only by the one
  architectural commitment above, which is why it is stated as a commitment and
  not a preference.
- **The editor starts improving the author's HTML.** Inlining a font, stripping
  a script, fixing a path: each is helpful once and corrosive as a rule, because
  what was published stops being what was reviewed and the signature ends up
  covering bytes nobody read. Warn, never rewrite.
- **Prose mode's renderer grows.** Tables, then footnotes, then embeds. The
  block list should be treated as closed, and reopening it should require an
  argument — which is the cheapest reason to not build E4 until it is wanted.
- **It is the third pillar.** CLAUDE.md says the MVP does two things and that
  anything else is Phase 2+ and must not be built "even if it is easy". This is
  a deliberate exception, justified on the grounds that goal 2 ("publish a site
  from the page") is currently unreachable on an entire class of device. That
  justification depends on the iOS claim at the top of this document being true.
  If it is not, this becomes a convenience, and a convenience does not earn a
  third pillar.

## Open questions

1. **Is the iOS folder picker really absent?** Everything above rests on it. One
   test on a real iPhone settles it, and it should be run before E1 starts.
2. **How slow is preview-by-seeding on a phone?** If hashing a page with three
   photos takes ten seconds on an older device, the preview story needs
   rethinking — and the alternatives all involve a second renderer, which is the
   thing this design refuses. Measure before committing.
3. **Does an unsigned editor page make sense?** Signing is optional for folders.
   A page written here is by definition written by the person at the keyboard,
   so defaulting to signed may be right — but it would be the first place Spore
   nudges rather than asks.
4. **Does HTML mode need a starting template?** An empty textarea on a phone is
   a poor invitation, and a filled one is an opinion about what a page should
   look like. A skeleton with a title and one paragraph is probably the least
   opinionated useful thing.
5. **How much of a page can a textarea hold before it becomes unusable on a
   phone?** A generated page can be tens of kilobytes. Pasting it is fine;
   scrolling through it to change one line may not be, and that is E3's real
   usability question rather than E1's.
