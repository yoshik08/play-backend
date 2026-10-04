/**
 * AudioService — the single entry point for audio resolution.
 *
 * Frontend calls GET /api/audio/:trackId.
 * This service:
 *   1. resolves the normalized track (from music providers)
 *   2. calls the AudioProvider chain
 *   3. returns a playable source or a controlled error
 *
 * In-flight deduplication: concurrent requests for the same track
 * share one resolution promise.
 */
const { CompositeAudioProvider } = require("./providers/audio/composite");
const { YouTubeProvider } = require("./providers/audio/youtube");
const { SpotifyPreviewProvider } = require("./providers/audio/spotify-preview");
const spotify = require("./spotify");
const itunes = require("./itunes");

const provider = new CompositeAudioProvider([
  new YouTubeProvider(),
  new SpotifyPreviewProvider(),
]);

// trackId -> Promise<AudioSource>
const inflight = new Map();

function isSpotifyId(id) { return String(id || "").startsWith("sp:"); }
function isItunesId(id) { return String(id || "").startsWith("it:"); }

async function resolveTrack(trackId) {
  const id = String(trackId || "");
  if (isSpotifyId(id)) {
    const ext = id.slice(3).split(":")[0]; // sp:<id> or sp:al:<id>
    return spotify.getTrack(ext);
  }
  if (isItunesId(id)) {
    return itunes.getTrack(id.slice(3));
  }
  throw new Error("unknown track id format");
}

async function getAudio(trackId) {
  const key = String(trackId);
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const track = await resolveTrack(key);
      const src = await provider.getPlayableSource(track);
      return { track, src };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

async function checkHealth() {
  return provider.checkHealth();
}

module.exports = { getAudio, resolveTrack, checkHealth, provider };
