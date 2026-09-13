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

Three options were considered.

**Markdown.** Familiar, and wrong here. A parser is our code, forever, with no
dependency to lean on — CLAUDE.md says dependencies stay at a minimum, which
means we would write and maintain it. Worse, a Markdown parser's job is to turn
text into HTML, which makes it precisely the sort of component where a missed
escape becomes an injection. Not worth it for emphasis and links.

**A rich-text editor over `contenteditable`.** Largest surface, most
browser-specific bugs, worst behaviour on phones. No.

**A structured document.** Proposed. The page is an ordered list of blocks:

    { title, blocks: [ {type: 'text', text}, {type: 'heading', text},
                       {type: 'quote', text}, {type: 'image', src, alt},
                       {type: 'code', text}, {type: 'rule'} ] }

Rendering is a loop with escaping, not a parser. The author's text is escaped
first and interpreted second, so there is no input that becomes markup by
accident. Inside a paragraph a deliberately tiny inline set is applied *to the
already-escaped text* — `*bold*`, `_italic_`, `[label](relative-or-absolute
url)` — which is roughly forty lines and cannot inject by construction, because
by the time those rules run there are no live angle brackets left to produce.

Links get the same treatment every other site gets: external ones are blocked by
the CSP at read time, whether the author understood that or not. The editor
should say so when one is typed, rather than let it fail silently in the reader's
browser.

## Preview must not be a second renderer

The temptation is `srcdoc`, or a blob URL, or just injecting into a div. Each
would produce a preview governed by different rules than the published page:
different origin, different CSP, different service worker. An author would tune a
page against a preview that lies, and find out from a reader.

**Proposal: the preview is the real thing.** Previewing seeds the files into a
local torrent and opens it in the ordinary viewer, through the service worker,
in the sandboxed iframe, under the gate's CSP. What the author sees is what the
next person gets, including the parts that break. "Publish" then only announces
what already exists.

Cost, honestly: hashing a torrent per preview, so it is an explicit button and
not a live pane, and a stack of throwaway torrents to destroy. Whether that cost
is acceptable on a phone is an open question below, and the first thing to
measure.

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
draft is on the laptop. Parsing the published HTML back into blocks would be
lossy and fragile.

**Proposal: the source travels with the site.** The document JSON ships in the
torrent as one more file. It is covered by `spore.sig` like everything else, it
is a fraction of the size of the HTML it generates, and it means anyone holding
the key can open the site in the editor from any device, change a line, and
republish as a signed successor. It also makes the page honestly
view-source-able, which suits the rest of the project.

The cost is that the site carries roughly its own text twice. For a page of
prose that is nothing. For a site with large embedded content it might not be,
so it should be omissible.

## Phases

**E1 — one page, text only.** Title and text blocks, drafts, preview, publish
through the existing path. This is the whole idea, testable end to end. If it is
not useful at this size, the later phases will not rescue it.

**E2 — images.** The picker, the downscale offer, the weight indicator. This is
what turns it from a note into a page worth sharing, and it is the phase that
only exists because iOS allows a file picker even where it forbids a folder one.

**E3 — "edit this page".** When you are reading a site whose key is the key you
are signed in with, offer to edit it: read the source file back out of the
torrent, open it, republish as a signed successor. The update machinery already
exists and already reaches readers. This is the phase that makes a phone a
sufficient tool for running a site, with nothing else involved.

Multi-page sites, navigation, drafts synced between devices: out of scope, and
should stay out until someone has actually wanted one.

## What would make this a mistake

Worth writing down while it is still cheap to abandon.

- **It becomes the second way to do everything.** Every feature acquires an
  editor half and a folder half, and they drift. Mitigated only by the one
  architectural commitment above, which is why it is stated as a commitment and
  not a preference.
- **The renderer grows.** Tables, then footnotes, then embeds. The block list
  above should be treated as closed, and reopening it should require an argument.
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
3. **Does the source file belong in the torrent by default, or on request?**
   Default makes E3 work everywhere and costs a little size; on-request is
   smaller and leaves authors stranded on the wrong device.
4. **What is the source file called, and does a reader need to be told what it
   is?** It will appear in the file listing beside `spore.pub` and `spore.sig`.
5. **Does an unsigned editor page make sense?** Signing is optional for folders.
   An editor page is by definition written by the person at the keyboard, so
   defaulting to signed may be right — but it would be the first place Spore
   nudges rather than asks.
