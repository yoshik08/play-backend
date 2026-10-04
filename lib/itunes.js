// itunes search api fallback — no auth, reliable. normalized to internal track shape.
async function search(q, limit = 20) {
  const r = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}`
  );
  if (!r.ok) throw new Error("itunes search failed: " + r.status);
  const d = await r.json();
  return (d.results || []).map(normalizeTrack);
}

function normalizeTrack(t) {
  return {
    id: "it:" + t.trackId,
    title: t.trackName || "",
    artist: t.artistName || "",
    artists: t.artistName || "",
    album: t.collectionName || "",
    albumArt: hiRes(t.artworkUrl100),
    duration: Math.round((t.trackTimeMillis || 0) / 1000),
    externalId: String(t.trackId || ""),
    source: "itunes",
    collectionId: t.collectionId ? String(t.collectionId) : null,
    artistId: t.artistId ? String(t.artistId) : null,
  };
}

// itunes returns 100x100 art; 600x600 is available via pattern swap
function hiRes(url) {
  return (url || "").replace("100x100bb", "600x600bb");
}

async function lookup(id, entity) {
  const r = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=${entity || "song"}`);
  if (!r.ok) throw new Error("itunes lookup failed: " + r.status);
  return r.json();
}

async function getAlbum(collectionId) {
  const d = await lookup(collectionId, "album");
  const info = (d.results || [])[0] || {};
  const tracks = (d.results || []).slice(1).map(normalizeTrack);
  return {
    id: "it:al:" + collectionId,
    title: info.collectionName || "",
    artist: info.artistName || "",
    albumArt: hiRes(info.artworkUrl100),
    tracks,
    source: "itunes",
  };
}

async function getArtist(artistId) {
  const d = await lookup(artistId, "album");
  const info = (d.results || [])[0] || {};
  const albums = (d.results || []).slice(1).map((a) => ({
    id: "it:al:" + a.collectionId,
    title: a.collectionName || "",
    artist: a.artistName || "",
    albumArt: hiRes(a.artworkUrl100),
    source: "itunes",
  }));
  return {
    id: "it:ar:" + artistId,
    name: info.artistName || "",
    albums,
    source: "itunes",
  };
}

async function getTrack(trackId) {
  const d = await lookup(trackId, "song");
  const t = (d.results || [])[0];
  if (!t || !t.trackId) throw new Error("track not found");
  return normalizeTrack(t);
}

module.exports = { search, getTrack, getAlbum, getArtist, normalizeTrack };
