# play backend

API server for [yoshik.xyz/play](https://yoshik.xyz/play) — a private, uploads-only
personal music library.

## architecture

```
frontend (static, yoshik.xyz/play)
    ↓ HTTPS
express api (this repo, render)
    ├── auth: google id token → JWT (every /api route gated)
    ├── drive: Yoshik's Google Drive, folder "yoshik-play", backend only
    │         (DRIVE_REFRESH_TOKEN env var — never per-user, never in code)
    ├── songs: mongodb metadata (name, drive file id, duration, artwork match)
    ├── audio: streams from Drive with Range support, chunk-by-chunk —
    │         the whole file is never loaded into memory
    ├── search: spotify → itunes fallback, METADATA ONLY (names/artwork for
    │         the upload matcher — never audio)
    ├── lyrics: lrcmux (word-level) → lrclib (line-level), by name + duration
    └── preferences: mongodb (volume/shuffle/repeat/motion)
```

There is no YouTube, SoundCloud, yt-dlp, or any third-party audio fetching
anywhere in this codebase. Uploads are the only audio source; they land in
Yoshik's Drive and stream back through the API with the user's JWT
(`Authorization` header, or `?token=` for the `<audio>` element).

## local setup

```bash
npm install
cp .env.example .env   # fill in values
node server.js
```

Needs: node 18+. No python, no ffmpeg, no yt-dlp.

## environment variables

| var | required | notes |
|---|---|---|
| `MONGODB_URI` | yes | atlas connection string |
| `JWT_SECRET` | yes | long random string |
| `GOOGLE_CLIENT_ID` | yes | google cloud oauth client id |
| `GOOGLE_CLIENT_SECRET` | yes | needed for the login oauth code exchange |
| `DRIVE_REFRESH_TOKEN` | yes | Yoshik's Drive refresh token (drive.file scope). mint once: `node scripts/mint-drive-token.js`, paste into Render env |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | no | spotify metadata for the upload matcher; without these the itunes fallback serves search |
| `MONGO_DB` | no | default `play` |
| `PORT` | no | default 3000 |
| `CORS_ORIGIN` | no | comma-separated allowed origins |

## drive setup (one-time)

The backend stores all uploads in Yoshik's Google Drive (`yoshik-play` folder)
using a refresh token. End users never touch Drive.

```bash
node scripts/mint-drive-token.js
```

1. Visit the printed URL as Yoshik, approve Drive file access.
2. Copy the `code` from the redirect URL (`https://yoshik.xyz/play?code=XXX`).
3. Paste it when prompted. The script prints the refresh token.
4. In Render dashboard → play-api → Environment, add `DRIVE_REFRESH_TOKEN`
   with the printed value, then redeploy.
5. Verify: `curl https://play-api-n8hk.onrender.com/health` should show
   `"drive": {"ok": true}`.

## api

| method | route | auth | notes |
|---|---|---|---|
| GET | `/health` | no | deps: db, drive, lrcmux, lrclib |
| GET | `/api/search?q=` | no | spotify → itunes fallback, metadata only |
| GET | `/api/lyrics?artist=&title=&duration=` | no | lrcmux → lrclib |
| POST | `/api/auth/google` | no | `{credential}` → `{token, user}` |
| POST | `/api/auth/google/code` | no | redirect flow (ios) `{code, redirectUri}` |
| GET | `/api/me` | yes | session check |
| GET | `/api/drive/status` | yes | backend drive connectivity |
| POST | `/api/songs` | yes | multipart `audio` + `duration`/`name` → Drive |
| GET | `/api/songs` | yes | my songs, newest first |
| GET | `/api/songs/:id` | yes | ownership enforced |
| PATCH | `/api/songs/:id` | yes | rename / artwork match |
| DELETE | `/api/songs/:id` | yes | deletes from Drive + mongo |
| GET | `/api/songs/:id/audio` | yes | Range streaming from Drive |
| POST | `/api/songs/:id/lyrics/refresh` | yes | re-fetch lrcmux → lrclib |
| GET/PUT | `/api/preferences` | yes | volume/shuffle/repeat/motion |

## deployment (render)

- build command: `./render-build.sh` (node deps only)
- start command: `node server.js`
- set env vars in the dashboard (see table above)

## testing

```bash
node test/run.js
```

Spins up the app with in-memory mongo + drive stubs and exercises: health, auth
middleware (401s), song upload/list/get/patch/delete with ownership checks,
audio streaming (200 + 206 range, auth required), drive status, preferences
validation, search metadata-only shape, lyrics shape, and 404s for every
removed provider route.

## security notes

- secrets only via env vars, never in code
- helmet headers, express-rate-limit (stricter on upload + stream routes)
- all user input length-capped and ObjectIds validated
- uploads land on disk (`multer` diskStorage) and stream to Drive — never fully in memory
- request log records method/path/status only — no tokens, no bodies
