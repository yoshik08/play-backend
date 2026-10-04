// getmp3: download best-audio mp3 for a query via yt-dlp, return the file path.
// caller streams it to the client. files go to a tmp dir, cleaned after serving.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const YTDLP = "python3 -m yt_dlp";

function run(cmd, args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.slice(0, 500) || err.message));
      resolve(stdout);
    });
  });
}

async function downloadMp3(query) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "play-"));
  const out = path.join(dir, "audio.%(ext)s");
  // android client is the reliable one per past testing
  const args = [
    "-m", "yt_dlp",
    "--extractor-args", "youtube:player_client=android",
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "--no-playlist", "--max-downloads", "1",
    "--no-warnings",
    "-o", out,
    `ytsearch1:${query} audio`,
  ];
  await run("python3", args, 300000);
  const mp3 = path.join(dir, "audio.mp3");
  if (!fs.existsSync(mp3)) throw new Error("download produced no mp3");
  return {
    path: mp3,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} },
  };
}

module.exports = { downloadMp3 };
