// lyrics: lrcmux (real word timestamps) -> lrclib (line-level). ported from yoshik.xyz/api/lyrics.js
async function getLyrics(artist, title, durationSec = 0) {
  artist = String(artist || "").slice(0, 200);
  title = String(title || "").slice(0, 200);
  if (!artist || !title) throw new Error("artist and title required");

  // 1. lrcmux — real word-level
  try {
    const r = await fetch(
      "https://api.lrcmux.dev/get?artist=" + encodeURIComponent(artist) +
      "&title=" + encodeURIComponent(title) +
      "&duration=" + Math.round(durationSec),
      { headers: { "User-Agent": "yoshik.xyz/play" } }
    );
    if (r.ok) {
      const d = await r.json();
      if (d && d.meta && d.meta.level === "word" && Array.isArray(d.lines) && d.lines.length) {
        const lines = [];
        d.lines.forEach((ln) => {
          const text = (ln.text || "").trim();
          if (!text) return;
          const textWords = text.split(/\s+/);
          const wordStarts = (ln.words || []).filter((w) => w.text && w.text.trim()).map((w) => w.start);
          lines.push({ time: ln.start, text, words: wordStarts.length === textWords.length ? wordStarts : null });
        });
        if (lines.length) return { source: "lrcmux", wordSync: true, lines };
      }
    }
  } catch (e) {}

  // 2. lrclib fallback
  try {
    const q = encodeURIComponent(title + " " + artist.split(",")[0]);
    const r = await fetch("https://lrclib.net/api/search?q=" + q, {
      headers: { "User-Agent": "yoshik.xyz/play" },
    });
    if (r.status === 429) throw new Error("rate-limited");
    const arr = r.ok ? await r.json() : [];
    let best = null, bestScore = Infinity;
    (arr || []).forEach((x) => {
      const score = Math.abs((x.duration || 0) - durationSec) + (x.syncedLyrics ? 0 : 1e9);
      if (score < bestScore) { bestScore = score; best = x; }
    });
    if (best && best.syncedLyrics) {
      const lines = parseLRC(best.syncedLyrics).map((l) => ({ time: l.time, text: l.text, words: null }));
      if (lines.length) return { source: "lrclib", wordSync: false, lines };
    }
    if (best && best.plainLyrics) return { source: "lrclib", wordSync: false, plain: best.plainLyrics };
    return { source: "none", lines: [] };
  } catch (e) {
    throw new Error("lyrics upstream failed");
  }
}

function parseLRC(lrc) {
  const lines = [];
  lrc.split("\n").forEach((raw) => {
    const times = [];
    const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    let m;
    while ((m = re.exec(raw))) {
      const frac = m[3] || "0";
      const mult = frac.length === 3 ? 1 : frac.length === 2 ? 10 : 100;
      times.push(+m[1] * 60000 + +m[2] * 1000 + +frac * mult);
    }
    const text = raw.replace(/\[.*?\]/g, "").replace(/<[^>]*>/g, "").trim();
    if (!text || !times.length) return;
    times.forEach((t) => lines.push({ time: t, text }));
  });
  lines.sort((a, b) => a.time - b.time);
  return lines.filter((l, i) => i === 0 || l.time !== lines[i - 1].time);
}

module.exports = { getLyrics };
