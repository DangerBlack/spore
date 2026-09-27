/**
 * Keeping a site offline.
 *
 * By default Spore writes nothing to disk: a site you read lives in memory and
 * is gone when the tab closes. "Keep offline" is the reader deliberately
 * changing that for one site, so it opens instantly next time and is seeded
 * from the moment Spore starts, without needing a peer to be alive first.
 *
 * It is opt-in, per infohash, and it is not free — see `KEEP_WARNING` below and
 * the section in SECURITY.md. The two costs are real and worth stating plainly
 * rather than burying: the site's contents are written to this device, and you
 * announce that you hold it every time you open Spore, not only while reading.
 *
 * What is *not* claimed: that a kept site is there forever. Browsers evict
 * storage under pressure. `requestPersistence()` asks them not to; they may
 * refuse, and they may change their mind.
 */

import { KEEP_IN_MEMORY_BYTES } from './config.js'
import { IdbChunkStore, deleteSite, getSite, listSites, putChunks, putSite, requestPersistence, usage } from './idb.js'

/** Pieces per IndexedDB transaction: enough to be quick, small enough to not stall. */
const BATCH = 32

export const KEEP_WARNING = `Keep this site on this device?

Spore normally writes nothing to disk. Keeping a site changes that for this one
site, and there are two things to know:

  • Its contents are stored on this device. Anyone who can use this browser
    profile can see what you have kept.

  • You will seed it every time you open Spore, not only while you are reading
    it. That announces to trackers and to other peers that this device holds
    this site — repeatedly, over time, not just once.

You are also then hosting whatever is in it. Keep only what you would be
comfortable serving to strangers.

You can undo this at any time with "Forget", which deletes every byte.`

/**
 * @returns {Promise<boolean>}
 *
 * Never throws. This is on the path that renders a site, and a browser with
 * storage switched off must still be able to read one — "not kept" is both the
 * safe answer and the true one when nothing can be stored.
 */
export async function isKept (infoHash) {
  try {
    return !!(await getSite(infoHash))
  } catch {
    return false
  }
}

/** @returns {Promise<import('./idb.js').SiteRecord[]>} newest first */
export function keptSites () {
  return listSites()
}

/**
 * Copy a torrent into IndexedDB, and record enough metadata to bring it back
 * with no peer to ask.
 *
 * The torrent need not be complete: a site fetched as it is read is fetched
 * whole first (see fetchWhole), and only then stored. Ask whyNotKeep before
 * calling this for one that is not.
 *
 * @param {import('webtorrent').Torrent} torrent  complete, or completed here first
 * @param {(done: number, total: number, phase: 'fetching'|'writing') => void} [onProgress]
 *   `fetching` while the rest of the site arrives, then `writing` as it is stored
 */
export async function keep (torrent, onProgress = () => {}) {
  // Keeping is asking for all of it. A site fetched as it is read has only
  // the pieces its reader looked at, and nothing else will ever fetch the
  // rest — refusing here, as this once did for any unfinished site, made
  // exactly the sites that most need a full copy impossible to keep.
  if (!torrent.done) await fetchWhole(torrent, onProgress)
  await requestPersistence()

  const total = torrent.pieces.length
  for (let start = 0; start < total; start += BATCH) {
    const indexes = []
    for (let i = start; i < Math.min(start + BATCH, total); i++) indexes.push(i)

    const batch = await Promise.all(indexes.map(async index => ({
      index,
      data: await readPiece(torrent, index)
    })))
    await putChunks(torrent.infoHash, batch)
    onProgress(Math.min(start + BATCH, total), total, 'writing')
  }

  // Written last, so a record only ever exists for a site whose bytes are all
  // there: an interrupted keep leaves orphan chunks, not a broken site.
  await putSite({
    infoHash: torrent.infoHash,
    name: torrent.name,
    length: torrent.length,
    // Kept so the site stays *shareable*, not just readable. Rebuilding a
    // magnet from the infohash alone loses the trackers it was published with
    // and the display name — and a bare infohash is not something a friend can
    // open, because their gate has nowhere to ask.
    magnetURI: torrent.magnetURI,
    torrentFile: new Uint8Array(torrent.torrentFile),
    savedAt: Date.now()
  })
}

/**
 * Why this site cannot be kept here, or null if it can. Asked before the
 * question, so nobody agrees to keep something and is then refused.
 *
 * Two limits, both about the fetch that keeping a partly-read site starts:
 *  - `memory`: the torrent is held in memory while it downloads (no OPFS here,
 *    the same test WebTorrent makes) and the site is past KEEP_IN_MEMORY_BYTES;
 *  - `space`: the browser reports less room than keeping needs — one copy in
 *    IndexedDB, plus, where the torrent itself sits in OPFS, whatever of it has
 *    not arrived yet, since that is written to disk first.
 *
 * Pure, so the rule can be checked without a gigabyte of torrent.
 *
 * @param {{length: number, downloaded: number, done: boolean, inMemory: boolean, free: number|null}} site
 * @returns {{kind: 'memory'|'space', needed: number, free: number|null}|null}
 */
export function keepRefusal ({ length, downloaded, done, inMemory, free }) {
  if (!done && inMemory && length > KEEP_IN_MEMORY_BYTES) return { kind: 'memory', needed: length, free }
  const needed = length + (done || inMemory ? 0 : Math.max(0, length - downloaded))
  if (free !== null && free < needed) return { kind: 'space', needed, free }
  return null
}

/** keepRefusal, asked of this browser about this torrent. */
export async function whyNotKeep (torrent) {
  const inMemory = !(globalThis.navigator?.storage?.getDirectory &&
    globalThis.FileSystemFileHandle?.prototype?.createWritable)
  let free = null
  try {
    const { usage: used, quota } = await usage()
    if (quota) free = quota - used
  } catch { /* no estimate: the browser will say so itself if it runs out */ }
  return keepRefusal({ length: torrent.length, downloaded: torrent.downloaded, done: torrent.done, inMemory, free })
}

/**
 * Select every piece and wait until all of them are here.
 *
 * Not before `ready`: a site is shown once its metadata arrives, and its
 * pieces are laid out only after that, so Keep can be pressed while there are
 * none. Selecting then selected nothing, `done` never came, and the control
 * stayed disabled for good.
 *
 * Exported for the check that proves that, with a stand-in torrent.
 */
export function fetchWhole (torrent, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    let timer = null
    const finish = err => {
      clearInterval(timer)
      torrent.removeListener('ready', start)
      torrent.removeListener('done', onDone)
      torrent.removeListener('error', finish)
      err ? reject(err) : resolve()
    }
    const onDone = () => finish()
    const start = () => {
      const total = torrent.pieces.length
      const tick = () => onProgress(Math.round(torrent.progress * total), total, 'fetching')
      timer = setInterval(tick, 500)
      torrent.select(0, total - 1)
      tick()
      if (torrent.done) finish()
    }
    torrent.once('done', onDone)
    torrent.once('error', finish)
    if (torrent.ready) start()
    else torrent.once('ready', start)
  })
}

/** Delete a kept site and every byte of it. */
export function forget (infoHash) {
  return deleteSite(infoHash)
}

/**
 * Re-add every kept site to the swarm client, reading from IndexedDB.
 *
 * This is what makes keeping worth anything: the sites are complete and
 * seedable straight away, without waiting to meet a peer who has them.
 *
 * @param {import('webtorrent').Instance} client
 * @param {(torrent: object) => void} [onAdd]  called the moment each torrent
 *   joins the client, before any peer has handshaked with it
 * @returns {Promise<{ restored: number, failed: string[] }>}
 */
export async function restoreAll (client, onAdd) {
  const sites = await listSites()
  const failed = []
  let restored = 0

  for (const site of sites) {
    // A site whose stored pieces no longer verify is not fatal: the gate still
    // works, and the site can be re-fetched from the swarm.
    if (await restoreOne(client, site.infoHash, onAdd)) restored++
    else failed.push(site.infoHash)
  }
  return { restored, failed }
}

/** Restores in flight, so the same site is never added to the client twice. */
const restoring = new Map()

/**
 * Bring one kept site back from disk, if it is kept.
 *
 * Opening a site has to go through here first. `restoreAll` runs in the
 * background at startup so that unhealthy storage cannot hold up the whole
 * gate, and that left a race: whichever added the infohash first won, and when
 * the ordinary swarm path won, the copy on disk was never touched. A kept site
 * then sat looking for peers that no longer existed — exactly the thing keeping
 * it was supposed to prevent.
 *
 * @returns {Promise<boolean>} whether the site is now loaded from disk
 */
export function restoreOne (client, infoHash, onAdd) {
  if (!infoHash) return Promise.resolve(false)
  if (restoring.has(infoHash)) return restoring.get(infoHash)

  const job = (async () => {
    const site = await getSite(infoHash)
    if (!site) return false
    await restore(client, site, onAdd)
    return true
  })()
    .catch(() => false)
    .finally(() => restoring.delete(infoHash))

  restoring.set(infoHash, job)
  return job
}

async function restore (client, site, onAdd) {
  const already = await client.get(site.infoHash)
  if (already) return onAdd?.(already) // already open in this tab

  await new Promise((resolve, reject) => {
    const torrent = client.add(site.torrentFile, { store: IdbChunkStore }, () => resolve())

    // Handed over before the wait, not after. A peer learns what extensions we
    // speak in its BEP 10 handshake, which happens as soon as it connects — so
    // a watcher attached once the restore has finished is invisible to every
    // peer that arrived during it, and a kept site was never told about a new
    // version. Attaching here means the advertisement goes out with the
    // handshake, which is the only moment it can.
    onAdd?.(torrent)
    torrent.once('error', reject)
  })
}

/** WebTorrent's store is callback-based; the pieces are already in memory. */
function readPiece (torrent, index) {
  return new Promise((resolve, reject) => {
    torrent.store.get(index, (err, buf) => err ? reject(err) : resolve(buf))
  })
}
