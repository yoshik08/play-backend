/**
 * SoundCloudProvider — full-track audio via yt-dlp's SoundCloud extractor.
 *
 * SoundCloud doesn't block datacenter IPs (unlike YouTube).
 * Official artist uploads are often DRM; this tries multiple search
 * results until one downloads successfully.
 */
const { AudioProvider } = require("./base");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(0, 300)));
      resolve(stdout);
    });
  });
}

const SEARCH_TIMEOUT = 30000;
const DOWNLOAD_TIMEOUT = 120000;

class SoundCloudProvider extends AudioProvider {
  get name() { return "soundcloud"; }

  async getPlayableSource(track) {
    const query = `${track.artist} ${track.title}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "play-sc-"));
    const cleanupDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
    const errors = [];

    // 1. get search result urls
    let urls = [];
    try {
      const out = await run("python3",
        ["-m", "yt_dlp", "--flat-playlist", "--print", "%(webpage_url)s", `scsearch5:${query}`],
        SEARCH_TIMEOUT);
      urls = out.trim().split("\n").filter((u) => u.startsWith("http")).slice(0, 5);
    } catch (e) {
      cleanupDir();
      return { available: false, reason: "soundcloud search failed: " + e.message.slice(0, 150), stage: "resolve" };
    }
    if (!urls.length) {
      cleanupDir();
      return { available: false, reason: "no soundcloud results", stage: "resolve" };
    }

    // 2. try each url until one downloads
    for (const url of urls) {
      const out = path.join(dir, "audio.%(ext)s");
      try {
        await run("python3",
          ["-m", "yt_dlp", "-x", "--audio-format", "mp3", "--audio-quality", "0",
           "--no-playlist", "-o", out, url],
          DOWNLOAD_TIMEOUT);
        const mp3 = path.join(dir, "audio.mp3");
        if (fs.existsSync(mp3) && fs.statSync(mp3).size > 50000) {
          return {
            available: true,
            filePath: mp3,
            mimeType: "audio/mpeg",
            durationMs: track.durationMs || 0,
            expiresAt: null,
            provider: this.name,
            isPreview: false,
            cleanup: cleanupDir,
          };
        }
      } catch (e) {
        errors.push(url.slice(-11) + ": " + e.message.slice(0, 80));
      }
      // clean partial file before next try
      try { fs.rmSync(path.join(dir, "audio.mp3"), { force: true }); } catch (e) {}
    }

    cleanupDir();
    return { available: false, reason: errors.join(" | ") || "all soundcloud results failed", stage: "fetch" };
  }

  async checkHealth() {
    try {
      await run("python3", ["-m", "yt_dlp", "--version"], 10000);
      return { ok: true, detail: "yt-dlp available (soundcloud extractor)" };
    } catch (e) {
      return { ok: false, detail: "yt-dlp not found" };
    }
  }
}

module.exports = { SoundCloudProvider };
