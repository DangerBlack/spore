/**
 * Publishing: a dropped folder becomes a torrent that this tab seeds.
 *
 * The folder is read in the browser and never uploaded anywhere. What leaves
 * the machine is what peers ask for, over WebRTC, once the magnet is shared.
 * While the tab is open this tab is the swarm; every reader who opens the link
 * becomes another seed for as long as *their* tab is open. Closing the last tab
 * takes the site offline — that is the honest limit of the MVP.
 */

import { chooseEntry } from './site.js'
import { seedTorrent } from './swarm.js'
import { filesFromZip, isZip } from './zip.js'

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
  const name = files[0]?.webkitRelativePath?.split('/')[0] ?? null
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
  if (files.length === 1 && isZip(files[0])) return await filesFromZip(files[0])

  for (const file of files) file.fullPath = file.fullPath || file.name
  return { files, name: null }
}

/**
 * Seed a set of files.
 * @returns {Promise<import('webtorrent').Torrent>}
 */
export async function publish (files, name) {
  checkPublishable(files)
  return await seedTorrent(files, { name: name ?? undefined })
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
  return chooseEntry(files.map(file => (file.fullPath || file.name).replace(/\\/g, '/')))
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
