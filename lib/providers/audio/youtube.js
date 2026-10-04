/**
 * YouTubeProvider — full-track audio via yt-dlp.
 *
 * Best-effort: works from residential IPs, often blocked from datacenters.
 * Downloads to a temp file, returns a local file path for streaming.
 * The server streams the file (transient, cleaned after serving).
 *
 * Returns { available: true, filePath, mimeType, durationMs, cleanup }
 * instead of a URL — the /api/audio endpoint streams the file.
 */
const { AudioProvider } = require("./base");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(0, 500)));
      resolve(stdout);
    });
  });
}

const CLIENTS = ["android", "ios", "web"];
const RESOLVER_TIMEOUT = 180000;

class YouTubeProvider extends AudioProvider {
  get name() { return "youtube"; }

  async getPlayableSource(track) {
    const query = `${track.artist} ${track.title}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "play-"));
    const out = path.join(dir, "audio.%(ext)s");
    const cleanupDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
    let lastErr = null;

    for (const client of CLIENTS) {
      try {
        const args = [
          "-m", "yt_dlp",
          "--extractor-args", `youtube:player_client=${client}`,
          "-x", "--audio-format", "mp3", "--audio-quality", "0",
          "--no-playlist", "--max-downloads", "1",
          "-o", out,
          `ytsearch1:${query} audio`,
        ];
        await run("python3", args, RESOLVER_TIMEOUT);
        const mp3 = path.join(dir, "audio.mp3");
        if (fs.existsSync(mp3) && fs.statSync(mp3).size > 10000) {
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
        lastErr = `client ${client}: no mp3 produced`;
      } catch (e) {
        lastErr = `client ${client}: ${e.message.slice(0, 200)}`;
      }
    }
    cleanupDir();
    return { available: false, reason: lastErr || "download failed", stage: "fetch" };
  }

  async checkHealth() {
    try {
      await run("python3", ["-m", "yt_dlp", "--version"], 10000);
      return { ok: true, detail: "yt-dlp available" };
    } catch (e) {
      return { ok: false, detail: "yt-dlp not found: " + e.message };
    }
  }
}

module.exports = { YouTubeProvider };
