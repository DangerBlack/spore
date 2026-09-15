/**
 * Reading a .zip, so a folder can arrive through a file picker.
 *
 * ## Why this exists
 *
 * A site is a folder, and on some devices a folder cannot be chosen at all:
 * iOS offers no directory picker, so `<input webkitdirectory>` falls back to
 * single files and there is nothing to drag. A zip is a folder that fits
 * through the ordinary file picker, which reaches Files, iCloud Drive and every
 * other document provider. It routes around that one gap and nothing else.
 *
 * Picking loose files works too, but a file picker yields no relative paths, so
 * everything lands at the root of the torrent. A site with `css/style.css`
 * cannot be expressed that way at all. That is what this is for.
 *
 * ## No dependency
 *
 * `DecompressionStream('deflate-raw')` is native — Safari 16.4 and iOS 16.4
 * (March 2023), Chrome 80, Firefox 113 — and deflate is what a zip stores. So
 * what is left is the container: an index at the end of the file, and a header
 * before each blob of bytes. That is small enough to read here, and reading it
 * here means no library sits between an author and their signature.
 *
 * ## What it refuses, and why refusing beats repairing
 *
 * An archive that trips any check below is rejected whole, with a message
 * naming the entry. It is not quietly sanitised. An archive containing a path
 * that climbs out of its own directory is either broken or hostile, and neither
 * should be published under somebody's key — and a repaired archive is no
 * longer the archive its author reviewed.
 *
 * The list is the specification. Anything not named here is refused by default,
 * which is what keeps this file the size it is.
 */

import { ZIP_MAX_ENTRIES, ZIP_MAX_EXPANSION, ZIP_MAX_INFLATED_BYTES } from './config.js'

const EOCD = 0x06054b50 // end of central directory
const CENTRAL = 0x02014b50 // one entry in that directory
const LOCAL = 0x04034b50 // the header sitting before each blob

const STORED = 0
const DEFLATED = 8

/** A comment can follow the end record, and its length field is 16 bits. */
const MAX_TRAILER = 0xffff + 22

/** Thrown for every refusal, so the caller can show the reason verbatim. */
export class ZipError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ZipError'
  }
}

/**
 * Unpack an archive into the same shape a dropped folder produces.
 *
 * @param {File|Blob} blob
 * @returns {Promise<{files: File[], name: string|null}>} `fullPath` set on each
 *   file, the single shared root folder stripped, exactly as a drop gives.
 */
export async function filesFromZip (blob) {
  const entries = await readCentralDirectory(blob)
  if (entries.length === 0) throw new ZipError('That archive has no files in it.')

  // Only what has to be decompressed is counted. A stored entry is copied, not
  // inflated, so it costs nothing to hold and nothing here limits it — which is
  // the difference between a client people can put a film in and one they
  // cannot. Summed from the index, so an archive is refused before a byte of it
  // is inflated rather than part of the way through.
  const inflating = entries
    .filter(entry => entry.method === DEFLATED)
    .reduce((sum, entry) => sum + entry.size, 0)

  if (inflating > ZIP_MAX_INFLATED_BYTES) {
    throw new ZipError(
      `That archive has more than ${megabytes(ZIP_MAX_INFLATED_BYTES)} of compressed ` +
      'files in it, which is more than a browser can unpack and hold at once. ' +
      'Media stored without compression does not count towards this.')
  }

  const files = []
  for (const entry of entries) {
    const file = await readEntry(blob, entry)
    file.fullPath = entry.path
    files.push(file)
  }

  const root = sharedRoot(files.map(file => file.fullPath))
  if (root) for (const file of files) file.fullPath = file.fullPath.slice(root.length)

  return {
    files,
    // The folder inside the archive if there is one, otherwise the archive's
    // own name: it is what the author called the thing, and for a set of loose
    // entries it is the only name on offer.
    name: root ? root.slice(0, -1) : (blob.name ? blob.name.replace(/\.zip$/i, '') : null)
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Read the index at the end of the file.
 *
 * The central directory is authoritative and the local headers are not: a local
 * header may carry zeroed sizes with the real ones trailing the data (the
 * "data descriptor" of a streamed archive), and nothing obliges the two to
 * agree. Reading the directory also means the whole entry list is known, and
 * every refusal below has been made, before a single byte is inflated.
 */
async function readCentralDirectory (blob) {
  if (blob.size < 22) throw new ZipError('That file is not a zip archive.')

  // Two slices, and never the whole file. The end record lives in the last few
  // kilobytes; it says where the index is, and the index is read on its own.
  // An archive can be larger than memory — that is rather the point of putting
  // one in a BitTorrent client — so the only thing held here is its table of
  // contents.
  const tailFrom = Math.max(0, blob.size - MAX_TRAILER)
  const tail = await slice(blob, tailFrom, blob.size)
  const endAt = findEndRecord(tail, blob.size, tailFrom)

  const count = tail.view.getUint16(endAt - tailFrom + 10, true)
  const size = tail.view.getUint32(endAt - tailFrom + 12, true)
  const at0 = tail.view.getUint32(endAt - tailFrom + 16, true)

  if (at0 === 0xffffffff || size === 0xffffffff || count === 0xffff) {
    throw new ZipError('That archive is in zip64 format, which Spore does not read.')
  }
  if (at0 + size > blob.size) throw new ZipError('That archive is truncated.')

  // Bytes are not the only budget. Sixty-five thousand empty entries weigh
  // nothing and stay under every cap above, while each one becomes a File, a
  // torrent entry, a manifest line and a row in the file list — a bomb made of
  // metadata rather than of data.
  if (count > ZIP_MAX_ENTRIES) {
    throw new ZipError(`That archive holds more than ${ZIP_MAX_ENTRIES} files.`)
  }

  const index = await slice(blob, at0, at0 + size)
  const entries = []
  const seen = new Set()
  let at = 0

  for (let i = 0; i < count; i++) {
    if (at + 46 > size || index.view.getUint32(at, true) !== CENTRAL) {
      throw new ZipError('That archive’s index is damaged.')
    }

    const entry = {
      flags: index.view.getUint16(at + 8, true),
      method: index.view.getUint16(at + 10, true),
      time: index.view.getUint16(at + 12, true),
      date: index.view.getUint16(at + 14, true),
      crc: index.view.getUint32(at + 16, true),
      compressed: index.view.getUint32(at + 20, true),
      size: index.view.getUint32(at + 24, true),
      offset: index.view.getUint32(at + 42, true)
    }

    const nameLength = index.view.getUint16(at + 28, true)
    const extraLength = index.view.getUint16(at + 30, true)
    const commentLength = index.view.getUint16(at + 32, true)
    const external = index.view.getUint32(at + 38, true)

    // The record must lie inside the index the end record declared. Without
    // this the name was read from a `subarray` that silently clamps at the end
    // of the file — a truncated archive producing a plausible short name — and
    // the next lap read past the end and threw a raw RangeError.
    const end = at + 46 + nameLength + extraLength + commentLength
    if (end > size) throw new ZipError('That archive’s index is truncated.')

    const raw = index.bytes.subarray(at + 46, at + 46 + nameLength)
    // Bit 11 is the archive's promise that its names are UTF-8. Without it they
    // are CP437, and some CP437 byte pairs are valid UTF-8 by coincidence — so
    // checking the decode alone would let exactly those through under a
    // different name. Non-ASCII is refused unless the promise was made.
    if (!(entry.flags & 0x800) && raw.some(byte => byte > 0x7f)) {
      throw new ZipError(
        'That archive uses a legacy character set for a file name, which Spore cannot read.')
    }
    let path
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      throw new ZipError('That archive has a file name Spore cannot read; it is not UTF-8.')
    }
    at = end

    if (path === '') throw new ZipError('That archive contains a file with no name.')

    if (entry.flags & 0x1) throw new ZipError(`${path} is encrypted.`)
    if (entry.method !== STORED && entry.method !== DEFLATED) {
      throw new ZipError(`${path} uses a compression method Spore does not read.`)
    }
    if (entry.size === 0xffffffff || entry.compressed === 0xffffffff) {
      throw new ZipError(`${path} is stored in zip64 format, which Spore does not read.`)
    }
    // What a bomb actually is: a ratio, not a size. Refused from the index, so
    // nothing is inflated to discover it. A floor, because a few hundred bytes
    // expanding from a handful is ordinary and means nothing.
    if (entry.size > 65_536 && entry.size > entry.compressed * ZIP_MAX_EXPANSION) {
      throw new ZipError(`${path} claims to expand more than ${ZIP_MAX_EXPANSION}-fold.`)
    }
    // A zip can carry unix mode bits. A symlink is a file whose contents are a
    // path, and following one is how an archive reaches something it does not
    // contain, so they are refused rather than dereferenced or flattened.
    if (((external >>> 16) & 0xf000) === 0xa000) {
      throw new ZipError(`${path} is a symbolic link.`)
    }

    // Checked before directory records are dropped. They contribute no file, so
    // none of this could reach a torrent — but the contract is that an archive
    // tripping any of these is refused whole, and an archive carrying `../bad/`
    // is not an archive of a website whether or not the entry holds bytes.
    entry.path = checkPath(path)
    if (path.endsWith('/')) continue // a directory record holds nothing

    if (seen.has(entry.path)) {
      throw new ZipError(`That archive contains ${entry.path} twice.`)
    }
    seen.add(entry.path)
    entries.push(entry)
  }

  return entries
}

/** A window onto part of the archive, read once and read small. */
async function slice (blob, from, to) {
  const bytes = new Uint8Array(await blob.slice(from, to).arrayBuffer())
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
}

/**
 * A name that climbs out of the archive, or names a place rather than a path.
 *
 * None of these would escape anything here — nothing is written to a disk, and
 * the paths become torrent entries — but an archive containing one is not an
 * archive of a website, and a torrent laid out from it would not render the way
 * its author saw it locally. Nothing is repaired: the path is returned exactly
 * as the archive spelled it, or the archive is refused.
 */
function checkPath (path) {
  // Rewritten separators were the one repair this made, and it contradicted its
  // own contract: `css\\style.css` would be published at `css/style.css`, a path
  // its author never wrote. The zip format says forward slashes, so a backslash
  // means a tool that got it wrong, and that is the author's to fix.
  if (path.includes('\\')) {
    throw new ZipError(`${path} uses backslashes, which a zip may not.`)
  }
  if (path.startsWith('/')) throw new ZipError(`${path} is an absolute path.`)
  if (/^[a-z]:/i.test(path)) throw new ZipError(`${path} names a drive.`)

  // `..` escapes, and `.` or an empty component is a path that means one thing
  // to the torrent builder and another to `new URL()` in the viewer: the signer
  // would record `./index.html` while a reader resolved `index.html`, and the
  // site would fail to verify for a reason nobody could see.
  const parts = path.split('/')
  if (parts.includes('..')) throw new ZipError(`${path} points outside the archive.`)
  // `.` is refused everywhere, including last: `site/.` is not a directory
  // record, and `new URL()` resolves it to `site/`, so the path the signer
  // records and the path a reader asks for are different strings. An empty
  // component is allowed only as the last one, which is what a directory
  // record's trailing slash is and is meant to be.
  if (parts.includes('.') || parts.slice(0, -1).some(part => part === '')) {
    throw new ZipError(`${path} is not a plain path.`)
  }

  // C0, DEL and C1. The stated rule is "no control characters", and a range
  // that stopped at DEL was not that rule.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    // Named like every other refusal. This was the one that made the author
    // guess which of their files needed fixing.
    throw new ZipError(`${printable(path)} has control characters in its name.`)
  }
  return path
}

/**
 * Scan back from the end for the end-of-central-directory record.
 *
 * The signature alone is not enough to identify it: an archive may carry a
 * trailing comment, and a comment may contain those four bytes. So the record
 * is accepted only if its own comment-length field accounts for exactly the
 * bytes that follow it — which a coincidence inside a comment will not do.
 * Without that, a perfectly good archive was refused as having no files in it.
 */
function findEndRecord (tail, fileSize, tailFrom) {
  for (let i = tail.bytes.length - 22; i >= 0; i--) {
    if (tail.view.getUint32(i, true) !== EOCD) continue
    const at = tailFrom + i

    // Two conditions, because the comment rule alone is a heuristic and this is
    // a fact about the format. The comment follows the record, so a comment can
    // contain a convincing forgery — including one whose length field happens
    // to match the bytes after it. The index it points at, though, has to end
    // exactly where the record begins.
    const commentFits = tail.view.getUint16(i + 20, true) === fileSize - at - 22
    const offset = tail.view.getUint32(i + 16, true)
    const indexEndsHere = offset + tail.view.getUint32(i + 12, true) === at

    // A zip64 archive puts a sentinel where that offset goes, so it can never
    // satisfy the second condition — and refusing it here would tell its author
    // "this is not a zip archive", which is both false and useless. It is
    // recognised so that it can be refused by name a few lines further down.
    const isZip64 = offset === 0xffffffff || tail.view.getUint16(i + 10, true) === 0xffff

    if (commentFits && (indexEndsHere || isZip64)) return at
  }
  throw new ZipError('That file is not a zip archive, or it is damaged.')
}

/**
 * One entry, as a File, without the archive ever being held whole.
 *
 * A stored entry is the author's bytes verbatim, so it is handed over as a
 * slice of the file on disk: WebTorrent reads that in pieces the same way it
 * reads a dropped file, and a two-gigabyte film never becomes two gigabytes of
 * memory. Only a compressed entry has to be materialised, because its bytes do
 * not exist anywhere until they are inflated.
 */
async function readEntry (blob, entry) {
  const header = await slice(blob, entry.offset, Math.min(entry.offset + 30, blob.size))
  if (header.bytes.length < 30 || header.view.getUint32(0, true) !== LOCAL) {
    throw new ZipError(`${entry.path} is not where the archive says it is.`)
  }

  // The local header is read only for its own two length fields: the data
  // begins after them, and they are allowed to differ from the index's.
  const from = entry.offset + 30 +
    header.view.getUint16(26, true) + header.view.getUint16(28, true)

  if (from + entry.compressed > blob.size) {
    throw new ZipError(`${entry.path} runs past the end of the archive.`)
  }

  const raw = blob.slice(from, from + entry.compressed)
  const named = [basename(entry.path), lastModified(entry)]

  if (entry.method === STORED) {
    if (entry.compressed !== entry.size) {
      throw new ZipError(`${entry.path} is stored but claims two different sizes.`)
    }
    await checkCrc(entry, raw.stream())
    return new File([raw], ...named)
  }

  return new File([await inflate(raw, entry)], ...named)
}

/**
 * Read a stream only to check it arrived intact.
 *
 * A pass over the bytes rather than a copy of them: this is what lets a stored
 * entry be checked without being held. It is checked at all because publishing
 * a corrupt file under a good signature is the one failure this project cannot
 * shrug at — the bytes would verify perfectly as the bytes that were signed,
 * and still be wrong.
 */
async function checkCrc (entry, stream) {
  let crc = 0xffffffff
  let total = 0

  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    crc = crcInto(crc, value)
  }

  if (total !== entry.size) {
    throw new ZipError(`${entry.path} is not the size the archive claims.`)
  }
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
    throw new ZipError(`${entry.path} is corrupt.`)
  }
}

async function inflate (raw, entry) {
  // Constructing this throws synchronously where `deflate-raw` is unknown, and
  // that error escaped as a raw platform exception with nothing in it for the
  // person holding the archive. Older than Safari 16.4 is the realistic case.
  let stream
  try {
    stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))
  } catch {
    throw new ZipError('This browser cannot unpack zip archives. It is too old.')
  }

  const chunks = []
  let total = 0
  let crc = 0xffffffff

  const reader = stream.getReader()
  for (;;) {
    let read
    try {
      read = await reader.read()
    } catch {
      throw new ZipError(`${entry.path} could not be decompressed.`)
    }
    if (read.done) break

    total += read.value.length
    // The declared size was weighed against the budget before anything was
    // inflated; this catches an archive that lied about it.
    if (total > entry.size) {
      await reader.cancel().catch(() => {})
      throw new ZipError(`${entry.path} is larger than the archive claims.`)
    }
    crc = crcInto(crc, read.value)
    chunks.push(read.value)
  }

  if (total !== entry.size) {
    throw new ZipError(`${entry.path} did not unpack to the size the archive claims.`)
  }
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
    throw new ZipError(`${entry.path} is corrupt.`)
  }

  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
  return out
}

/** The one folder every entry sits inside, if there is one. */
function sharedRoot (paths) {
  const cut = paths[0]?.indexOf('/') ?? -1
  if (cut < 1) return null

  const root = paths[0].slice(0, cut + 1)
  return paths.every(path => path.startsWith(root)) ? root : null
}

/** A path safe to put in a message, with the unprintable parts shown as dots. */
function printable (path) {
  // eslint-disable-next-line no-control-regex
  return path.replace(/[\u0000-\u001f\u007f-\u009f]/g, '·')
}

function basename (path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

function megabytes (bytes) {
  return `${Math.round(bytes / 1e6)} MB`
}

/** MS-DOS date and time, which is what a zip stores: local, with no zone. */
function lastModified (entry) {
  if (entry.date === 0) return {} // no timestamp, rather than December 1979

  const at = new Date(
    1980 + ((entry.date >> 9) & 0x7f), ((entry.date >> 5) & 0xf) - 1, entry.date & 0x1f,
    (entry.time >> 11) & 0x1f, (entry.time >> 5) & 0x3f, (entry.time & 0x1f) * 2)

  return Number.isNaN(at.getTime()) ? {} : { lastModified: at.getTime() }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** Folded chunk by chunk, so a large entry is never held to be checked. */
function crcInto (crc, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return crc
}
