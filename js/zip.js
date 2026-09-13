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

import { ZIP_MAX_ENTRY_BYTES, ZIP_MAX_TOTAL_BYTES } from './config.js'

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
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const entries = readCentralDirectory(bytes, view)
  if (entries.length === 0) throw new ZipError('That archive has no files in it.')

  // Summed from the directory, so an oversized archive is refused before a
  // single byte is inflated or allocated rather than partway through.
  const total = entries.reduce((sum, entry) => sum + entry.size, 0)
  if (total > ZIP_MAX_TOTAL_BYTES) {
    throw new ZipError(
      `That archive unpacks to more than ${megabytes(ZIP_MAX_TOTAL_BYTES)}, ` +
      'which is more than a browser can hold and seed.')
  }

  const files = []

  for (const entry of entries) {
    const contents = await readEntry(bytes, view, entry)
    const file = new File([contents], basename(entry.path), lastModified(entry))
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
function readCentralDirectory (bytes, view) {
  const start = findEndRecord(bytes, view)

  const count = view.getUint16(start + 10, true)
  const size = view.getUint32(start + 12, true)
  const at0 = view.getUint32(start + 16, true)

  if (at0 === 0xffffffff || size === 0xffffffff || count === 0xffff) {
    throw new ZipError('That archive is in zip64 format, which Spore does not read.')
  }
  if (at0 + size > bytes.length) throw new ZipError('That archive is truncated.')

  const entries = []
  const seen = new Set()
  let at = at0

  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) {
      throw new ZipError('That archive’s index is damaged.')
    }

    const entry = {
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      compressed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true)
    }

    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const external = view.getUint32(at + 38, true)

    // Bit 11 promises UTF-8. Archives predating it use CP437, and rather than
    // carry a code page table to publish a file called `perché.html`, a name
    // that is not valid UTF-8 is refused. Decoding it loosely would republish
    // the file under a different name, and every relative link to it would then
    // resolve to nothing — a silent repair, which is the thing this reader does
    // not do.
    const raw = bytes.subarray(at + 46, at + 46 + nameLength)
    let path
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      throw new ZipError('That archive has a file name Spore cannot read; it is not UTF-8.')
    }
    at += 46 + nameLength + extraLength + commentLength

    if (path === '') throw new ZipError('That archive contains a file with no name.')

    if (entry.flags & 0x1) throw new ZipError(`${path} is encrypted.`)
    if (entry.method !== STORED && entry.method !== DEFLATED) {
      throw new ZipError(`${path} uses a compression method Spore does not read.`)
    }
    if (entry.size === 0xffffffff || entry.compressed === 0xffffffff) {
      throw new ZipError(`${path} is stored in zip64 format, which Spore does not read.`)
    }
    if (entry.size > ZIP_MAX_ENTRY_BYTES) {
      throw new ZipError(`${path} is larger than ${megabytes(ZIP_MAX_ENTRY_BYTES)}.`)
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

/**
 * A name that climbs out of the archive, or names a place rather than a path.
 *
 * None of these would escape anything here — nothing is written to a disk, and
 * the paths become torrent entries — but an archive containing one is not an
 * archive of a website, and a torrent laid out from it would not render the way
 * its author saw it locally.
 */
function checkPath (path) {
  // Rewritten separators were the one repair this made, and it contradicted its
  // own contract: `css\style.css` would be published at `css/style.css`, a path
  // its author never wrote. The zip format says forward slashes, so a backslash
  // means a tool that got it wrong, and that is the author's to fix.
  if (path.includes('\\')) {
    throw new ZipError(`${path} uses backslashes, which a zip may not.`)
  }
  const normalized = path

  if (normalized.startsWith('/')) throw new ZipError(`${path} is an absolute path.`)
  if (/^[a-z]:/i.test(normalized)) throw new ZipError(`${path} names a drive.`)
  if (normalized.split('/').some(part => part === '..')) {
    throw new ZipError(`${path} points outside the archive.`)
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ZipError('That archive contains a file name with control characters in it.')
  }
  return normalized
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
function findEndRecord (bytes, view) {
  if (bytes.length < 22) throw new ZipError('That file is not a zip archive.')

  // Only the real record is looked for. A zip64 shortcut used to sit here,
  // throwing on any `PK\x06\x06` found while scanning, and it had exactly the
  // bug the comment-length rule above exists to prevent: those four bytes
  // inside an ordinary comment refused a perfectly good archive. Zip64 is still
  // refused — by its markers in the record itself, which cannot be faked by a
  // coincidence in a comment.
  const from = Math.max(0, bytes.length - MAX_TRAILER)
  for (let at = bytes.length - 22; at >= from; at--) {
    if (view.getUint32(at, true) === EOCD &&
        view.getUint16(at + 20, true) === bytes.length - at - 22) {
      return at
    }
  }
  throw new ZipError('That file is not a zip archive, or it is damaged.')
}

/** Inflate one entry, checking it arrived intact. */
async function readEntry (bytes, view, entry) {
  const at = entry.offset
  if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL) {
    throw new ZipError(`${entry.path} is not where the archive says it is.`)
  }

  // The local header is read only for its own two length fields: the data
  // begins after them, and they are allowed to differ from the directory's.
  const nameLength = view.getUint16(at + 26, true)
  const extraLength = view.getUint16(at + 28, true)
  const from = at + 30 + nameLength + extraLength

  if (from + entry.compressed > bytes.length) {
    throw new ZipError(`${entry.path} runs past the end of the archive.`)
  }

  const raw = bytes.subarray(from, from + entry.compressed)
  const contents = entry.method === STORED ? raw : await inflate(raw, entry)

  if (contents.length !== entry.size) {
    throw new ZipError(`${entry.path} did not unpack to the size the archive claims.`)
  }
  // Checked because the alternative is publishing a corrupt file under a
  // signature, which is the one failure this project cannot shrug at: the bytes
  // would verify perfectly as the bytes that were signed, and still be wrong.
  if (crc32(contents) !== entry.crc) {
    throw new ZipError(`${entry.path} is corrupt.`)
  }
  return contents
}

async function inflate (raw, entry) {
  // Constructing this throws synchronously where `deflate-raw` is unknown, and
  // that error escaped as a raw platform exception with nothing in it for the
  // person holding the archive. Older than Safari 16.4 is the realistic case.
  let stream
  try {
    stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  } catch {
    throw new ZipError('This browser cannot unpack zip archives. It is too old.')
  }

  const chunks = []
  let total = 0

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
    // The declared size was checked against the cap before anything was
    // inflated; this catches an archive that lied about it.
    if (total > entry.size) {
      await reader.cancel().catch(() => {})
      throw new ZipError(`${entry.path} is larger than the archive claims.`)
    }
    chunks.push(read.value)
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

function crc32 (bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
