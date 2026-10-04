// spotify client-credentials search (no user login needed)
let token = null, tokenExp = 0;

async function getToken() {
  const now = Date.now();
  if (token && now < tokenExp - 60000) return token;
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("spotify credentials missing");
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error("spotify token failed: " + r.status);
  const d = await r.json();
  token = d.access_token;
  tokenExp = now + d.expires_in * 1000;
  return token;
}

function normalizeTrack(t) {
  return {
    id: "sp:" + t.id,
    title: t.name,
    artist: t.artists[0] ? t.artists[0].name : "",
    artists: t.artists.map((a) => a.name).join(", "),
    album: t.album.name,
    albumArt: (t.album.images[0] || {}).url || "",
    duration: Math.round((t.duration_ms || 0) / 1000),
    durationMs: t.duration_ms || 0,
    externalId: t.id,
    source: "spotify",
    audioAvailable: !!t.preview_url,
    previewUrl: t.preview_url || null,
    collectionId: t.album.id ? "sp:al:" + t.album.id : null,
    artistId: t.artists[0] ? "sp:ar:" + t.artists[0].id : null,
  };
}

async function search(q, type = "track", limit = 20) {
  const t = await getToken();
  const r = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`,
    { headers: { Authorization: "Bearer " + t } }
  );
  if (!r.ok) throw new Error("spotify search failed: " + r.status);
  const d = await r.json();
  const items = (d.tracks && d.tracks.items) || [];
  return items.map(normalizeTrack);
}

async function getTrack(id) {
  const t = await getToken();
  const r = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(id)}`,
    { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) throw new Error("spotify track failed: " + r.status);
  return normalizeTrack(await r.json());
}

async function getAlbum(id) {
  const t = await getToken();
  const r = await fetch(`https://api.spotify.com/v1/albums/${encodeURIComponent(id)}`,
    { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) throw new Error("spotify album failed: " + r.status);
  const a = await r.json();
  return {
    id: "sp:al:" + a.id,
    title: a.name,
    artist: (a.artists[0] || {}).name || "",
    albumArt: (a.images[0] || {}).url || "",
    tracks: (a.tracks.items || []).map((tr) => ({
      id: "sp:" + tr.id,
      title: tr.name,
      artist: tr.artists.map((x) => x.name).join(", "),
      artists: tr.artists.map((x) => x.name).join(", "),
      album: a.name,
      albumArt: (a.images[0] || {}).url || "",
      duration: Math.round((tr.duration_ms || 0) / 1000),
      externalId: tr.id,
      source: "spotify",
    })),
    source: "spotify",
  };
}

async function getArtist(id) {
  const t = await getToken();
  const r = await fetch(`https://api.spotify.com/v1/artists/${encodeURIComponent(id)}`,
    { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) throw new Error("spotify artist failed: " + r.status);
  const a = await r.json();
  const r2 = await fetch(`https://api.spotify.com/v1/artists/${encodeURIComponent(id)}/albums?limit=20`,
    { headers: { Authorization: "Bearer " + t } });
  const al = r2.ok ? await r2.json() : { items: [] };
  return {
    id: "sp:ar:" + a.id,
    name: a.name,
    image: (a.images[0] || {}).url || "",
    albums: (al.items || []).map((x) => ({
      id: "sp:al:" + x.id,
      title: x.name,
      artist: a.name,
      albumArt: (x.images[0] || {}).url || "",
      source: "spotify",
    })),
    source: "spotify",
  };
}

module.exports = { search, getTrack, getAlbum, getArtist, normalizeTrack };
