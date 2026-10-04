// getmp3: download best-audio mp3 for a query via yt-dlp, return the file path.
// tries multiple youtube clients (datacenter ips get blocked per-client).
// caller streams it to the client. files go to a tmp dir, cleaned after serving.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(0, 800)));
      resolve(stdout);
    });
  });
}

const CLIENTS = ["android", "ios", "web"];

async function downloadMp3(query) {
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
      await run("python3", args, 180000);
      const mp3 = path.join(dir, "audio.mp3");
      if (fs.existsSync(mp3) && fs.statSync(mp3).size > 10000) {
        return { path: mp3, cleanup: cleanupDir };
      }
      lastErr = new Error(`client ${client}: no mp3 produced`);
    } catch (e) {
      lastErr = new Error(`client ${client}: ${e.message}`);
      console.log("getmp3 failed:", lastErr.message.slice(0, 200));
    }
  }
  cleanupDir();
  throw new Error("playback unavailable for this track (" + (lastErr ? lastErr.message.slice(0, 120) : "unknown") + ")");
}

module.exports = { downloadMp3 };
