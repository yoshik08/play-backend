/**
 * Google Drive storage for personal audio library.
 *
 * Uses OAuth2 with drive.file scope — app only sees files it created.
 * Files stay private in the user's Drive under "yoshik-play" folder.
 *
 * Token flow:
 * - frontend gets auth code via GIS code client (drive.file scope)
 * - backend exchanges code -> access_token + refresh_token
 * - refresh_token stored in MongoDB (users.driveRefresh)
 * - uploads/downloads use fresh access tokens via refresh
 */
const { getDb } = require("./db");

const FOLDER_NAME = "yoshik-play";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/**
 * Exchange authorization code for tokens.
 * @returns {Promise<{accessToken, refreshToken, expiresIn}>}
 */
async function exchangeCode(code, redirectUri) {
  const params = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("token exchange failed: " + r.status + " " + t.slice(0, 200));
  }
  const d = await r.json();
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token, // only on first consent
    expiresIn: d.expires_in,
  };
}

/**
 * Get a fresh access token for a user via their stored refresh token.
 */
async function getAccessToken(uid) {
  const db = getDb();
  const user = await db.collection("users").findOne(
    { _id: new (require("mongodb").ObjectId)(uid) },
    { projection: { driveRefresh: 1 } }
  );
  if (!user || !user.driveRefresh) {
    throw new Error("drive not connected — reconnect google drive");
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: user.driveRefresh,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) throw new Error("drive token refresh failed: " + r.status);
  const d = await r.json();
  return d.access_token;
}

/**
 * Find or create the yoshik-play folder. Returns folderId.
 */
async function ensureFolder(accessToken) {
  // search for existing
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const r = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!r.ok) throw new Error("drive folder search failed: " + r.status);
  const d = await r.json();
  if (d.files && d.files.length) return d.files[0].id;

  // create
  const cr = await fetch(`${DRIVE_API}/files`, {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!cr.ok) throw new Error("drive folder create failed: " + cr.status);
  const cd = await cr.json();
  return cd.id;
}

/**
 * Upload a file buffer to Drive. Returns { fileId, size }.
 */
async function uploadFile(accessToken, folderId, filename, mimeType, buffer) {
  const metadata = { name: filename, parents: [folderId], mimeType };
  const boundary = "----playupload" + Date.now();

  // multipart upload
  const part1 = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const part2 = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([part1, buffer, part2]);

  const r = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,size`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": body.length,
    },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("drive upload failed: " + r.status + " " + t.slice(0, 200));
  }
  const d = await r.json();
  return { fileId: d.id, size: parseInt(d.size || "0", 10) };
}

/**
 * Get a readable stream for a Drive file, with optional range.
 * Returns { stream, contentLength, contentRange, mimeType }.
 */
async function getFileStream(accessToken, fileId, rangeHeader) {
  const headers = { Authorization: "Bearer " + accessToken };
  if (rangeHeader) headers.Range = rangeHeader;

  const r = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, { headers });
  if (!r.ok) throw new Error("drive download failed: " + r.status);

  return {
    stream: r.body, // web readable stream
    status: r.status,
    contentLength: r.headers.get("content-length"),
    contentRange: r.headers.get("content-range"),
    acceptRanges: r.headers.get("accept-ranges"),
    mimeType: r.headers.get("content-type"),
  };
}

/**
 * Delete a file from Drive.
 */
async function deleteFile(accessToken, fileId) {
  const r = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!r.ok && r.status !== 404) throw new Error("drive delete failed: " + r.status);
}

/**
 * Check if user has Drive connected.
 */
async function isConnected(uid) {
  const db = getDb();
  const user = await db.collection("users").findOne(
    { _id: new (require("mongodb").ObjectId)(uid) },
    { projection: { driveRefresh: 1 } }
  );
  return !!(user && user.driveRefresh);
}

module.exports = {
  exchangeCode,
  getAccessToken,
  ensureFolder,
  uploadFile,
  getFileStream,
  deleteFile,
  isConnected,
  FOLDER_NAME,
};
