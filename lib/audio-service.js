/**
 * AudioService — single entry point for audio resolution.
 * Providers: soundcloud -> youtube. 10s total timeout, then fail.
 * No 30s previews. Full tracks or nothing.
 */
const { CompositeAudioProvider } = require("./providers/audio/composite");
const { SoundCloudProvider } = require("./providers/audio/soundcloud");
const { YouTubeProvider } = require("./providers/audio/youtube");
const spotify = require("./spotify");
const itunes = require("./itunes");

const provider = new CompositeAudioProvider([
  new SoundCloudProvider(),
  new YouTubeProvider(),
]);

const TIMEOUT_MS = 10000;

// trackId -> Promise<AudioSource>
const inflight = new Map();

function isSpotifyId(id) { return String(id || "").startsWith("sp:"); }
function isItunesId(id) { return String(id || "").startsWith("it:"); }

async function resolveTrack(trackId) {
  const id = String(trackId || "");
  if (isSpotifyId(id)) {
    const ext = id.slice(3).split(":")[0];
    return spotify.getTrack(ext);
  }
  if (isItunesId(id)) {
    return itunes.getTrack(id.slice(3));
  }
  throw new Error("unknown track id format");
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("audio resolve timed out")), ms)),
  ]);
}

async function getAudio(trackId) {
  const key = String(trackId);
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const track = await withTimeout(resolveTrack(key), TIMEOUT_MS);
      const src = await withTimeout(provider.getPlayableSource(track), TIMEOUT_MS);
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
