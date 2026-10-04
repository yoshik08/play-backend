/**
 * PreviewUrlProvider — uses the track's existing previewUrl (iTunes/Spotify).
 *
 * The music providers (itunes, spotify) already return previewUrl in the
 * normalized track. This provider just validates and serves it.
 * No extra search needed. Legal, reliable, 30s previews.
 */
const { AudioProvider } = require("./base");

class PreviewUrlProvider extends AudioProvider {
  get name() { return "preview-url"; }

  async getPlayableSource(track) {
    const url = track.previewUrl;
    if (!url) {
      return { available: false, reason: "track has no previewUrl", stage: "resolve" };
    }

    // validate reachable and non-empty
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const r = await fetch(url, { method: "HEAD", signal: controller.signal });
      clearTimeout(timeout);
      if (!r.ok) {
        return { available: false, reason: `preview url returned ${r.status}`, stage: "fetch" };
      }
      const len = parseInt(r.headers.get("content-length") || "0", 10);
      // itunes previews don't always send content-length on HEAD; try a range GET
      if (!len) {
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 15000);
        const r2 = await fetch(url, { headers: { Range: "bytes=0-1023" }, signal: c2.signal });
        clearTimeout(t2);
        const body = await r2.arrayBuffer();
        if (!body.byteLength) {
          return { available: false, reason: "preview url returned zero bytes", stage: "validate" };
        }
      }
    } catch (e) {
      return { available: false, reason: "preview unreachable: " + e.message.slice(0, 100), stage: "fetch" };
    }

    // itunes previews are m4a (aac), spotify are mp3
    const mimeType = url.includes("itunes") || url.includes("mzstatic") ? "audio/mp4" : "audio/mpeg";
    return {
      available: true,
      url,
      mimeType,
      durationMs: 30000,
      expiresAt: null,
      provider: this.name,
      isPreview: true,
    };
  }

  async checkHealth() {
    return { ok: true, detail: "uses track previewUrl, no external dependency" };
  }
}

module.exports = { PreviewUrlProvider };
