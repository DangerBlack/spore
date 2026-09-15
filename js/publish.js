/**
 * Publishing: a dropped folder becomes a torrent that this tab seeds.
 *
 * The folder is read in the browser and never uploaded anywhere. What leaves
 * the machine is what peers ask for, over WebRTC, once the magnet is shared.
 * While the tab is open this tab is the swarm; every reader who opens the link
 * becomes another seed for as long as *their* tab is open. Closing the last tab
 * takes the site offline — that is the honest limit of the MVP.
 */

import { asSite, entryFor, pathOf } from './site.js'
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

/**
 * Files chosen through `<input type="file" webkitdirectory>`.
 *
 * Which is not always a folder. `webkitdirectory` degrades to an ordinary file
 * picker where directories cannot be chosen — iOS, the device this whole path
 * exists for — and a person there taps "Choose a folder…" because it is the
 * first button, picks `site.zip`, and used to get a one-file torrent containing
 * an archive and a dialog saying there was no page to open. The drop handler and
 * the other picker both unpack; the button an iOS user is most likely to press
 * was the one that did not.
 */
export async function filesFromInput (input) {
  const files = [...input.files]
  if (!files.some(file => file.webkitRelativePath)) return await fromLooseFiles(files)

  for (const file of files) file.fullPath = file.webkitRelativePath
  // `|| null`, not `??`: where `webkitdirectory` degrades, `webkitRelativePath`
  // is the empty string rather than undefined, and `??` kept it. An empty name
  // then beat the better one `asSite` works out from the page itself.
  return { files, name: files[0]?.webkitRelativePath?.split('/')[0] || null }
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
