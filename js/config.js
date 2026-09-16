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
export const GATE_VERSION = '2026-09-16.1'

/**
 * What a .zip may be.
 *
 * There is no limit on how large a published site may be, and there must not
 * be: this is a BitTorrent client, people will put films in it, and the folder
 * and file-picker paths have never had one — WebTorrent reads a `File` from
 * disk in pieces and never holds it whole.
 *
 * An archive is only different in the one way that matters: **bytes that get
 * decompressed have to be held, bytes that get copied do not.** An entry stored
 * without compression — which is what video, audio and already-compressed
 * images are — is handed to the swarm as a slice of the original file and never
 * enters memory, so nothing here constrains it. Only what actually inflates is
 * counted, and only because it has nowhere to live but RAM.
 *
 * `ZIP_MAX_EXPANSION` is the bomb guard, and it is the ratio rather than a size
 * because that is what a bomb is: 42 kilobytes claiming to be a terabyte. Real
 * text compresses by tens, pathological-but-honest text by hundreds; a bomb is
 * six figures or more.
 *
 * All three are still guesses. They should come from measuring a mid-range
 * phone, which has not been done.
 */
export const ZIP_MAX_INFLATED_BYTES = 256_000_000
export const ZIP_MAX_EXPANSION = 2_000
export const ZIP_MAX_ENTRIES = 2_000
