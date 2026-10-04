const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const { ObjectId } = require("mongodb");
const spotify = require("./lib/spotify");
const itunes = require("./lib/itunes");
const { downloadMp3 } = require("./lib/getmp3");
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

app.get("/health", (req, res) => res.json({ ok: true }));

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

/* ---------- getmp3: download + stream the mp3 back (transient, tmp cleaned) ---------- */
app.get("/api/getmp3", dlLimit, async (req, res) => {
  const q = str(req.query.q, 300);
  if (!q) return res.status(400).json({ error: "q required" });
  let dl = null;
  try {
    dl = await downloadMp3(q);
    const stat = fs.statSync(dl.path);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "public, max-age=31536000");
    const stream = fs.createReadStream(dl.path);
    stream.on("close", () => dl.cleanup());
    stream.on("error", () => dl.cleanup());
    stream.pipe(res);
  } catch (e) {
    if (dl) dl.cleanup();
    console.log("getmp3 failed:", e.message);
    res.status(502).json({ error: "playback unavailable for this track" });
  }
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
app.get("/api/me", authRequired, (req, res) => {
  res.json({ user: { email: req.user.email, name: req.user.name, pic: req.user.pic } });
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
