/**
 * Google Drive storage for the personal audio library.
 *
 * App-level auth: every upload lands in YOSHIK'S Drive, folder "yoshik-play".
 * The backend is the only thing that ever talks to the Drive API.
 *
 * Refresh token comes ONLY from the DRIVE_REFRESH_TOKEN env var (Render).
 * Mint it once with scripts/mint-drive-token.js and paste it into Render env.
 *
 * Uses drive.file scope: the app only ever sees files it created itself.
 * Uploads stream from disk (never buffered fully in memory).
 */
const fs = require("fs");
const { Readable } = require("stream");

const FOLDER_NAME = "yoshik-play";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

let cached = null; // { accessToken, exp }

function getRefreshToken() {
  const t = process.env.DRIVE_REFRESH_TOKEN;
  if (!t) throw new Error("drive not connected — set DRIVE_REFRESH_TOKEN env");
  return t;
}

/** Fresh access token, cached in memory until near expiry. */
async function getAccessToken() {
  if (cached && cached.exp > Date.now() + 60000) return cached.accessToken;
  const { id, secret } = clientCreds();
  const refreshToken = await getRefreshToken();
  const params = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) {
    cached = null;
    throw new Error("drive token refresh failed: " + r.status);
  }
  const d = await r.json();
  cached = {
    accessToken: d.access_token,
    exp: Date.now() + (d.expires_in || 3600) * 1000,
  };
  return cached.accessToken;
}

/** True when a refresh token exists and yields a working access token. */
async function checkConnection() {
  try {
    await getAccessToken();
    return true;
  } catch (e) {
    return false;
  }
}

/** Find or create the yoshik-play folder. Returns folderId. */
async function ensureFolder(accessToken) {
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const r = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!r.ok) throw new Error("drive folder search failed: " + r.status);
  const d = await r.json();
  if (d.files && d.files.length) return d.files[0].id;

  const cr = await fetch(`${DRIVE_API}/files`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!cr.ok) throw new Error("drive folder create failed: " + cr.status);
  return (await cr.json()).id;
}

/**
 * Stream a local file to Drive (multipart upload). The file is never
 * loaded fully into memory — parts stream from disk with a fixed
 * Content-Length so Drive accepts the body.
 * Returns { fileId, size }.
 */
async function uploadFile(accessToken, folderId, filename, mimeType, filePath, fileSize) {
  const metadata = { name: filename, parents: [folderId], mimeType };
  const boundary = "----playupload" + Date.now().toString(36);
  const part1 = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const part2 = Buffer.from(`\r\n--${boundary}--`);
  const total = part1.length + fileSize + part2.length;

  async function* parts() {
    yield part1;
    yield* fs.createReadStream(filePath);
    yield part2;
  }

  const r = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,size`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(total),
    },
    body: Readable.from(parts()),
    duplex: "half",
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("drive upload failed: " + r.status + " " + t.slice(0, 200));
  }
  const d = await r.json();
  return { fileId: d.id, size: parseInt(d.size || "0", 10) };
}

/**
 * Get a readable stream for a Drive file, forwarding the client's
 * Range header so seeking works. Streams — never buffered.
 * Returns { stream, status, contentLength, contentRange, mimeType }.
 */
async function getFileStream(accessToken, fileId, rangeHeader) {
  const headers = { Authorization: "Bearer " + accessToken };
  if (rangeHeader) headers.Range = rangeHeader;
  const r = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, { headers });
  if (!r.ok) throw new Error("drive download failed: " + r.status);
  return {
    stream: r.body,
    status: r.status,
    contentLength: r.headers.get("content-length"),
    contentRange: r.headers.get("content-range"),
    mimeType: r.headers.get("content-type"),
  };
}

/** Delete a file from Drive. */
async function deleteFile(accessToken, fileId) {
  const r = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!r.ok && r.status !== 404) throw new Error("drive delete failed: " + r.status);
}

module.exports = {
  getAccessToken,
  checkConnection,
  ensureFolder,
  uploadFile,
  getFileStream,
  deleteFile,
  FOLDER_NAME,
};
