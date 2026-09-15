/**
 * Everything that is a policy decision rather than logic.
 * Nothing here may name a specific host for the gate itself: the bundle must
 * behave identically from any mirror.
 */

/**
 * Browsers can only reach WebRTC peers, which means `wss://` trackers. These
 * are the WebTorrent defaults; they are the one unavoidable piece of shared
 * infrastructure in the MVP, so keep them visible rather than buried.
 */
export const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev'
]

// Dropped: wss://tracker.btorrent.xyz. It is in WebTorrent's default list but
// refuses connections (ECONNREFUSED), so every publish shipped a tracker that
// could only produce a console error and a slower start.

/** Path prefix the service worker answers on, relative to the gate's scope. */
export const TORRENT_PATH = 'webtorrent'

/**
 * How long to wait for a torrent's metadata, expressed as two clocks.
 *
 * A single deadline was wrong, and wrong in a way that made live sites look
 * dead. A browser cannot dial a peer: it meets whoever a tracker introduces it
 * to, by brokering WebRTC offers between whoever happens to be announcing at
 * the same moment. So a reader can spend the entire budget connected to a peer
 * that has nothing — another reader who has also just arrived, most easily —
 * while the seeder sits there perfectly healthy, waiting to be introduced on a
 * later announce that never gets a chance to happen. Observed exactly that way:
 * one useless peer, thirty seconds, "This site could not be found", and the
 * seeder's own log showing it up the whole time.
 *
 * So: QUIET is how long to tolerate nothing new happening before asking the
 * trackers for a different set of peers, and DEADLINE caps the whole attempt.
 * A swarm that has produced no peer at all is still abandoned early — that is
 * the ordinary shape of a site nobody is seeding, and making its 404 slow to
 * arrive helps no one.
 */
export const METADATA_QUIET_MS = 15_000
export const METADATA_DEADLINE_MS = 60_000

/**
 * How long to wait when nobody has answered at all.
 *
 * Deliberately the same as the old single timeout, so the ordinary "nobody is
 * seeding this" case reports just as promptly as it always did. Only a swarm
 * that has produced at least one peer earns the longer deadline, because only
 * then is there something to be introduced to.
 */
export const METADATA_SILENT_MS = 30_000

/**
 * The version of `sw.js` this bundle expects to be talking to. Bump both
 * together. A worker from an older release keeps serving after the page has
 * been updated, and the symptom is that everything reports healthy while
 * nothing renders — so Diagnostics compares them and flags a mismatch.
 */
export const EXPECTED_WORKER_VERSION = '2026-09-13.1'

/**
 * Which build of the gate this is.
 *
 * There is no build step here on purpose, so nothing stamps a version into the
 * bundle: this is bumped by hand when a release goes out. It exists because
 * "am I running the current gate?" was unanswerable, and a reader whose browser
 * had cached an older one had no way to tell — they would report a bug that had
 * been fixed, and be right that it was still happening to them.
 *
 * Diagnostics compares this against the copy deployed at the origin the page
 * came from, which turns that question into one line.
 */
export const GATE_VERSION = '2026-09-15.2'

/**
 * What a .zip may be: how large, how large unpacked, and how many files.
 *
 * These are not security limits so much as honesty limits: a browser publishing
 * a site holds it in memory and seeds it from there, so an archive larger than
 * this produces a tab that dies rather than a site that spreads. Refusing early,
 * by name, beats a crash the author cannot interpret.
 *
 * Be clear about what they do *not* bound. Unpacking holds the compressed
 * archive and the unpacked files at the same time, so the peak is roughly the
 * sum of the two — an archive at the byte cap needs something nearer twice it
 * before WebTorrent has hashed anything. And bytes are not the only budget: a
 * file costs a File, a torrent entry, a manifest line and a row in the listing
 * whether or not it contains anything, which is why there is a count.
 *
 * All three are provisional, and the byte ones are deliberately well under what
 * a desktop could manage. They should come from measuring a mid-range phone,
 * which has not been done.
 */
export const ZIP_MAX_TOTAL_BYTES = 64_000_000
export const ZIP_MAX_ENTRY_BYTES = 32_000_000
export const ZIP_MAX_ENTRIES = 2_000
