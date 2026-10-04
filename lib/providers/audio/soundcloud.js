/**
 * SoundCloudProvider — full-track audio via SoundCloud stream URLs.
 *
 * Resolves the direct MP3 URL (no server download).
 * Backend redirects; browser streams directly from SoundCloud CDN.
 * Fast: ~5s for search + resolve. 10s timeout enforced by caller.
 */
const { AudioProvider } = require("./base");
const { execFile } = require("child_process");

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(0, 200)));
      resolve(stdout);
    });
  });
}

const SEARCH_TIMEOUT = 8000;

class SoundCloudProvider extends AudioProvider {
  get name() { return "soundcloud"; }

  async getPlayableSource(track) {
    const query = `${track.artist} ${track.title}`;
    const expectedSecs = Math.round((track.durationMs || 180000) / 1000);
    const errors = [];

    // 1. search
    let urls = [];
    try {
      const out = await run("python3",
        ["-m", "yt_dlp", "--flat-playlist", "--print", "%(webpage_url)s", `scsearch5:${query}`],
        SEARCH_TIMEOUT);
      urls = out.trim().split("\n").filter((u) => u.startsWith("http")).slice(0, 5);
    } catch (e) {
      return { available: false, reason: "search failed", stage: "resolve" };
    }
    if (!urls.length) return { available: false, reason: "no results", stage: "resolve" };

    // 2. get stream url for first working result (speed over perfect match)
    for (const url of urls) {
      try {
        const streamUrl = (await run("python3",
          ["-m", "yt_dlp", "--print", "url", "--no-download", "-f", "bestaudio", url], 6000)
        ).trim().split("\n")[0];

        if (streamUrl && streamUrl.startsWith("http")) {
          return {
            available: true,
            url: streamUrl,
            mimeType: "audio/mpeg",
            durationMs: track.durationMs || 0,
            expiresAt: Date.now() + 300000,
            provider: this.name,
            isPreview: false,
          };
        }
      } catch (e) {
        errors.push(url.slice(-11) + ": " + e.message.slice(0, 60));
      }
    }
    return { available: false, reason: errors.join(" | ") || "no playable url", stage: "fetch" };
  }

  async checkHealth() {
    return { ok: true, detail: "soundcloud via yt-dlp" };
  }
}

module.exports = { SoundCloudProvider };
