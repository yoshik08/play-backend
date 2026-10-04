// api tests: node test/run.js
// spins up the app with an in-memory mongo stub. no framework.
process.env.MONGODB_URI = "stub";
process.env.JWT_SECRET = "test-secret";
process.env.GOOGLE_CLIENT_ID = "test.apps.googleusercontent.com";

const Module = require("module");
const stubPath = require.resolve("./mongo-stub");
const origResolve = Module._resolveFilename;
require.cache[stubPath] = { exports: require("./mongo-stub") };
// force lib/db to resolve to the stub
const dbRealPath = require.resolve("../lib/db");
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "./lib/db" || id === "../lib/db" || id.endsWith("lib/db")) {
    return require("./mongo-stub");
  }
  return origRequire.apply(this, arguments);
};

const jwt = require("jsonwebtoken");
const app = require("../server.js");

const PORT = 4317;
let server, passed = 0, failed = 0, skipped = 0;
const results = [];

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
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
const track = { id: "it:1", title: "song", artist: "art", artists: "art", album: "alb", albumArt: "", duration: 200, externalId: "1", source: "itunes" };

async function main() {
  server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 300));

  await t("health", async () => {
    const r = await req("GET", "/health");
    assert(r.status === 200 && r.json.ok, "health not ok");
  });

  await t("protected routes 401 without token", async () => {
    for (const [m, p] of [["GET", "/api/liked"], ["GET", "/api/playlists"], ["GET", "/api/history"], ["GET", "/api/me"], ["GET", "/api/preferences"]]) {
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

  await t("likes: add + duplicate-prevention", async () => {
    await req("POST", "/api/liked", { track }, token);
    await req("POST", "/api/liked", { track }, token); // dup
    const r = await req("GET", "/api/liked", null, token);
    assert(r.json.tracks.length === 1, "dup like created: " + r.json.tracks.length);
    await req("DELETE", "/api/liked/it:1", null, token);
    const r2 = await req("GET", "/api/liked", null, token);
    assert(r2.json.tracks.length === 0, "unlike failed");
  });

  await t("likes: reject invalid track", async () => {
    const r = await req("POST", "/api/liked", { track: { nope: 1 } }, token);
    assert(r.status === 400, "want 400");
  });

  let pid;
  await t("playlists: create + get", async () => {
    const r = await req("POST", "/api/playlists", { name: "mix" }, token);
    assert(r.status === 200 && r.json.id, "no id");
    pid = r.json.id;
    const g = await req("GET", "/api/playlists/" + pid, null, token);
    assert(g.json.playlist.name === "mix", "name mismatch");
  });

  await t("playlists: rename", async () => {
    const r = await req("PUT", "/api/playlists/" + pid, { name: "renamed" }, token);
    assert(r.status === 200, "rename failed");
    const g = await req("GET", "/api/playlists/" + pid, null, token);
    assert(g.json.playlist.name === "renamed", "rename not applied");
  });

  await t("playlists: add tracks, no dupes", async () => {
    const t2 = { ...track, id: "it:2", title: "two" };
    await req("POST", `/api/playlists/${pid}/tracks`, { track }, token);
    await req("POST", `/api/playlists/${pid}/tracks`, { track: t2 }, token);
    await req("POST", `/api/playlists/${pid}/tracks`, { track }, token); // re-add → moves to end
    const g = await req("GET", "/api/playlists/" + pid, null, token);
    const ids = g.json.playlist.tracks.map((x) => x.id);
    assert(ids.length === 2 && ids[0] === "it:2" && ids[1] === "it:1", "dupe rule broken: " + ids);
  });

  await t("playlists: reorder", async () => {
    const r = await req("PUT", `/api/playlists/${pid}/tracks/reorder`, { trackId: "it:1", toIndex: 0 }, token);
    assert(r.status === 200, "reorder failed");
    const g = await req("GET", "/api/playlists/" + pid, null, token);
    assert(g.json.playlist.tracks[0].id === "it:1", "reorder not applied");
  });

  await t("playlists: remove track + delete", async () => {
    await req("DELETE", `/api/playlists/${pid}/tracks/it:2`, null, token);
    let g = await req("GET", "/api/playlists/" + pid, null, token);
    assert(g.json.playlist.tracks.length === 1, "remove failed");
    await req("DELETE", "/api/playlists/" + pid, null, token);
    g = await req("GET", "/api/playlists/" + pid, null, token);
    assert(g.status === 404, "delete failed");
  });

  await t("playlists: bad id → 400", async () => {
    const r = await req("GET", "/api/playlists/not-an-objectid", null, token);
    assert(r.status === 400, "want 400, got " + r.status);
  });

  await t("history: threshold + dedup", async () => {
    let r = await req("POST", "/api/history", { track, playedSec: 5 }, token);
    assert(r.json.recorded === false, "5s should not record");
    r = await req("POST", "/api/history", { track, playedSec: 40 }, token);
    assert(r.json.recorded === true, "40s should record");
    r = await req("POST", "/api/history", { track, playedSec: 40 }, token);
    assert(r.json.deduped === true, "second play within hour should dedup");
    const g = await req("GET", "/api/history", null, token);
    assert(g.json.tracks.length === 1, "history count wrong");
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

  await t("search: itunes fallback shape", async () => {
    try {
      const r = await req("GET", "/api/search?q=coldplay%20yellow");
      assert(r.status === 200 && Array.isArray(r.json.tracks) && r.json.tracks.length > 0, "no tracks");
      const t0 = r.json.tracks[0];
      for (const k of ["id", "title", "artist", "album", "albumArt", "duration", "source"]) {
        assert(k in t0, "missing key " + k);
      }
      assert(["itunes", "spotify"].includes(r.json.source), "bad source");
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
