/**
 * SpotifyPreviewProvider — 30-second preview URLs from the Spotify Web API.
 *
 * Legal and reliable: official API, Spotify CDN, no IP blocking.
 * Limitation: previews are ~30 seconds, not full tracks.
 *
 * This is the "authorized provider" baseline. The abstraction allows
 * swapping in a full-licensed provider without touching player logic.
 */
const { AudioProvider } = require("./base");
const spotify = require("../../spotify");

class SpotifyPreviewProvider extends AudioProvider {
  get name() { return "spotify-preview"; }

  async getPlayableSource(track) {
    // track.externalId is the spotify track id (for sp: tracks)
    // for it: tracks, we need to search spotify for the preview
    let spotifyId = null;
    let previewUrl = null;
    let durationMs = 30000;

    try {
      if (track.source === "spotify" && track.externalId) {
        spotifyId = track.externalId;
        const t = await spotify.getTrack(spotifyId);
        previewUrl = t.previewUrl;
        durationMs = t.durationMs; // full duration, but preview is 30s
      } else {
        // search spotify for this track to get preview
        const results = await spotify.search(`${track.title} ${track.artist}`, "track", 3);
        const match = results[0];
        if (match) {
          const t = await spotify.getTrack(match.externalId || match.id.replace(/^sp:/, ""));
          previewUrl = t.previewUrl;
          spotifyId = match.externalId;
        }
      }
    } catch (e) {
      return { available: false, reason: "spotify api failed: " + e.message, stage: "resolve" };
    }

    if (!previewUrl) {
      return { available: false, reason: "no preview available for this track", stage: "resolve" };
    }

    // validate the URL is reachable
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const r = await fetch(previewUrl, { method: "HEAD", signal: controller.signal });
      clearTimeout(timeout);
      if (!r.ok) {
        return { available: false, reason: `preview url returned ${r.status}`, stage: "fetch" };
      }
      const mimeType = r.headers.get("content-type") || "audio/mpeg";
      const len = parseInt(r.headers.get("content-length") || "0", 10);
      if (!len) {
        return { available: false, reason: "preview url returned zero bytes", stage: "validate" };
      }
    } catch (e) {
      return { available: false, reason: "preview url unreachable: " + e.message, stage: "fetch" };
    }

    return {
      available: true,
      url: previewUrl,
      mimeType: "audio/mpeg",
      durationMs: 30000, // previews are 30s
      expiresAt: null, // spotify preview urls are stable
      provider: this.name,
      isPreview: true,
    };
  }

  async checkHealth() {
    try {
      await spotify.search("test", "track", 1);
      return { ok: true, detail: "spotify api reachable" };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }
}

module.exports = { SpotifyPreviewProvider };
