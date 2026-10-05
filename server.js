const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const { ObjectId } = require("mongodb");
const spotify = require("./lib/spotify");
const itunes = require("./lib/itunes");
const audioService = require("./lib/audio-service");
const { getLyrics } = require("./lib/lyrics");
const { verifyGoogle, loginOrCreate, sign, authRequired } = require("./lib/auth");
const { connect, getDb } = require("./lib/db");

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
const dlLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use("/api/", apiLimit);

/* ---------- validation helpers ---------- */
const str = (v, max = 200) => String(v || "").trim().slice(0, max);
const oid = (v) => { try { return new ObjectId(String(v)); } catch (e) { return null; } };
function cleanTrack(t) {
  if (!t || typeof t !== "object") return null;
  const id = str(t.id, 80);
  if (!id) return null;
  return {
    id,
    title: str(t.title, 200),
    artist: str(t.artist, 200),
    artists: str(t.artists || t.artist, 300),
    album: str(t.album, 200),
    albumArt: str(t.albumArt, 500),
    duration: Math.max(0, Math.min(7200, parseInt(t.duration, 10) || 0)),
    externalId: str(t.externalId, 80),
    source: t.source === "spotify" ? "spotify" : "itunes",
  };
}

app.get("/health", async (req, res) => {
  const out = { ok: true, ts: Date.now(), deps: {} };
  // database
  try {
    const db = getDb();
    await db.command({ ping: 1 });
    out.deps.db = { ok: true };
  } catch (e) { out.deps.db = { ok: false, reason: e.message.slice(0, 120) }; }
  // music metadata (spotify)
  try {
    await spotify.search("test", "track", 1);
    out.deps.music = { ok: true, provider: "spotify" };
  } catch (e) { out.deps.music = { ok: false, reason: e.message.slice(0, 120) }; }
  // audio providers
  try {
    out.deps.audio = await audioService.checkHealth();
  } catch (e) { out.deps.audio = { ok: false, reason: e.message.slice(0, 120) }; }
  // lyrics (lrcmux probe)
  try {
    const r = await fetch("https://lrcmux.com/api/lyrics?artist=coldplay&title=yellow", { signal: AbortSignal.timeout(8000) });
    out.deps.lyrics = { ok: r.ok, provider: "lrcmux" };
  } catch (e) { out.deps.lyrics = { ok: false, reason: e.message.slice(0, 120) }; }
  // ffmpeg
  try {
    const { execFile } = require("child_process");
    await new Promise((ok, no) => execFile("ffmpeg", ["-version"], { timeout: 5000 }, (e) => e ? no(e) : ok()));
    out.deps.ffmpeg = { ok: true };
  } catch (e) { out.deps.ffmpeg = { ok: false, reason: "not found" }; }
  res.json(out);
});

/* ---------- search: spotify if creds exist, else itunes ---------- */
app.get("/api/search", searchLimit, async (req, res) => {
  const q = str(req.query.q, 200);
  if (!q) return res.status(400).json({ error: "q required" });
  try {
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      try {
        return res.json({ tracks: await spotify.search(q), source: "spotify" });
      } catch (e) {
        console.log("spotify search failed, falling back to itunes:", e.message);
      }
    }
    res.json({ tracks: await itunes.search(q), source: "itunes" });
  } catch (e) {
    res.status(502).json({ error: "search unavailable" });
  }
});

/* ---------- metadata provider abstraction ---------- */
function providerFor(id) {
  return String(id || "").startsWith("sp:") ? spotify : itunes;
}
function stripPrefix(id) {
  return String(id || "").replace(/^(sp|it):(al:|ar:)?/, "");
}
app.get("/api/track/:id", async (req, res) => {
  const id = stripPrefix(req.params.id);
  try {
    const t = await providerFor(req.params.id).getTrack
      ? await providerFor(req.params.id).getTrack(id)
      : null;
    if (!t) return res.status(404).json({ error: "not found" });
    res.json({ track: t });
  } catch (e) {
    res.status(502).json({ error: "track unavailable" });
  }
});
app.get("/api/album/:id", async (req, res) => {
  try {
    res.json({ album: await providerFor(req.params.id).getAlbum(stripPrefix(req.params.id)) });
  } catch (e) {
    res.status(502).json({ error: "album unavailable" });
  }
});
app.get("/api/artist/:id", async (req, res) => {
  try {
    res.json({ artist: await providerFor(req.params.id).getArtist(stripPrefix(req.params.id)) });
  } catch (e) {
    res.status(502).json({ error: "artist unavailable" });
  }
});

/* ---------- audio: GET /api/audio/:trackId ----------
   resolves via AudioProvider, streams audio with byte-range support.
   the frontend player only knows this endpoint. */
app.get("/api/audio/:trackId", dlLimit, async (req, res) => {
  const trackId = str(req.params.trackId, 100);
  if (!trackId) return res.status(400).json({ error: "trackId required" });

  let result = null;
  try {
    result = await audioService.getAudio(trackId);
  } catch (e) {
    console.log("audio resolve failed:", trackId, e.message);
    return res.status(502).json({ error: "playback unavailable for this track", reason: "resolve failed" });
  }

  const { track, src } = result;
  if (!src.available) {
    console.log("audio unavailable:", trackId, src.reason);
    return res.status(502).json({ error: "playback unavailable for this track", reason: src.reason, stage: src.stage });
  }

  // file-based source (youtube provider): stream from disk with ranges
  if (src.filePath) {
    let stat;
    try { stat = fs.statSync(src.filePath); }
    catch (e) { src.cleanup && src.cleanup(); return res.status(502).json({ error: "audio file lost" }); }
    const total = stat.size;
    const range = req.headers.range;
    res.setHeader("Content-Type", src.mimeType || "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Audio-Provider", src.provider);
    if (src.isPreview) res.setHeader("X-Audio-Preview", "1");

    const cleanup = () => { try { src.cleanup && src.cleanup(); } catch (e) {} };
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (!m) { cleanup(); return res.status(416).end(); }
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || isNaN(end) || start >= total || end >= total || start > end) {
        cleanup(); res.setHeader("Content-Range", `bytes */${total}`); return res.status(416).end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", end - start + 1);
      const stream = fs.createReadStream(src.filePath, { start, end });
      stream.on("close", cleanup); stream.on("error", cleanup);
      return stream.pipe(res);
    }
    res.setHeader("Content-Length", total);
    const stream = fs.createReadStream(src.filePath);
    stream.on("close", cleanup); stream.on("error", cleanup);
    return stream.pipe(res);
  }

  // url-based source (spotify preview): redirect to the cdn url.
  // the browser fetches directly; spotify's cdn supports ranges.
  if (src.url) {
    res.setHeader("X-Audio-Provider", src.provider);
    if (src.isPreview) res.setHeader("X-Audio-Preview", "1");
    return res.redirect(302, src.url);
  }

  return res.status(502).json({ error: "playback unavailable for this track", reason: "no usable source" });
});

/* ---------- audio diagnostics: proves exactly which stage fails ---------- */
app.get("/api/audio/debug/:trackId", async (req, res) => {
  const trackId = str(req.params.trackId, 100);
  const out = { trackId, stages: {} };
  const t0 = Date.now();
  try {
    // 1. track exists
    const track = await audioService.resolveTrack(trackId);
    out.stages.track = { ok: true, title: track.title, artist: track.artist, source: track.source };
    // 2-5. provider resolution per provider
    out.stages.providers = {};
    for (const p of audioService.provider.providers) {
      const s0 = Date.now();
      try {
        const src = await p.getPlayableSource(track);
        out.stages.providers[p.name] = {
          ok: src.available,
          ms: Date.now() - s0,
          reason: src.available ? null : src.reason,
          stage: src.stage || null,
          mimeType: src.mimeType || null,
          isPreview: !!src.isPreview,
        };
      } catch (e) {
        out.stages.providers[p.name] = { ok: false, ms: Date.now() - s0, reason: "threw: " + e.message.slice(0, 200) };
      }
    }
  } catch (e) {
    out.stages.track = { ok: false, reason: e.message.slice(0, 200) };
  }
  out.ms = Date.now() - t0;
  res.json(out);
});

/* ---------- lyrics ---------- */
app.get("/api/lyrics", async (req, res) => {
  const artist = str(req.query.artist), title = str(req.query.title);
  if (!artist || !title) return res.status(400).json({ error: "artist and title required" });
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

/* ---------- drive oauth ---------- */
const drive = require("./lib/drive");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100mb

app.post("/api/auth/google/drive", authRequired, async (req, res) => {
  try {
    const code = str(req.body.code, 2000);
    const redirectUri = str(req.body.redirectUri, 500);
    if (!code) return res.status(400).json({ error: "code required" });
    const tokens = await drive.exchangeCode(code, redirectUri);
    const update = { driveConnectedAt: new Date() };
    if (tokens.refreshToken) update.driveRefresh = tokens.refreshToken;
    await getDb().collection("users").updateOne(
      { _id: new ObjectId(req.user.uid) },
      { $set: update }
    );
    res.json({ ok: true, connected: true });
  } catch (e) {
    console.log("drive connect failed:", e.message);
    res.status(500).json({ error: "drive connect failed" });
  }
});

app.get("/api/drive/status", authRequired, async (req, res) => {
  res.json({ connected: await drive.isConnected(req.user.uid) });
});

/* ---------- songs: personal library ---------- */
const songsColl = () => getDb().collection("songs");

// ensure index
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

// POST /api/songs — upload audio file
app.post("/api/songs", authRequired, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "audio file required" });
    const uid = req.user.uid;

    // drive must be connected
    const accessToken = await drive.getAccessToken(uid);
    const folderId = await drive.ensureFolder(accessToken);

    // upload to drive
    const { fileId, size } = await drive.uploadFile(
      accessToken, folderId,
      req.file.originalname, req.file.mimetype, req.file.buffer
    );

    // create song doc (metadata only, no spotify/lyrics yet — frontend does naming flow)
    const now = new Date();
    const doc = {
      userId: uid,
      name: req.body.name || req.file.originalname.replace(/\.[^.]+$/, ""),
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
    res.status(500).json({ error: "upload failed: " + e.message.slice(0, 100) });
  }
});

// GET /api/songs — list user's songs
app.get("/api/songs", authRequired, async (req, res) => {
  const docs = await songsColl().find({ userId: req.user.uid }).sort({ createdAt: -1 }).toArray();
  res.json({ songs: docs.map(songToJson) });
});

// GET /api/songs/:id — get one (ownership enforced)
app.get("/api/songs/:id", authRequired, async (req, res) => {
  let doc;
  try {
    doc = await songsColl().findOne({ _id: new ObjectId(req.params.id), userId: req.user.uid });
  } catch (e) { return res.status(400).json({ error: "bad id" }); }
  if (!doc) return res.status(404).json({ error: "not found" });
  // include full lyrics for detail view
  const out = songToJson(doc);
  if (doc.lyrics && doc.lyrics.rawLrc) out.lyrics.rawLrc = doc.lyrics.rawLrc;
  res.json(out);
});

// PATCH /api/songs/:id — rename / update metadata
app.patch("/api/songs/:id", authRequired, async (req, res) => {
  const updates = {};
  if (req.body.name) updates.name = str(req.body.name, 200);
  if (req.body.spotifyMatch) updates.spotifyMatch = req.body.spotifyMatch;
  if (req.body.lyrics) updates.lyrics = req.body.lyrics;
  if (!Object.keys(updates).length) return res.status(400).json({ error: "nothing to update" });
  updates.updatedAt = new Date();

  let r;
  try {
    r = await songsColl().findOneAndUpdate(
      { _id: new ObjectId(req.params.id), userId: req.user.uid },
      { $set: updates },
      { returnDocument: "after" }
    );
  } catch (e) { return res.status(400).json({ error: "bad id" }); }
  if (!r.value) return res.status(404).json({ error: "not found" });
  res.json(songToJson(r.value));
});

// DELETE /api/songs/:id — delete from drive + mongo
app.delete("/api/songs/:id", authRequired, async (req, res) => {
  let doc;
  try {
    doc = await songsColl().findOne({ _id: new ObjectId(req.params.id), userId: req.user.uid });
  } catch (e) { return res.status(400).json({ error: "bad id" }); }
  if (!doc) return res.status(404).json({ error: "not found" });

  // delete from drive
  try {
    const accessToken = await drive.getAccessToken(req.user.uid);
    await drive.deleteFile(accessToken, doc.driveFileId);
  } catch (e) {
    console.log("drive delete failed (continuing):", e.message);
  }
  await songsColl().deleteOne({ _id: doc._id });
  res.json({ ok: true });
});

// GET /api/songs/:id/audio — stream with range support (ownership enforced)
app.get("/api/songs/:id/audio", authRequired, async (req, res) => {
  let doc;
  try {
    doc = await songsColl().findOne({ _id: new ObjectId(req.params.id), userId: req.user.uid });
  } catch (e) { return res.status(400).json({ error: "bad id" }); }
  if (!doc) return res.status(404).json({ error: "not found" });

  try {
    const accessToken = await drive.getAccessToken(req.user.uid);
    const range = req.headers.range;
    const dl = await drive.getFileStream(accessToken, doc.driveFileId, range);

    res.setHeader("Content-Type", dl.mimeType || doc.mimeType || "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (dl.status === 206) {
      res.status(206);
      if (dl.contentRange) res.setHeader("Content-Range", dl.contentRange);
    }
    if (dl.contentLength) res.setHeader("Content-Length", dl.contentLength);

    // pipe web stream to express response
    const reader = dl.stream.getReader();
    try {
      while (true) {
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

// POST /api/songs/:id/lyrics/refresh — re-fetch lyrics
app.post("/api/songs/:id/lyrics/refresh", authRequired, async (req, res) => {
  let doc;
  try {
    doc = await songsColl().findOne({ _id: new ObjectId(req.params.id), userId: req.user.uid });
  } catch (e) { return res.status(400).json({ error: "bad id" }); }
  if (!doc) return res.status(404).json({ error: "not found" });

  try {
    const { getLyrics } = require("./lib/lyrics");
    const artist = (doc.spotifyMatch && doc.spotifyMatch.artist) || "";
    const title = (doc.spotifyMatch && doc.spotifyMatch.title) || doc.name;
    const result = await getLyrics(artist, title, doc.duration);
    let lyrics = { text: null, source: null, synced: false, rawLrc: null };
    if (result && result.source !== "none") {
      lyrics.source = result.source;
      lyrics.synced = !!result.wordSync;
      if (result.lines && result.lines.length) {
        // store as LRC text for the player
        lyrics.rawLrc = result.lines.map((l) => {
          const m = Math.floor(l.time / 60), s = (l.time % 60).toFixed(2).padStart(5, "0");
          return `[${String(m).padStart(2, "0")}:${s}]${l.text}`;
        }).join("\n");
        lyrics.text = result.lines.map((l) => l.text).join("\n");
      } else if (result.plain) {
        lyrics.text = result.plain;
      }
    }
    await songsColl().updateOne({ _id: doc._id }, { $set: { lyrics, updatedAt: new Date() } });
    const out = { ...lyrics };
    delete out.rawLrc; // don't send raw in list, detail endpoint includes it
    res.json({ lyrics: out });
  } catch (e) {
    console.log("lyrics refresh failed:", e.message);
    res.status(500).json({ error: "lyrics refresh failed" });
  }
});

/* ---------- liked songs ---------- */
app.get("/api/liked", authRequired, async (req, res) => {
  const docs = await getDb().collection("liked").find({ owner: req.user.uid }).sort({ at: -1 }).toArray();
  res.json({ tracks: docs.map((d) => d.track) });
});
app.post("/api/liked", authRequired, async (req, res) => {
  const track = cleanTrack(req.body.track);
  if (!track) return res.status(400).json({ error: "valid track required" });
  await getDb().collection("liked").updateOne(
    { owner: req.user.uid, trackId: track.id },
    { $set: { track, at: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
});
app.delete("/api/liked/:id", authRequired, async (req, res) => {
  await getDb().collection("liked").deleteOne({ owner: req.user.uid, trackId: str(req.params.id, 80) });
  res.json({ ok: true });
});

/* ---------- playlists ---------- */
app.get("/api/playlists", authRequired, async (req, res) => {
  const docs = await getDb().collection("playlists").find({ owner: req.user.uid }).sort({ updatedAt: -1 }).toArray();
  res.json({ playlists: docs });
});
app.post("/api/playlists", authRequired, async (req, res) => {
  const name = str(req.body.name, 80) || "new playlist";
  const r = await getDb().collection("playlists").insertOne({
    owner: req.user.uid, name, tracks: [], createdAt: new Date(), updatedAt: new Date(),
  });
  res.json({ id: String(r.insertedId) });
});
app.put("/api/playlists/:id", authRequired, async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: "bad id" });
  const name = str(req.body.name, 80);
  if (!name) return res.status(400).json({ error: "name required" });
  const r = await getDb().collection("playlists").updateOne(
    { _id, owner: req.user.uid }, { $set: { name, updatedAt: new Date() } });
  if (!r.matchedCount) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
app.get("/api/playlists/:id", authRequired, async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: "bad id" });
  const doc = await getDb().collection("playlists").findOne({ _id, owner: req.user.uid });
  if (!doc) return res.status(404).json({ error: "not found" });
  res.json({ playlist: doc });
});
app.post("/api/playlists/:id/tracks", authRequired, async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: "bad id" });
  const track = cleanTrack(req.body.track);
  if (!track) return res.status(400).json({ error: "valid track required" });
  /* product rule: no duplicate tracks in a playlist — re-adding moves it to the end */
  await getDb().collection("playlists").updateOne(
    { _id, owner: req.user.uid },
    { $pull: { tracks: { id: track.id } } });
  const r = await getDb().collection("playlists").updateOne(
    { _id, owner: req.user.uid },
    { $push: { tracks: track }, $set: { updatedAt: new Date() } });
  if (!r.matchedCount) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
app.delete("/api/playlists/:id/tracks/:trackId", authRequired, async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: "bad id" });
  await getDb().collection("playlists").updateOne(
    { _id, owner: req.user.uid },
    { $pull: { tracks: { id: str(req.params.trackId, 80) } }, $set: { updatedAt: new Date() } });
  res.json({ ok: true });
});
/* reorder: move track to new index */
app.put("/api/playlists/:id/tracks/reorder", authRequired, async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: "bad id" });
  const { trackId, toIndex } = req.body;
  const doc = await getDb().collection("playlists").findOne({ _id, owner: req.user.uid });
  if (!doc) return res.status(404).json({ error: "not found" });
  const tracks = doc.tracks || [];
  const from = tracks.findIndex((t) => t.id === str(trackId, 80));
  const to = Math.max(0, Math.min(tracks.length - 1, parseInt(toIndex, 10) || 0));
  if (from < 0) return res.status(400).json({ error: "track not in playlist" });
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved);
  await getDb().collection("playlists").updateOne(
    { _id, owner: req.user.uid }, { $set: { tracks, updatedAt: new Date() } });
  res.json({ ok: true });
});
app.delete("/api/playlists/:id", authRequired, async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: "bad id" });
  await getDb().collection("playlists").deleteOne({ _id, owner: req.user.uid });
  res.json({ ok: true });
});

/* ---------- play history ---------- */
/* record only meaningful plays: >=30s or >=50% of duration. dedup: one row per track per hour. */
app.post("/api/history", authRequired, async (req, res) => {
  const track = cleanTrack(req.body.track);
  const playedSec = Math.max(0, parseFloat(req.body.playedSec) || 0);
  if (!track) return res.status(400).json({ error: "valid track required" });
  const dur = track.duration || 0;
  const meaningful = playedSec >= 30 || (dur > 0 && playedSec >= dur * 0.5);
  if (!meaningful) return res.json({ ok: true, recorded: false });
  const col = getDb().collection("play_history");
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  const recent = await col.findOne({ owner: req.user.uid, trackId: track.id, at: { $gte: hourAgo } });
  if (recent) return res.json({ ok: true, recorded: false, deduped: true });
  await col.insertOne({ owner: req.user.uid, trackId: track.id, track, at: new Date(), playedSec: Math.round(playedSec) });
  res.json({ ok: true, recorded: true });
});
app.get("/api/history", authRequired, async (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const docs = await getDb().collection("play_history")
    .find({ owner: req.user.uid }).sort({ at: -1 }).limit(limit).toArray();
  /* collapse to unique tracks, most recent first */
  const seen = new Set(), tracks = [];
  docs.forEach((d) => { if (!seen.has(d.trackId)) { seen.add(d.trackId); tracks.push(d.track); } });
  res.json({ tracks });
});

/* ---------- preferences ---------- */
const PREF_DEFAULTS = { volume: 0.8, shuffle: false, repeat: "off", motion: "auto", qualityNote: true };
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
