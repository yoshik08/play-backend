/* play backend — private upload-only music library.
 *
 * Audio comes ONLY from Yoshik's Google Drive (folder "yoshik-play"), via the
 * Drive API, backend-only. No YouTube, SoundCloud, yt-dlp, or any other
 * third-party audio fetching exists in this codebase.
 * Spotify/iTunes are metadata-only (names/artwork for the upload matcher).
 * Lyrics: lrcmux first, then LRCLIB, matched by song name + duration.
 * Every route below /api is JWT-gated except /health, /api/search, /api/lyrics.
 */
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ObjectId } = require("mongodb");
const spotify = require("./lib/spotify");
const itunes = require("./lib/itunes");
const { getLyrics } = require("./lib/lyrics");
const { verifyGoogle, loginOrCreate, sign, authRequired, verifyToken } = require("./lib/auth");
const { connect, getDb } = require("./lib/db");
const drive = require("./lib/drive");
const multer = require("multer");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : true }));
app.use(express.json({ limit: "1mb" }));

/* request log (no secrets, no bodies) */
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
  });
  next();
});

/* rate limits */
const apiLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const searchLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });
const streamLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 240 });
const uploadLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 60 });
app.use("/api/", apiLimit);

/* uploads land on disk first, never fully in memory */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, "play-" + Date.now() + "-" + Math.round(Math.random() * 1e9)),
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100mb
});

/* ---------- validation helpers ---------- */
const str = (v, max = 200) => String(v || "").trim().slice(0, max);

/* metadata-only track shape for /api/search (names/artwork for the upload matcher) */
function searchTrack(t) {
  return {
    id: str(t.id, 80),
    title: str(t.title, 200),
    artist: str(t.artist, 200),
    artists: str(t.artists || t.artist, 300),
    album: str(t.album, 200),
    albumArt: str(t.albumArt, 500),
    duration: Math.max(0, Math.min(7200, parseInt(t.duration, 10) || 0)),
    source: t.source === "spotify" ? "spotify" : "itunes",
  };
}

app.get("/health", async (req, res) => {
  const out = { ok: true, ts: Date.now(), deps: {} };
  try {
    await getDb().command({ ping: 1 });
    out.deps.db = { ok: true };
  } catch (e) { out.deps.db = { ok: false, reason: e.message.slice(0, 120) }; }
  try {
    const at = await drive.getAccessToken();
    await drive.ensureFolder(at);
    out.deps.drive = { ok: true, folder: drive.FOLDER_NAME };
  } catch (e) { out.deps.drive = { ok: false, reason: e.message.slice(0, 120) }; }
  try {
    const r = await fetch("https://api.lrcmux.dev/get?artist=coldplay&title=yellow&duration=266",
      { headers: { "User-Agent": "yoshik.xyz/play" }, signal: AbortSignal.timeout(8000) });
    out.deps.lyrics_lrcmux = { ok: r.ok };
  } catch (e) { out.deps.lyrics_lrcmux = { ok: false, reason: e.message.slice(0, 120) }; }
  try {
    const r = await fetch("https://lrclib.net/api/search?q=yellow%20coldplay",
      { headers: { "User-Agent": "yoshik.xyz/play" }, signal: AbortSignal.timeout(8000) });
    out.deps.lyrics_lrclib = { ok: r.ok };
  } catch (e) { out.deps.lyrics_lrclib = { ok: false, reason: e.message.slice(0, 120) }; }
  res.json(out);
});

/* ---------- search: metadata only (names/artwork for the upload matcher) ---------- */
app.get("/api/search", searchLimit, async (req, res) => {
  const q = str(req.query.q, 200);
  if (!q) return res.status(400).json({ error: "q required" });
  try {
    let tracks = [], source = "itunes";
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      try {
        tracks = await spotify.search(q);
        source = "spotify";
      } catch (e) {
        console.log("spotify search failed, falling back to itunes:", e.message);
      }
    }
    if (!tracks.length) tracks = await itunes.search(q);
    res.json({ tracks: tracks.map(searchTrack).filter((t) => t.id), source });
  } catch (e) {
    res.status(502).json({ error: "search unavailable" });
  }
});

/* ---------- lyrics: lrcmux -> lrclib, matched by name + duration ---------- */
app.get("/api/lyrics", async (req, res) => {
  const artist = str(req.query.artist), title = str(req.query.title);
  if (!title) return res.status(400).json({ error: "title required" });
  try {
    const d = await getLyrics(artist, title, parseFloat(req.query.duration) || 0);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json(d);
  } catch (e) {
    res.status(502).json({ error: "lyrics unavailable" });
  }
});

/* ---------- auth ---------- */
app.post("/api/auth/google", async (req, res) => {
  try {
    const profile = await verifyGoogle(str(req.body.credential, 4000));
    const user = await loginOrCreate(profile);
    res.json({ token: sign(user), user: { email: user.email, name: user.name, pic: user.pic } });
  } catch (e) {
    res.status(401).json({ error: "google auth failed" });
  }
});
/* redirect-flow: exchange oauth code for session (reliable on ios) */
app.post("/api/auth/google/code", async (req, res) => {
  try {
    const code = str(req.body.code, 2000);
    const redirectUri = str(req.body.redirectUri, 500);
    if (!code || !redirectUri) return res.status(400).json({ error: "code and redirectUri required" });
    const { OAuth2Client } = require("google-auth-library");
    const client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) return res.status(401).json({ error: "no id token" });
    const profile = await verifyGoogle(tokens.id_token);
    const user = await loginOrCreate(profile);
    res.json({ token: sign(user), user: { email: user.email, name: user.name, pic: user.pic } });
  } catch (e) {
    console.log("google code exchange failed:", e.message);
    res.status(401).json({ error: "google auth failed" });
  }
});
app.get("/api/me", authRequired, (req, res) => {
  res.json({ user: { email: req.user.email, name: req.user.name, pic: req.user.pic } });
});

/* ---------- drive: app-level (Yoshik's Drive), backend only ---------- */
app.get("/api/drive/status", authRequired, async (req, res) => {
  res.json({ connected: await drive.checkConnection(), folder: drive.FOLDER_NAME });
});
/* one-time / reconnect: exchange an offline drive.file code, store refresh token */
app.post("/api/drive/reconnect", authRequired, async (req, res) => {
  try {
    const code = str(req.body.code, 2000);
    const redirectUri = str(req.body.redirectUri, 500);
    if (!code || !redirectUri) return res.status(400).json({ error: "code and redirectUri required" });
    await drive.saveRefreshToken(code, redirectUri);
    res.json({ ok: true, connected: true });
  } catch (e) {
    console.log("drive reconnect failed:", e.message);
    res.status(500).json({ error: "drive reconnect failed: " + e.message.slice(0, 120) });
  }
});

/* ---------- songs: personal library ---------- */
const songsColl = () => getDb().collection("songs");

async function ensureSongIndexes() {
  try {
    await songsColl().createIndex({ userId: 1, createdAt: -1 });
  } catch (e) {}
}
ensureSongIndexes();

function songToJson(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    size: doc.size,
    duration: doc.duration,
    spotifyMatch: doc.spotifyMatch || null,
    lyrics: doc.lyrics ? {
      text: doc.lyrics.text || null,
      source: doc.lyrics.source || null,
      synced: !!doc.lyrics.synced,
    } : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function findSong(req, res, next) {
  let _id;
  try { _id = new ObjectId(req.params.id); }
  catch (e) { return res.status(400).json({ error: "bad id" }); }
  songsColl().findOne({ _id, userId: req.user.uid })
    .then((doc) => {
      if (!doc) return res.status(404).json({ error: "not found" });
      req.song = doc;
      next();
    })
    .catch(() => res.status(500).json({ error: "lookup failed" }));
}

/* JWT for the audio element: Authorization header, or ?token= (audio tags can't set headers) */
function audioAuth(req, res, next) {
  const h = req.headers.authorization || "";
  let t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t && req.query.token) t = String(req.query.token);
  if (!t) return res.status(401).json({ error: "login required" });
  try {
    req.user = verifyToken(t);
    next();
  } catch (e) {
    return res.status(401).json({ error: "bad token" });
  }
}

/* POST /api/songs — upload audio file -> Yoshik's Drive */
app.post("/api/songs", authRequired, uploadLimit, upload.single("audio"), async (req, res) => {
  const tmp = req.file && req.file.path;
  try {
    if (!req.file) return res.status(400).json({ error: "audio file required" });

    const accessToken = await drive.getAccessToken();
    const folderId = await drive.ensureFolder(accessToken);
    const { fileId, size } = await drive.uploadFile(
      accessToken, folderId,
      req.file.originalname, req.file.mimetype || "audio/mpeg",
      req.file.path, req.file.size
    );

    const now = new Date();
    const doc = {
      userId: req.user.uid,
      name: str(req.body.name, 200) || req.file.originalname.replace(/\.[^.]+$/, ""),
      originalFilename: req.file.originalname,
      driveFileId: fileId,
      mimeType: req.file.mimetype,
      size: size || req.file.size,
      duration: parseFloat(req.body.duration) || 0,
      spotifyMatch: null,
      lyrics: null,
      createdAt: now,
      updatedAt: now,
    };
    const r = await songsColl().insertOne(doc);
    res.json(songToJson({ ...doc, _id: r.insertedId }));
  } catch (e) {
    console.log("song upload failed:", e.message);
    res.status(500).json({ error: "upload failed: " + e.message.slice(0, 120) });
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
});

/* GET /api/songs — list my songs */
app.get("/api/songs", authRequired, async (req, res) => {
  const docs = await songsColl().find({ userId: req.user.uid }).sort({ createdAt: -1 }).toArray();
  res.json({ songs: docs.map(songToJson) });
});

/* GET /api/songs/:id — one song (ownership enforced) */
app.get("/api/songs/:id", authRequired, findSong, (req, res) => {
  const out = songToJson(req.song);
  if (req.song.lyrics && req.song.lyrics.rawLrc) out.lyrics.rawLrc = req.song.lyrics.rawLrc;
  res.json(out);
});

/* PATCH /api/songs/:id — rename / metadata */
app.patch("/api/songs/:id", authRequired, findSong, async (req, res) => {
  const updates = {};
  if (req.body.name) updates.name = str(req.body.name, 200);
  if (req.body.spotifyMatch && typeof req.body.spotifyMatch === "object") {
    const m = req.body.spotifyMatch;
    updates.spotifyMatch = {
      title: str(m.title, 200), artist: str(m.artist, 200),
      album: str(m.album, 200), artworkUrl: str(m.artworkUrl, 500),
    };
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: "nothing to update" });
  updates.updatedAt = new Date();
  await songsColl().updateOne({ _id: req.song._id }, { $set: updates });
  const doc = await songsColl().findOne({ _id: req.song._id });
  res.json(songToJson(doc));
});

/* DELETE /api/songs/:id — delete from Drive + Mongo */
app.delete("/api/songs/:id", authRequired, findSong, async (req, res) => {
  try {
    const accessToken = await drive.getAccessToken();
    await drive.deleteFile(accessToken, req.song.driveFileId);
  } catch (e) {
    console.log("drive delete failed (continuing):", e.message);
  }
  await songsColl().deleteOne({ _id: req.song._id });
  res.json({ ok: true });
});

/* GET /api/songs/:id/audio — stream from Drive with Range support.
   Streams chunk-by-chunk; the whole file is never loaded into memory. */
app.get("/api/songs/:id/audio", streamLimit, audioAuth, findSong, async (req, res) => {
  try {
    const accessToken = await drive.getAccessToken();
    const dl = await drive.getFileStream(accessToken, req.song.driveFileId, req.headers.range);

    res.setHeader("Content-Type", dl.mimeType || req.song.mimeType || "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (dl.status === 206) {
      res.status(206);
      if (dl.contentRange) res.setHeader("Content-Range", dl.contentRange);
    }
    if (dl.contentLength) res.setHeader("Content-Length", dl.contentLength);

    const reader = dl.stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((r) => res.once("drain", r));
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (e) {
    console.log("audio stream failed:", e.message);
    if (!res.headersSent) res.status(502).json({ error: "audio unavailable" });
  }
});

/* POST /api/songs/:id/lyrics/refresh — re-fetch lyrics (lrcmux -> lrclib) */
app.post("/api/songs/:id/lyrics/refresh", authRequired, findSong, async (req, res) => {
  try {
    const doc = req.song;
    const artist = (doc.spotifyMatch && doc.spotifyMatch.artist) || "";
    const title = (doc.spotifyMatch && doc.spotifyMatch.title) || doc.name;
    const result = await getLyrics(artist, title, doc.duration);
    const lyrics = { text: null, source: null, synced: false, rawLrc: null };
    if (result && result.source !== "none") {
      lyrics.source = result.source;
      lyrics.synced = !!result.wordSync;
      if (result.lines && result.lines.length) {
        lyrics.rawLrc = result.lines.map((l) => {
          const m = Math.floor(l.time / 60000), s = ((l.time % 60000) / 1000).toFixed(2).padStart(5, "0");
          return `[${String(m).padStart(2, "0")}:${s}]${l.text}`;
        }).join("\n");
        lyrics.text = result.lines.map((l) => l.text).join("\n");
      } else if (result.plain) {
        lyrics.text = result.plain;
      }
    }
    await songsColl().updateOne({ _id: doc._id }, { $set: { lyrics, updatedAt: new Date() } });
    const out = { ...lyrics };
    delete out.rawLrc;
    res.json({ lyrics: out });
  } catch (e) {
    console.log("lyrics refresh failed:", e.message);
    res.status(500).json({ error: "lyrics refresh failed" });
  }
});

/* ---------- preferences ---------- */
const PREF_DEFAULTS = { volume: 0.8, shuffle: false, repeat: "off", motion: "auto" };
app.get("/api/preferences", authRequired, async (req, res) => {
  const doc = await getDb().collection("user_preferences").findOne({ owner: req.user.uid });
  res.json({ preferences: { ...PREF_DEFAULTS, ...(doc ? doc.prefs : {}) } });
});
app.put("/api/preferences", authRequired, async (req, res) => {
  const p = req.body.preferences;
  if (!p || typeof p !== "object") return res.status(400).json({ error: "preferences required" });
  const clean = {};
  if (typeof p.volume === "number") clean.volume = Math.max(0, Math.min(1, p.volume));
  if (typeof p.shuffle === "boolean") clean.shuffle = p.shuffle;
  if (["off", "all", "one"].includes(p.repeat)) clean.repeat = p.repeat;
  if (["auto", "on", "off"].includes(p.motion)) clean.motion = p.motion;
  await getDb().collection("user_preferences").updateOne(
    { owner: req.user.uid },
    { $set: { prefs: clean, updatedAt: new Date() }, $setOnInsert: { owner: req.user.uid } },
    { upsert: true });
  res.json({ ok: true });
});

/* ---------- errors ---------- */
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((err, req, res, next) => {
  console.log("unhandled:", err.message);
  res.status(500).json({ error: "internal error" });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  connect().then(() => {
    app.listen(PORT, () => console.log("play backend on :" + PORT));
  }).catch((e) => {
    console.error("db connect failed:", e.message);
    process.exit(1);
  });
}
module.exports = app;
