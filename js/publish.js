/**
 * Publishing: a dropped folder becomes a torrent that this tab seeds.
 *
 * The folder is read in the browser and never uploaded anywhere. What leaves
 * the machine is what peers ask for, over WebRTC, once the magnet is shared.
 * While the tab is open this tab is the swarm; every reader who opens the link
 * becomes another seed for as long as *their* tab is open. Closing the last tab
 * takes the site offline — that is the honest limit of the MVP.
 */

import { seedTorrent } from './swarm.js'

/**
 * Pull a full file tree out of a drop.
 *
 * `webkitGetAsEntry` is the only way to see inside a dropped directory. Each
 * file is tagged with its `fullPath`, which is what create-torrent reads to lay
 * out the torrent — it strips the shared root folder itself, so `index.html`
 * lands at the top of the torrent exactly as it sat in the folder.
 *
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<{ files: File[], name: string|null }>}
 */
export async function filesFromDrop (dataTransfer) {
  const entries = [...dataTransfer.items]
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.())
    .filter(Boolean)

  if (entries.length === 0) {
    // No directory API (or a plain file list): take what we can get.
    return await fromLooseFiles([...dataTransfer.files])
  }

  const files = []
  for (const entry of entries) await collect(entry, files)

  const roots = entries.filter(entry => entry.isDirectory)
  if (roots.length > 0) {
    return { files, name: roots.length === 1 ? roots[0].name : null }
  }
  // Files rather than folders were dropped, so an archive among them is an
  // archive, exactly as it would be if it had come through the picker.
  return await fromLooseFiles(files)
}

/** Files chosen through `<input type="file" webkitdirectory>`. */
export function filesFromInput (input) {
  const files = [...input.files]
  for (const file of files) {
    if (file.webkitRelativePath) file.fullPath = file.webkitRelativePath
  }
  // `|| null`, not `??`: where `webkitdirectory` degrades to picking single
  // files — iOS, the device this exists for — `webkitRelativePath` is the empty
  // string rather than undefined, and `??` kept it. An empty name then beat the
  // better one `asSite` works out from the page itself.
  const name = files[0]?.webkitRelativePath?.split('/')[0] || null
  return { files, name }
}

/**
 * Files chosen through an ordinary `<input type="file" multiple>`.
 *
 * This is the picker that exists everywhere, including on the devices with no
 * directory picker at all, which is the entire reason it is here.
 *
 * A single archive is unpacked and becomes the site. Anything else is taken at
 * face value: a file picker reports no relative path, so every file lands at
 * the root of the torrent. That publishes a flat site correctly and cannot
 * express `css/style.css` at all — which is what the archive is for, and what
 * the caller should say rather than leave anyone to discover.
 */
export async function filesFromPicker (files) {
  return await fromLooseFiles([...files])
}

async function fromLooseFiles (files) {
  if (files.length === 1 && looksLikeZip(files[0])) {
    // Imported here and nowhere else. Every reader downloads the gate, and most
    // of them never publish anything; the archive reader is dead weight until
    // somebody actually hands one over. The test above is inline for the same
    // reason — importing a module to ask whether to import it defeats the point.
    const { filesFromZip } = await import('./zip.js')
    return await filesFromZip(files[0])
  }

  for (const file of files) file.fullPath = file.fullPath || file.name
  return { files, name: null }
}

function looksLikeZip (file) {
  return /\.zip$/i.test(file.name || '') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
}

/**
 * Seed a set of files.
 *
 * The name needs care, because it is not decoration: it is the torrent's only
 * human-readable label, it travels in every shared link as `dn=`, and for more
 * than one file it becomes the folder they sit in.
 *
 * For a *single* file it becomes the file, extension and all. Naming a
 * one-page torrent `my-site` renames `index.html` to `my-site`, `findEntry`
 * then sees no page at all, and the site opens as a one-item file list. That
 * was already true of a folder containing nothing but an `index.html`, and it
 * is why nothing is passed here when there is one file: WebTorrent names such a
 * torrent after the file, which is both correct and what the reader wants.
 *
 * @returns {Promise<import('webtorrent').Torrent>}
 */
export async function publish (files, name) {
  checkPublishable(files)
  // `filterJunkFiles: false` because `dropJunk` has already done it, and two
  // filters that disagree by one file produce a site that accuses itself.
  if (files.length === 1) return await seedTorrent(files, { filterJunkFiles: false })

  return await seedTorrent(files, { name: name ?? nameFor(files), filterJunkFiles: false })
}

/**
 * A label for files that arrived without one.
 *
 * A picker reports no folder, so loose files have no name to inherit, and
 * leaving it to WebTorrent names the torrent after whichever file came first —
 * `post.html/post.html`, which is not wrong so much as embarrassing.
 *
 * It is a poor title and worth saying so: by the time this is reached the entry
 * is `index.html`, so files picked with an `index.html` already among them get
 * a torrent called `index`. `asSite` supplies a better one whenever it renamed
 * something, which is the case where a person actually chose a name.
 */
function nameFor (files) {
  const entry = entryFor(files)
  const from = entry ?? pathOf(files[0])
  return from.slice(from.lastIndexOf('/') + 1).replace(/\.html?$/i, '') || 'site'
}

/**
 * Refuse the one thing that cannot be published: nothing.
 *
 * Separate from `publish` because the gate asks the publisher a question —
 * whether to sign this — between choosing files and seeding them, and being
 * asked to sign something that was never publishable is a poor way to find out
 * it was empty.
 *
 * The only thing refused here is nothing at all. A missing `index.html` used to
 * be refused too, which was wrong in both directions: it blocked a lone page
 * under another name, which the gate renders perfectly well, and it framed a
 * folder with no entry page as an error when the gate shows one as a browsable
 * list of files. That is a thing worth telling an author before they sign it,
 * not a thing worth forbidding — see `entryFor`.
 *
 * @throws {Error} with a message meant to be read by whoever chose the files
 */
export function checkPublishable (files) {
  if (files.length === 0) throw new Error('There are no files to publish.')

  // Two files at one path is not a layout question, it is a signature question:
  // `spore.sig` would list the path twice with two different hashes, a verifier
  // would check the first and the worker could serve the second, and the site
  // would read as verified while showing bytes nobody checked. A zip is allowed
  // to contain this and the picker can be talked into it, so it is refused here
  // — where every way in passes — rather than in any one of them.
  const seen = new Set()
  for (const file of files) {
    const path = pathOf(file)
    if (seen.has(path)) throw new Error(`There are two files called ${path}.`)
    seen.add(path)
  }
}

/**
 * What a reader will land on, or `null` if they will land on a file list.
 *
 * Asked with the same function the viewer uses, so the answer given to an
 * author at publishing time is the answer their readers get.
 *
 * @param {File[]} files
 * @returns {string|null}
 */
export function entryFor (files) {
  // Anchored at this set's own root, not at "one folder deep". The reader's
  // rule tolerates exactly one leading folder because BitTorrent always adds
  // exactly one; applied to paths *before* seeding, that same tolerance accepts
  // a folder that is not the torrent's. Drop two folders at once and the
  // publisher saw an entry at `sito/index.html` while the reader, handed
  // `index/sito/index.html`, saw a list of files — the publisher signing
  // something nobody would ever check. The two questions have to be the same
  // question, and this is the half that is asked before the torrent exists.
  const root = siteRoot(files)
  return files.map(pathOf).find(path => ENTRY_IN_ROOT(root).test(path)) ?? null
}

const ENTRY_IN_ROOT = root =>
  new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}index\\.html?$`, 'i')

/** One spelling of a file's path, used by everything that compares them. */
export function pathOf (file) {
  return (file.fullPath || file.name).replace(/\\/g, '/')
}

/**
 * Files an operating system left behind, which are not part of anybody's site.
 *
 * This list is `create-torrent`'s, copied deliberately rather than imported,
 * and the torrent is built with its own filtering turned **off** so that this
 * is the only place it happens. That matters more than it sounds: the library
 * used to drop these silently *after* `spore.sig` had already hashed them, so
 * the manifest described a file the torrent did not contain and every reader —
 * including the author — was told the site had been altered. A `.DS_Store` sits
 * in essentially every folder the Finder has ever opened.
 *
 * Two filters that are nearly the same are worse than either one alone: too
 * broad and the torrent carries a file the signature never covered, too narrow
 * and the signature covers a file the torrent never carried. Both read as
 * tampering. So there is one, it is here, and `seedTorrent` is told not to have
 * an opinion.
 */
const JUNK = new RegExp([
  '^npm-debug\\.log$', '^\\..*\\.swp$',
  '^\\.DS_Store$', '^\\.AppleDouble$', '^\\.LSOverride$', '^Icon\\r$', '^\\._.*',
  '^\\.Spotlight-V100(?:$|\\/)', '\\.Trashes', '^__MACOSX$',
  '~$', '^Thumbs\\.db$', '^ehthumbs\\.db$', '^[Dd]esktop\\.ini$', '@eaDir$'
].join('|'))

/** @param {File[]} files @returns {{files: File[], dropped: string[]}} */
export function dropJunk (files) {
  const junk = file => {
    const name = pathOf(file).split('/').pop()
    // Both halves, exactly as create-torrent has it: a leading dot *and* a
    // match. `Thumbs.db` is in the list and is not dropped, because it has no
    // leading dot; matching only one half would put the two filters at odds.
    return name.startsWith('.') && JUNK.test(name)
  }
  return {
    files: files.filter(file => !junk(file)),
    dropped: files.filter(junk).map(pathOf)
  }
}

/**
 * A set of files as the site it is meant to be.
 *
 * One rule, and only one: the entry page is `index.html` in the site's root.
 * When there is no `index.html` there but exactly one page, that page *becomes*
 * `index.html` — because a person who picks `il-mio-post.html` on a phone means
 * it to be the site, and the alternative is telling them to rename a file with
 * tools they do not have.
 *
 * This renames a path and nothing else: the bytes are the author's bytes and
 * the File is the same File. The original name is returned for the magnet,
 * though it only survives when the site has more than one file in it — a lone
 * unsigned page is a single-file torrent, and naming one of those renames the
 * file back, which is the thing this was avoiding. Sign it and it gains
 * `spore.pub` and `spore.sig`, so the name lands. Anything more ambiguous than
 * "one page" is left exactly as it is and published as a list of files.
 *
 * @param {File[]} files
 * @returns {{files: File[], renamed: {from: string, to: string}|null, name: string|null}}
 */
export function asSite (files) {
  // One file is the site, wherever it was sitting. Less a choice than an
  // acknowledgement: a single-file torrent has no folder, so create-torrent
  // names it after the file and discards the directories it came from. Leaving
  // the path on had the publisher deciding `sito/docs/index.html` was a list of
  // files, while every reader, handed `index.html`, opened it as the site.
  if (files.length === 1 && pathOf(files[0]).includes('/')) {
    files = [flatten(files[0])]
  }

  if (entryFor(files)) return { files, renamed: null, name: null }

  const prefix = sharedTop(files.map(pathOf))
  const pages = files.filter(file => {
    const rest = pathOf(file).slice(prefix.length)
    return !rest.includes('/') && /\.html?$/i.test(rest)
  })
  if (pages.length !== 1) return { files, renamed: null, name: null }

  const from = pathOf(pages[0])
  const to = `${prefix}index.html`

  // A new File over the same Blob: the contents are referenced, not copied, so
  // renaming a film-sized page costs nothing.
  const renamedFile = new File([pages[0]], 'index.html',
    { type: pages[0].type, lastModified: pages[0].lastModified })
  renamedFile.fullPath = to

  return {
    files: files.map(file => (file === pages[0] ? renamedFile : file)),
    renamed: { from, to },
    name: from.slice(from.lastIndexOf('/') + 1).replace(/\.html?$/i, '') || null
  }
}

/**
 * The site's root: the one folder every file sits in, or the top of the set.
 *
 * Exported because signing needs the same answer, and the last time these were
 * two separate calculations a correctly signed site read as unsigned.
 */
export function siteRoot (files) {
  return sharedTop(files.map(pathOf))
}

/** The same File under its bare name, its contents referenced rather than copied. */
function flatten (file) {
  const name = pathOf(file).split('/').pop()
  const out = new File([file], name, { type: file.type, lastModified: file.lastModified })
  out.fullPath = name
  return out
}

function sharedTop (paths) {
  const cut = paths[0]?.indexOf('/') ?? -1
  if (cut < 1) return ''

  const top = paths[0].slice(0, cut + 1)
  return paths.every(path => path.startsWith(top)) ? top : ''
}

async function collect (entry, out, prefix = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
    file.fullPath = prefix + entry.name
    out.push(file)
    return
  }
  for (const child of await readDirectory(entry)) {
    await collect(child, out, `${prefix}${entry.name}/`)
  }
}

/** `readEntries` returns a page at a time and signals the end with an empty batch. */
function readDirectory (entry) {
  const reader = entry.createReader()
  const entries = []

  const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject))

  return (async () => {
    for (;;) {
      const batch = await readBatch()
      if (batch.length === 0) return entries
      entries.push(...batch)
    }
  })()
}
