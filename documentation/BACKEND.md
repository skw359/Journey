# Backend Documentation

## Overview

Journey backend is an Express + PostgreSQL service that handles:

- authentication and session management
- journey ingestion and processing
- per-user tenant isolation in PostgreSQL
- journey/media CRUD
- all-time map and heatmap aggregations
- client pairing token management
- runtime database reconfiguration

Primary runtime entrypoints:

- `server/server.js` (startup + schema init + backfill)
- `server/app.js` (Express app + middleware + route mounting)

## Runtime Architecture

Startup flow (`server/server.js`):

1. Load `.env`
2. Initialize schema via `initSchema()`
3. Backfill missing `travel_mode` values based on `avg_speed`
4. Start HTTP server on `PORT` (default `3003`)

Request flow (`server/app.js`):

1. Parse JSON (`express.json`)
2. Session middleware (`express-session` + `connect-pg-simple`)
3. Serve static frontend (from `client/dist` if present)
4. Route dispatch to feature routers

## Environment Variables

- `DATABASE_URL` (required): PostgreSQL connection string
- `SESSION_SECRET` (required in production): session signing secret
- `PUBLIC_URL` (optional): externally reachable HTTPS URL used for pairing QR output
- `PORT` (optional): backend port, default `3003`
- `MIN_ROUTE_MILES` (optional): minimum distance threshold for accepted/surfaced journeys, default `0.25`
- `MAX_VIDEO_UPLOAD_MB` (optional): max size of one uploaded video; unset or `0` (the default) means no limit
- `VIDEO_MAX_DIMENSION` (optional): longest side of converted videos in pixels, default `1920`
- `VIDEO_PRESET` (optional): x264 preset used for conversion, default `veryfast` (slower = smaller files, more CPU)
- `FFMPEG_PATH` / `FFPROBE_PATH` (optional): binaries used for video conversion, default `ffmpeg` / `ffprobe` on `PATH`

## Authentication Model

Session auth:

- cookie name: `journey.sid`
- server-side session store table: `session`
- used by `requireSession`

Session or bearer auth:

- `requireAuth` accepts either:
  - valid session cookie
  - `Authorization: Bearer <pairing_token>`
- used for mobile/client upload and photo routes

## Storage Layout

Configured in `server/config.js`:

- `uploads/`: temporary zip upload files
- `photos/`: route photos and videos stored on this PC (`.mp4` + `.jpg` poster), per-user subdirectory
- in-progress photo and video conversions are written to `<OS temp dir>/journey-media` (outside synced folders) and cleared on startup
- `avatars/`: user avatars

`uploads/` and `avatars/` are created on startup if missing.

### Attachment storage (`server/utils/mediaStorage.js`)

Photos and videos live in one chosen location: this PC (`photos/`) or a `journey` folder on an
external drive (Settings → Attachment storage, or `server/scripts/move-attachments.js`). Every
location uses the same layout, so the stored names (`<userId>/<hex>.jpg`) never change.

- The choice is saved in `app_config` key `media_storage` (`location`, earlier drives still being emptied in `fallbacks`, `paused`).
- A drive's folder holds `.journey-storage.json` with a random id. The server finds the folder by that id under any drive letter, so it never writes to some other disk that happens to get the old letter.
- Reads try the chosen location first, then this PC, then earlier locations.
- While the drive is unplugged, new uploads and conversions go to this PC. Deletes of files on the drive are queued in `media_pending_deletes` and applied when it reconnects. Conversions whose original is on the drive stay `processing`, rather than failing.
- The server checks for the drive every 30 s. When the drive is back it applies the queued deletes, resumes conversions, and moves this PC's stand-in files over.
- Moving (`server/utils/mediaMove.js`):
  - Each file is copied beside its destination, its SHA-256 is checked against the original's, and only then is it renamed into place and the original deleted. A stopped move resumes safely.
  - Files still being uploaded or converted are skipped until they're done.
  - A Postgres advisory lock keeps the server and the script from moving at the same time.
  - When a move finishes, empty folders are pruned and an emptied earlier drive is forgotten.
- External drives are listed from Windows' storage API (`server/utils/drives.js`). USB disks report as "Fixed", so drives are picked by bus type (USB/SD/MMC/1394, not the boot or system disk). Drives Windows says need repair can't be chosen.
- Changing the location is limited to the primary (first) account.

Moving from the command line (stop the server first; the script refuses while it's listening):

- `node server/scripts/move-attachments.js --list`
- `node server/scripts/move-attachments.js --to "Drive 2" --dry-run`
- `node server/scripts/move-attachments.js --to "Drive 2"` (a label, a letter like `E:`, or `internal`)

## Database Architecture

Core/global tables:

- `users`
- `session`
- `pairing_tokens`
- `app_config`
- legacy shared: `routes`, `waypoints`, `photos`

Tenant model:

- each user has a dedicated schema: `tenant_<sha256(userId)[:24]>`
- each tenant schema has:
  - `routes`
  - `waypoints`
  - `photos`
- queries are scoped by setting `search_path` in `withTenantClient()`

Legacy migration:

- startup ensures tenant schemas for users
- legacy shared-table rows can be moved into tenant schemas
- migration utility is also exposed through auth route (`POST /api/auth/migrate`)

## API Surface

## Health and System

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/ping` | none | Health check (`pong`) |
| `GET` | `/database` | session | Export current tenant journeys as JSON |

## Auth

Mounted at `/api/auth`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/status` | none | Setup/auth status + user snapshot |
| `POST` | `/register` | none | Creates account, starts session |
| `POST` | `/login` | none | Validates credentials, starts session |
| `POST` | `/logout` | session | Destroys session |
| `DELETE` | `/account` | session | Deletes user account + tenant data + files |
| `POST` | `/migrate` | session | Migrates legacy data (primary account only) |
| `POST` | `/avatar` | session | Upload JPG avatar (max 5MB) |
| `GET` | `/avatar/:filename` | none | Serves avatar file by filename |

## Journeys

Mounted at `/api/routes` and guarded by `requireSession`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/routes` | session | List summaries (`distance >= MIN_ROUTE_MILES`) |
| `GET` | `/api/routes/:id` | session | Detail route; supports `?maxPoints=` downsampling |
| `PATCH` | `/api/routes/:id/name` | session | Rename journey |
| `PATCH` | `/api/routes/:id/travel-mode` | session | Set travel mode (`foot|scooter|drive|train|metro|flight`) |
| `PATCH` | `/api/routes/:id/waypoints/:wpId` | session | Rename waypoint label |
| `DELETE` | `/api/routes/:id` | session | Delete journey + associated photo files |
| `DELETE` | `/api/routes/:id/points/:index` | session | Delete one profile point and recompute stats |

## Upload

Mounted at `/upload` and guarded by `requireAuth` (session or bearer token).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/upload` | session or token | Accepts zipped CSV journey payload |

Input:

- `multipart/form-data`
- field `journey`: zip archive containing CSV file(s)
- optional field `source`: `iphone` or `watch`

Parsed CSV columns:

- `ts_ms`
- `lat`
- `lon`
- `ele_m`
- `speed_ms`
- `waypoint`
- `note`

Behavior:

- rejects unrealistically large speed spikes
- computes distance, duration, elevation gain/loss, profile arrays, waypoints
- auto-detects travel mode from average speed
- enforces minimum distance threshold (`MIN_ROUTE_MILES`)

## Photos

Routes live in `server/routes/photos.js` and use `requireAuth`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/photos/<filename>` | session or token | Serves a photo, video, or video poster only if DB ownership check passes (supports Range requests) |
| `GET` | `/api/routes/:id/photos` | session or token | List a journey's photos and videos (polled by the web app while uploads convert) |
| `POST` | `/api/routes/:id/photos` | session or token | Upload photos and/or videos in field `photos` (no fixed per-route file limit); responds once the files are stored |
| `POST` | `/api/routes/:id/uploads` | session or token | Start (or resume) a chunked upload of one file: JSON `{ name, size, type, key }` -> `{ id, size, offset }` |
| `GET` | `/api/routes/:id/uploads/:uploadId` | session or token | Where a chunked upload stands: `{ id, size, offset }`, plus the result once complete |
| `PUT` | `/api/routes/:id/uploads/:uploadId?offset=N` | session or token | Append the bytes starting at `N` (`Content-Length` required, at most 256 MB); the piece that completes the file returns `{ photos, skipped, processing }` like the POST above |
| `DELETE` | `/api/routes/:id/photos/:photoId` | session or token | Delete one photo/video row + files (cancels an in-progress conversion) |

Uploads have no size or time limit. The server turns off Node's default 5-minute `requestTimeout`
(it answered `408` to big uploads); upload requests instead drop a connection that sends nothing
for 5 minutes.

Chunked uploads (`server/routes/mediaUploads.js`) are how the web app sends any file over 32 MB:

- the front proxy stores each request in full before passing it on, so one huge request needs that much space on the proxy and leaves the client waiting with no response; pieces keep each request small
- sessions live in `public.media_uploads`; the bytes so far are `<name>.upload.tmp` in the user's media folder (the attachment mover skips `.tmp` files) and are renamed into place when the last byte arrives
- `offset` must equal the bytes already received, or the server answers `409` with the real `offset`; a second PUT while one is in progress also gets `409`
- a dropped piece keeps whatever arrived: `GET` the upload and continue from its `offset`. The bytes survive a server restart
- `key` (the web app sends `name:size:lastModified`) makes picking the same file again resume an unfinished upload rather than start over
- repeating the final PUT after it succeeded returns the same result rather than adding the file twice
- starting is refused with `507` if the storage location lacks the file's size plus 1 GB
- unfinished uploads idle for 24 hours are deleted hourly

Photo upload constraints:

- accepted types: JPG/JPEG/HEIC/HEIF
- max file size: 50MB each
- JPEGs are `ready` as uploaded
- HEIC/HEIF is stored as uploaded with `status` `processing` and converted to JPEG (quality 90) in the background, two at a time, by `server/utils/mediaQueue.js`: libheif decodes in a worker thread (`utils/heicWorker.js`) so the event loop never blocks, and sharp encodes; the row then becomes `ready` with the JPEG's filename, or `failed`
- the gallery thumbnail is made before a converted photo turns `ready`; the HEIC original is deleted after conversion
- the upload response's `processing` counts every item still converting; `converted` counts the HEIC photos among them

Video upload constraints and processing:

- accepted types: MOV/MP4/M4V/WEBM/MKV/AVI, any size (unless `MAX_VIDEO_UPLOAD_MB` is set)
- requires `ffmpeg` and `ffprobe` on the server; without them videos are skipped and listed in the response's `skipped` array
- videos are stored in the same `photos` table (`mimetype` `video/*`, `kind: "video"` in the API) with `status` `processing` -> `ready` | `failed`
- conversion runs in the background, one video at a time (`server/utils/mediaQueue.js`, alongside photo conversions), at lowered CPU priority
- output is H.264 + AAC MP4 with fast start, at most `VIDEO_MAX_DIMENSION` px on the long side and 60 fps, plus a JPEG poster (`posterFilename`; its thumbnails are served from `/photos/thumb[-480]/<posterFilename>`)
- H.264 sources that already fit (8-bit, AAC audio, <= 12 Mbps) are remuxed without re-encoding
- iPhone HDR (HLG/Dolby Vision) is tone-mapped to SDR when ffmpeg has the `zscale` filter; otherwise it is re-encoded with its HDR tags kept
- the original upload is deleted after conversion; photos and videos still `processing` at shutdown are re-queued on startup
- trashing a journey pauses its conversions (originals kept); restoring it resumes them
- the journey cover is the first converted item; a video contributes its poster

## Maps and Aggregations

Mounted at `/api` and guarded by `requireSession`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/alltime-map-data` | session | Route lines + summary stats, supports `maxPoints` and `bounds` |
| `GET` | `/api/all-points` | session | Flattened point stream with optional date filtering |
| `GET` | `/api/heatmap-grid` | session | Grid-aggregated heatmap cells for current view/date |

## Pairing

Mounted at `/api/pairing` and guarded by `requireSession`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/pairing/tokens` | session | List active pairing tokens |
| `POST` | `/api/pairing/tokens` | session | Create token |
| `DELETE` | `/api/pairing/tokens/:id` | session | Revoke token |
| `GET` | `/api/pairing/qr-data` | session | Returns `{ serverUrl, token }` for QR payload |

## Settings

Mounted at `/api/settings` and guarded by `requireSession`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/settings/database` | session | Read persisted DB config metadata |
| `POST` | `/api/settings/database/test` | session | Validate DB connection |
| `PUT` | `/api/settings/database` | session | Save config + reconnect global pool |
| `GET` | `/api/settings/storage` | session | Database size, this account's share, photo count/bytes and where photos are stored |
| `GET` | `/api/settings/attachment-storage` | session | Attachment location, files still waiting elsewhere, move progress, `canManage` |
| `GET` | `/api/settings/attachment-storage/drives` | session | External drives (`?refresh=1` rescans; takes ~2 s) plus this PC's free space |
| `GET` | `/api/settings/attachment-storage/plan` | primary account | `?target=internal\|<volumeId>`: files, bytes and space a move needs |
| `PUT` | `/api/settings/attachment-storage` | primary account | `{ target: { kind: 'internal' } \| { kind: 'drive', volumeId } }`: switch location and move files there |
| `POST` | `/api/settings/attachment-storage/pause` | primary account | Pause a move (files already moved stay put) |
| `POST` | `/api/settings/attachment-storage/resume` | primary account | Resume, or retry after an error |

## Journey AI (Marco)

Mounted at `/api/ask` and guarded by `requireSession`. Marco answers
natural-language questions about the requesting user's journeys via an Ollama
server (typically on another machine on the LAN). The model only ever selects
one of six fixed tools with enum arguments; all SQL is hand-written and
tenant-scoped in `server/ai/handlers.js`, and all numbers are computed by
Postgres and formatted server-side. See `server/ai/README.md` for the design.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/ask/config` | session | Current settings (`enabled`, `url`, `model`) |
| `PUT` | `/api/ask/config` | session | Save settings; enabling requires a valid URL |
| `POST` | `/api/ask/config/test` | session | Probe Ollama: reachable? model pulled? tools capability? |
| `POST` | `/api/ask` | session | Body `{ question, timeZone }` → `{ answer, meta }`; add `stream: true` for Server-Sent Events (`stage`/`token`/`replace`/`done`/`error`) so the client renders the answer as it generates |

Configuration lives in `app_config` (no environment variables):

- `marco_enabled`: `'1'` / `'0'`
- `marco_ollama_url`: e.g. `http://192.168.1.50:11434`
- `marco_model`: default `gemma4:e4b` (must support tool calling)

`/api/auth/status` includes a `marcoEnabled` flag so the client can show or
hide the Marco page without an extra request.

Tests (offline — no Ollama, no database needed):

- `npm run test:ai` runs the full suite in `server/ai/tests/`
- `node server/ai/evals/run-evals.js --model gemma4:e4b --runs 3` scores the
  live model's tool selection against `server/ai/evals/ask-evals.json`

## Scripts

Root `package.json` scripts:

- `npm start` -> run backend
- `npm run dev` -> backend + Vite dev server
- `npm run build` -> build frontend (`client/dist`)
- `npm run migrate:import` -> import `database.json` into DB
- `npm run migrate:export` -> export DB to `database-export.json`
- `npm run test:ai` -> offline test suite for Journey AI (Marco)

Script files:

- `server/scripts/migrate-import.js`
- `server/scripts/migrate-export.js`
- `server/scripts/move-attachments.js` (moves photos and videos between this PC and external drives; see Attachment storage)

## Console Logging

All server output goes through `server/utils/logger.js` — a zero-dependency,
TTY-aware pretty printer. Never call `console.log` directly in `server/`
(the CLI helpers in `server/scripts/` are the exception: they print plain,
interactive prompts).

**Usage** — each module takes a scope, which becomes the third column:

```js
const log = require('../utils/logger').scope('weather');

log.info('open-meteo · 3 observations stored');
log.success('journey uploaded · Morning Commute · 12.4mi · #482');
log.warn('journey rejected · too short: 0.12mi < 0.25mi');
log.error('could not fetch forecast', err);   // Error prints on its own line
log.debug('cache miss');                      // hidden unless LOG_LEVEL=debug
log.scope('cities').info('...');              // borrow another scope inline
```

**Startup** — `server.js` prints a banner, then buffers boot steps with
`log.step(name, detail, state)` (`ok` | `skip` | `warn` | `fail`) and flushes
them as an aligned checklist when `log.ready({ port, startedAt, publicUrl })`
prints the address panel.

**Requests** — `server/middleware/requestLogger.js` prints one line per
request. Static assets, `/photos/*`, `/ping` and favicons are muted unless
they return 4xx/5xx.

**Environment variables**

| Variable | Default | Effect |
| --- | --- | --- |
| `JOURNEY_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `JOURNEY_LOG_HTTP` | on | `0` silences per-request lines |
| `JOURNEY_LOG_STACK` | on outside production | `1`/`0` to force stack traces on/off |
| `JOURNEY_LOG_STYLE` | `auto` | `rich` or `plain` to override the detection below |
| `JOURNEY_LOG_THEME` | `aurora` | Banner gradient: `aurora`, `mint`, `ember`, `ice`, `mono` |
| `JOURNEY_LOG_ASCII` | off | `1` swaps ✔ ○ ╭─╮ for ASCII, for fonts missing the glyphs |
| `NO_COLOR` / `FORCE_COLOR` | auto | Standard color opt-out / opt-in |

**Rich vs plain detection.** A plain `isTTY` check is not enough here, because
`npm run dev` runs the server under `concurrently`, which gives the child a
pipe even though the output lands on a real console. So the logger renders
rich output for a TTY *and* for a pipe, and falls back to plain ASCII only when
stdout is a regular file — a genuine redirect (`> server.log`, pm2, systemd),
where escape codes and box drawing would just be noise. Override either way
with `JOURNEY_LOG_STYLE`.

## Operational Notes

- App trusts reverse proxy headers (`app.set('trust proxy', true)`).
- Session cookie is currently configured with `secure: false`; if you require HTTPS-only cookies, update session cookie config accordingly.
- In production, `PUBLIC_URL` should be HTTPS and match your public domain for pairing UX.
- Route + map endpoints are filtered by `MIN_ROUTE_MILES`.

## Extension Guide

When adding a backend feature:

1. Add route/module in `server/routes/`
2. Mount it in `server/app.js` with proper auth middleware
3. Add/adjust DB schema in `initSchema()` and tenant schema creation path
4. Keep tenant scoping via `withTenantClient()` or `queryTenant()`
5. Update `documentation/FRONTEND.md` if client flow changes
