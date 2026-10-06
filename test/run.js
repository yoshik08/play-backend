// api tests: node test/run.js
// spins up the app with an in-memory mongo stub + drive stub. no framework.
process.env.MONGODB_URI = "stub";
process.env.JWT_SECRET = "test-secret";
process.env.GOOGLE_CLIENT_ID = "test.apps.googleusercontent.com";

const Module = require("module");
const stubPath = require.resolve("./mongo-stub");
require.cache[stubPath] = { exports: require("./mongo-stub") };

// drive stub: no network, no google
const driveStub = {
  FOLDER_NAME: "yoshik-play",
  async saveRefreshToken() { return true; },
  async getAccessToken() { return "stub-access"; },
  async checkConnection() { return true; },
  async ensureFolder() { return "folder123"; },
  async uploadFile(at, folderId, filename, mimeType, filePath, fileSize) {
    return { fileId: "drive123", size: fileSize };
  },
  async getFileStream(at, fileId, rangeHeader) {
    const bytes = new TextEncoder().encode("FAKEAUDIO".repeat(1000));
    let status = 200, contentRange = null, body = bytes;
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : bytes.length - 1;
      body = bytes.slice(start, end + 1);
      status = 206;
      contentRange = `bytes ${start}-${end}/${bytes.length}`;
    }
    return {
      stream: new ReadableStream({
        start(c) { c.enqueue(body); c.close(); },
      }),
      status,
      contentLength: String(body.length),
      contentRange,
      mimeType: "audio/mpeg",
    };
  },
  async deleteFile() {},
};

// force lib/db and lib/drive to resolve to the stubs
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "./lib/db" || id === "../lib/db" || id.endsWith("lib/db")) {
    return require("./mongo-stub");
  }
  if (id === "./lib/drive" || id === "../lib/drive" || id.endsWith("lib/drive")) {
    return driveStub;
  }
  return origRequire.apply(this, arguments);
};

const jwt = require("jsonwebtoken");
const app = require("../server.js");

const PORT = 4317;
let server, passed = 0, failed = 0, skipped = 0;
const results = [];

async function req(method, path, body, token, form) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  let r;
  if (form) {
    r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: form });
  } else {
    headers["Content-Type"] = "application/json";
    r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  let json = null;
  try { json = await r.json(); } catch (e) {}
  return { status: r.status, json, headers: r.headers };
}

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; results.push("ok   " + name); })
    .catch((e) => { failed++; results.push("FAIL " + name + " — " + e.message); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
const uid = "user123";
const token = jwt.sign({ uid, email: "t@t.com", name: "t", pic: "" }, "test-secret");
const token2 = jwt.sign({ uid: "user999", email: "o@o.com", name: "o", pic: "" }, "test-secret");

async function main() {
  server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 300));

  await t("health", async () => {
    const r = await req("GET", "/health");
    assert(r.status === 200 && r.json.ok, "health not ok");
    assert(r.json.deps.db && r.json.deps.drive, "missing deps");
  });

  await t("protected routes 401 without token", async () => {
    for (const [m, p] of [["GET", "/api/me"], ["GET", "/api/preferences"], ["GET", "/api/songs"], ["GET", "/api/drive/status"]]) {
      const r = await req(m, p);
      assert(r.status === 401, `${m} ${p} → ${r.status}, want 401`);
    }
  });

  await t("bad token 401", async () => {
    const r = await req("GET", "/api/me", null, "garbage");
    assert(r.status === 401, "want 401");
  });

  await t("me works with token", async () => {
    const r = await req("GET", "/api/me", null, token);
    assert(r.status === 200 && r.json.user.email === "t@t.com", "me failed");
  });

  let songId;
  await t("songs: upload (multipart)", async () => {
    const form = new FormData();
    form.append("audio", new Blob(["FAKEAUDIO".repeat(100)], { type: "audio/mpeg" }), "test.mp3");
    form.append("duration", "12.5");
    form.append("name", "Test Song");
    const r = await req("POST", "/api/songs", null, token, form);
    assert(r.status === 200, "upload failed: " + r.status + " " + JSON.stringify(r.json));
    assert(r.json.id && r.json.name === "Test Song", "bad song json");
    assert(r.json.duration === 12.5, "duration not stored");
    songId = r.json.id;
  });

  await t("songs: list + get (ownership)", async () => {
    const l = await req("GET", "/api/songs", null, token);
    assert(l.json.songs.length === 1 && l.json.songs[0].id === songId, "list wrong");
    const g = await req("GET", "/api/songs/" + songId, null, token);
    assert(g.status === 200 && g.json.name === "Test Song", "get failed");
    const other = await req("GET", "/api/songs/" + songId, null, token2);
    assert(other.status === 404, "cross-user read should 404, got " + other.status);
  });

  await t("songs: patch rename", async () => {
    const r = await req("PATCH", "/api/songs/" + songId, { name: "Renamed" }, token);
    assert(r.status === 200 && r.json.name === "Renamed", "rename failed");
    const other = await req("PATCH", "/api/songs/" + songId, { name: "Hacked" }, token2);
    assert(other.status === 404, "cross-user patch should 404");
  });

  await t("songs: audio stream 200 + 206 range, auth required", async () => {
    const noAuth = await req("GET", `/api/songs/${songId}/audio`);
    assert(noAuth.status === 401, "audio without token should 401, got " + noAuth.status);
    const full = await fetch(`http://127.0.0.1:${PORT}/api/songs/${songId}/audio?token=${token}`);
    assert(full.status === 200, "audio 200 failed: " + full.status);
    assert(full.headers.get("accept-ranges") === "bytes", "missing accept-ranges");
    const buf = Buffer.from(await full.arrayBuffer());
    assert(buf.length === 9000, "full body wrong length: " + buf.length);
    const part = await fetch(`http://127.0.0.1:${PORT}/api/songs/${songId}/audio?token=${token}`,
      { headers: { Range: "bytes=0-99" } });
    assert(part.status === 206, "range should 206, got " + part.status);
    assert(part.headers.get("content-range") === "bytes 0-99/9000", "bad content-range");
    const pbuf = Buffer.from(await part.arrayBuffer());
    assert(pbuf.length === 100, "range body wrong length");
  });

  await t("songs: delete removes doc", async () => {
    const other = await req("DELETE", "/api/songs/" + songId, null, token2);
    assert(other.status === 404, "cross-user delete should 404");
    const r = await req("DELETE", "/api/songs/" + songId, null, token);
    assert(r.status === 200 && r.json.ok, "delete failed");
    const g = await req("GET", "/api/songs/" + songId, null, token);
    assert(g.status === 404, "song should be gone");
  });

  await t("songs: bad id → 400", async () => {
    const r = await req("GET", "/api/songs/not-an-objectid", null, token);
    assert(r.status === 400, "want 400, got " + r.status);
  });

  await t("drive status (stubbed)", async () => {
    const r = await req("GET", "/api/drive/status", null, token);
    assert(r.status === 200 && r.json.connected === true, "drive status wrong");
  });

  await t("preferences: defaults + validation", async () => {
    let g = await req("GET", "/api/preferences", null, token);
    assert(g.json.preferences.volume === 0.8, "defaults wrong");
    await req("PUT", "/api/preferences", { preferences: { volume: 0.5, repeat: "all", bogus: 1 } }, token);
    g = await req("GET", "/api/preferences", null, token);
    assert(g.json.preferences.volume === 0.5 && g.json.preferences.repeat === "all" && !("bogus" in g.json.preferences), "prefs wrong");
    const bad = await req("PUT", "/api/preferences", {}, token);
    assert(bad.status === 400, "want 400 for missing prefs");
  });

  await t("search: metadata-only shape (no audio fields)", async () => {
    try {
      const r = await req("GET", "/api/search?q=coldplay%20yellow");
      assert(r.status === 200 && Array.isArray(r.json.tracks) && r.json.tracks.length > 0, "no tracks");
      const t0 = r.json.tracks[0];
      for (const k of ["id", "title", "artist", "album", "albumArt", "duration", "source"]) {
        assert(k in t0, "missing key " + k);
      }
      assert(!("previewUrl" in t0) && !("audioAvailable" in t0), "audio fields leaked into search");
    } catch (e) {
      if (e.message.includes("fetch failed")) { skipped++; results.push("skip search (no network)"); return; }
      throw e;
    }
  });

  await t("lyrics: shape", async () => {
    try {
      const r = await req("GET", "/api/lyrics?artist=Coldplay&title=Yellow&duration=266");
      assert(r.status === 200, "lyrics status " + r.status);
      assert("source" in r.json, "no source");
      if (r.json.lines) assert(Array.isArray(r.json.lines) && r.json.lines[0].time !== undefined, "bad lines");
    } catch (e) {
      if (e.message.includes("fetch failed")) { skipped++; results.push("skip lyrics (no network)"); return; }
      throw e;
    }
  });

  await t("removed provider routes are gone", async () => {
    for (const p of ["/api/audio/xyz", "/api/audio/debug/xyz", "/api/liked", "/api/playlists", "/api/history", "/api/track/1"]) {
      const r = await req("GET", p, null, token);
      assert(r.status === 404, `${p} should 404, got ${r.status}`);
    }
  });

  await t("404 json", async () => {
    const r = await req("GET", "/nope");
    assert(r.status === 404 && r.json.error, "want json 404");
  });

  server.close();
  console.log("\n" + results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
