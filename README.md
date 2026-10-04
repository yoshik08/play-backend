# play backend

API server for [yoshik.xyz/play](https://yoshik.xyz/play) — a minimal personal music player.

## architecture

```
frontend (static, yoshik.xyz/play)
    ↓ HTTPS
express api (this repo, render)
    ├── auth: google id token → JWT
    ├── music metadata: spotify web api (client credentials) → itunes search api fallback
    ├── audio: yt-dlp download → streamed once → tmp deleted (never stored server-side)
    ├── lyrics: lrcmux (word-level) → lrclib (line-level)
    └── user library: mongodb (users, playlists, liked, play_history, user_preferences)
```

Audio is deliberately transient on the server: `GET /api/getmp3` downloads the mp3 to a
tmp dir, streams it to the client, then deletes it. The frontend caches the bytes in
IndexedDB (never localStorage) with LRU eviction. Nothing copyrighted is stored or
redistributed by the server.

## local setup

```bash
npm install
cp .env.example .env   # fill in values
node server.js
```

Needs: node 18+, python3, `yt-dlp` (`pip install yt-dlp`), `ffmpeg` (for mp3 conversion).

## environment variables

| var | required | notes |
|---|---|---|
| `MONGODB_URI` | yes | atlas connection string |
| `JWT_SECRET` | yes | long random string |
| `GOOGLE_CLIENT_ID` | yes | google cloud oauth client id |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | no | spotify metadata; without these the itunes fallback serves search |
| `MONGO_DB` | no | default `play` |
| `PORT` | no | default 3000 |
| `CORS_ORIGIN` | no | comma-separated allowed origins |

## api

| method | route | auth | notes |
|---|---|---|---|
| GET | `/health` | no | |
| GET | `/api/search?q=` | no | spotify → itunes fallback |
| GET | `/api/track/:id` | no | |
| GET | `/api/album/:id` | no | |
| GET | `/api/artist/:id` | no | |
| GET | `/api/getmp3?q=` | no | downloads + streams mp3, rate-limited |
| GET | `/api/lyrics?artist=&title=&duration=` | no | |
| POST | `/api/auth/google` | no | `{credential}` → `{token, user}` |
| GET | `/api/me` | yes | session check |
| GET/POST | `/api/liked` | yes | upsert = duplicate-safe |
| DELETE | `/api/liked/:id` | yes | |
| GET/POST | `/api/playlists` | yes | |
| GET/PUT/DELETE | `/api/playlists/:id` | yes | rename included |
| POST | `/api/playlists/:id/tracks` | yes | re-adding moves track to end (no dupes) |
| PUT | `/api/playlists/:id/tracks/reorder` | yes | `{trackId, toIndex}` |
| DELETE | `/api/playlists/:id/tracks/:trackId` | yes | |
| POST/GET | `/api/history` | yes | records ≥30s or ≥50% plays, deduped per hour |
| GET/PUT | `/api/preferences` | yes | volume/shuffle/repeat/motion |

Track ids are namespaced: `sp:<id>` (spotify) or `it:<id>` (itunes); albums `sp:al:`/`it:al:`, artists `sp:ar:`/`it:ar:`.

## deployment (render)

- build command: `npm install`
- start command: `node server.js`
- add a `render.yaml` or set env vars in the dashboard
- needs python3 + ffmpeg on the host (`apt` via render's native envs works; for docker add them to the image)

## testing

```bash
node test/run.js
```

Spins up the app with an in-memory mongo stub and exercises: health, auth middleware
(401s), likes duplicate-prevention, playlist CRUD + reorder + rename, history
threshold/dedup, preferences validation, search fallback, lyrics shape.

## security notes

- secrets only via env vars, never in code
- helmet headers, express-rate-limit (stricter on `/api/getmp3`)
- all user input length-capped and ObjectIds validated
- track objects are allow-list filtered (`cleanTrack`) before db writes
- request log records method/path/status only — no tokens, no bodies
