# Checking a signature file by file

**Status: draft. Nothing in this document is implemented.** It is the next
step after "a large site is fetched as it is read" (`WHOLE_SITE_BYTES`), written
down so it can be built in a PR of its own.

## Where things stand

`spore.sig` is a signed manifest: a list of the site's files, each with its
SHA-256. Checking a site today is all or nothing (`verifyContent` in
`js/app.js`):

1. the signature over the manifest is checked;
2. the torrent's file list is compared with the manifest (nothing unlisted,
   nothing missing);
3. every file is hashed and compared with its entry.

Step 3 needs every file, so it means downloading the whole site. A site up to
`WHOLE_SITE_BYTES` is downloaded whole anyway, so it is checked in full at no
extra cost. A larger site is fetched only as it is read. Checking it would pull
all of it down in the background, so it is not checked unasked: it reads as
**unverified**, with the reason, until the reader has all of it (by keeping
it, for instance, which re-runs the check).

That is honest, but coarse. The reader of a large signed site sees
"unverified" even though most of the check could be done for free.

## The idea

The three steps cost very different amounts:

| Step | Cost | When it can run |
|---|---|---|
| 1. The signature over the manifest is valid | nothing: the manifest is a few KB | at once |
| 2. The torrent's files are exactly the manifest's | nothing: the torrent's file list is in its metadata | at once |
| 3. A file matches its hash | downloading that file | when the file has arrived anyway, because it was read |

So steps 1 and 2 run at once for every site, and step 3 runs **per file, as
each one completes**. A large signed site then reads as, for instance,
"✓ signed by X · 12 of 3,400 files checked", and the count grows as the reader
reads. A small site reaches "all files checked" straight away, as it does
today.

## What each state means

For the site as a whole:

- **verified**: steps 1 and 2 passed and every file has been checked.
- **verified so far** (new): steps 1 and 2 passed, every file that has arrived
  matches, and some files have not arrived yet. It means that everything the
  reader has seen is exactly what the key signed, and nothing was added to or
  removed from the site. It says nothing about the files not yet fetched, which
  the reader has not seen either.
- **broken**: any step failed, including one file that arrived and did not
  match. That is final, as it is today. One altered file is enough.
- **unverified**: the manifest cannot be checked at all (no Ed25519 in this
  browser, for instance), as today.

For each file, shown in the list:

- **checked** ✓: arrived whole and matches its entry.
- **not fetched** ·: not needed yet.
- **arriving** …: partly here (a video being streamed). A partial file cannot
  be compared with a whole-file hash, so it waits. BitTorrent still checks each
  of its pieces against the infohash, so it cannot be altered unnoticed. It is
  just not yet tied to the key.
- **altered** ✗: arrived and does not match. The site is **broken**.

## Interface

- **The chip** keeps its place and its marks: ✓ verified, ✓ with a count for
  verified so far, ✗ broken. Its title gives the count in words.
- **Clicking it** opens the author dialog as today. A new section lists the
  files with their state. It has to stay usable with thousands of files, so it
  shows counts per state first ("12 checked · 3,388 not fetched"), with a filter,
  and a list that is filtered, not one enormous list.
- A file that turns out **altered** changes the chip at once, whatever page
  the reader is on.

## Implementation notes

- **When a file is "complete".** Hash a file once all its pieces are verified.
  WebTorrent's per-file progress (`file.done`, `file.progress`) exists. Which
  event to listen to without polling is to be settled: watching the torrent's
  `verified` piece events and mapping pieces to files is the likely answer.
- **Hashing** reuses the streamed SHA-256 already in `checkFile`, one file at
  a time and never on the page's critical path. A file already hashed is never
  hashed twice.
- **State** lives beside `authorship.verified`: a map from path to state, plus
  the counts. The chip reads the counts, and the dialog reads the map.
- **Keeping** a site fetches all of it, so it ends at verified or broken with
  no special case, which is the re-check `keep` triggers today.
- **Steps 1 and 2 need no download** and run for every signed site, large or
  small, before anything else — including a large site that is not complete,
  so a file added to it or taken out of it shows as broken at once. This change
  only stops step 3 from being all or nothing.
- **`WHOLE_SITE_BYTES` stays** as the size up to which a site is downloaded
  whole. It stops being the size up to which a signature is checked, because
  every size is then checked as far as it has been read.

## Tests to write

Each one must be seen to fail with its part removed:

- A large signed site, opened and partly read, reads as verified so far, with
  the right count. Nothing beyond what was read is fetched.
- Reading one more page raises the count by the files that page brought.
- One altered file among the files read turns the site broken at once.
- A file added to or removed from the torrent is caught before any file is
  fetched (steps 1 and 2 alone).
- A file being streamed stays "arriving", not "checked", until it is whole.
- The file list stays responsive with a few thousand entries.
- Keeping the site ends at verified.

## Open questions

- Whether "verified so far" should be worded differently for a site whose
  unread part is most of it. For a 3,400-file wiki with 12 files read, "so far"
  is accurate. But does it read as more reassuring than it is?
- Whether a per-file check should also run for files the gate reads for its
  own reasons (`spore.pub` and `spore.sig` are read and checked already).
