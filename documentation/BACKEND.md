# Backend Documentation

## Overview

Journey backend is an Express + PostgreSQL service that handles:

- authentication and session management
- journey ingestion and processing
- per-user tenant isolation in PostgreSQL
- journey/media CRUD
- all-time map and heatmap aggregations (from per-journey derived data)
- client pairing token management
- invite-only accounts and admin-only server settings
- streaming exports (NDJSON, GPX, GeoJSON)

Primary runtime entrypoints:

- `server/server.js` (startup + schema init + backfill)
- `server/app.js` (Express app + middleware + route mounting)

## Runtime Architecture

Startup flow (`server/server.js`):

1. Load `.env`; refuse to start without `DATABASE_URL`
2. `initSchema()`: global tables, then pending versioned migrations (global and per account)
3. Resolve `SESSION_SECRET` (required when `NODE_ENV=production`; otherwise generated once and kept in `app_config`)
4. Backfill missing `travel_mode` values with `detectTravelMode()` (the same thresholds as uploads)
5. Link upload archives saved before journeys recorded them (once per account)
6. Media storage, Trash sweep (every 6 h), media conversions, geocoding backfills
7. Listen on `PORT` (default `3003`); then fill in wind directions and build missing derived data in the background
8. `SIGTERM`/`SIGINT`: stop accepting connections, finish derived-data work, close the pool

Request flow (`server/app.js`, built by `createApp({ sessionSecret })`):

1. Security headers (`nosniff`, `X-Frame-Options`, `Referrer-Policy`) and a per-route body deadline
2. Parse JSON (`express.json`)
3. Session middleware (`express-session` + `connect-pg-simple`)
4. Serve static frontend (from `client/dist` if present)
5. Route dispatch to feature routers; unknown `/api/*` paths answer JSON `404`; errors answer JSON, never a stack trace

## Environment Variables

- `DATABASE_URL` (required): PostgreSQL connection string. This is the only way to choose the database; changing it needs a restart
- `SESSION_SECRET` (required when `NODE_ENV=production`): session signing secret, 32+ random characters
- `TRUST_PROXY` (optional): Express `trust proxy`. Default `1` (one reverse proxy in front, e.g. nginx). Use `false` when Journey faces the internet directly, or the proxy's address(es)
- `JOURNEY_DATA_DIR` (optional): parent folder of `photos/`, `uploads/` and `avatars/`; default the project folder
- `DB_STATEMENT_TIMEOUT_MS` (optional): Postgres statement timeout, default `30000` (`0` disables)
- `DB_POOL_MAX` (optional): pool size, default `10`
- `MAX_JOURNEY_UPLOAD_MB` / `MAX_JOURNEY_CSV_MB` / `MAX_JOURNEY_ROWS` (optional): journey upload limits, defaults `100` / `1024` / `2000000`
- `PAIRING_TOKEN_IDLE_DAYS` (optional): a paired device unused this long must pair again, default `180`
- `PUBLIC_URL` (optional): externally reachable HTTPS URL used for pairing QR output
- `GEOCODE_BASE_URL` (optional): base URL of the reverse geocoder used for cities/places passed and, via `/api/geocode/lookup` and `/api/geocode/building`, the web client's place labels; unset turns geocoding off
- `PORT` (optional): backend port, default `3003`
- `MIN_ROUTE_MILES` (optional): minimum distance threshold for accepted/surfaced journeys, default `0.25`
- `MAX_VIDEO_UPLOAD_MB` (optional): max size of one uploaded video; unset or `0` (the default) means no limit
- `VIDEO_MAX_DIMENSION` (optional): longest side of converted videos in pixels, default `1920`
- `VIDEO_PRESET` (optional): x264 preset used for conversion, default `veryfast` (slower = smaller files, more CPU)
- `FFMPEG_PATH` / `FFPROBE_PATH` (optional): binaries used for video conversion, default `ffmpeg` / `ffprobe` on `PATH`

## Authentication Model

Session auth:

- cookie name: `journey.sid`, `HttpOnly`, `SameSite=Lax`, `Secure` whenever the request arrived over HTTPS (`secure: 'auto'`, so set `TRUST_PROXY` correctly behind a proxy)
- a new session id is issued at every sign-in (prevents session fixation)
- server-side session store table: `session`
- used by `requireSession`

Accounts:

- the first account is created freely and becomes the **admin** (`users.is_admin`); every later account needs an invite
- invites (`invites` table) are single-use links that expire after 1–30 days (default 7). Only a SHA-256 hash of the token is stored, so a link is shown once, when created. The invite is used up in the same transaction that creates the account, and first-run registration takes an advisory lock, so two simultaneous sign-ups can't both become the first account
- passwords need at least 8 characters; bcrypt cost 12
- sign-in is rate limited per address (30 attempts / 15 min) and per account (10 failures / 15 min); registration per address (10 / hour). Unknown usernames take as long as wrong passwords
- the admin can list, promote, demote and delete accounts; there is always at least one admin

Server-wide settings (database info, weather provider, FlightAware key, Marco/Ollama, attachment storage, invites, accounts) require the admin. Per-account preferences (units, avatar, pairing) don't.

Session or bearer auth:

- `requireAuth` accepts either a valid session cookie or `Authorization: Bearer <pairing_token>`
- pairing tokens are stored as SHA-256 hashes and returned only when created (the pairing QR code). A new token must be used within 15 minutes; a token unused for `PAIRING_TOKEN_IDLE_DAYS` stops working
- with a pairing token, `/api/routes/*` allows only listing, viewing, renaming, setting the travel mode and moving a journey to Recently Deleted; photo and chunked-upload routes and `/upload` are allowed. Trash management, combining, point edits, backfills, exports, settings and Marco need a web session

## Storage Layout

Configured in `server/config.js`:

- `uploads/`: temporary zip upload files
- `uploads/archive/<userId>/`: the original zip of every accepted upload (see Data lifecycle)
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
- Changing the location is limited to the admin.

Moving from the command line (stop the server first; the script refuses while it's listening):

- `node server/scripts/move-attachments.js --list`
- `node server/scripts/move-attachments.js --to "Drive 2" --dry-run`
- `node server/scripts/move-attachments.js --to "Drive 2"` (a label, a letter like `E:`, or `internal`)

## Database Architecture

Core/global tables:

- `users` (with `is_admin`)
- `session`
- `pairing_tokens` (`token_hash`, `pending_until`)
- `invites`
- `app_config`
- `schema_migrations` (scope + name of every migration applied)
- legacy shared: `routes`, `waypoints`, `photos`

Tenant model:

- each user has a dedicated schema: `tenant_<sha256(userId)[:24]>`
- each tenant schema has:
  - `routes`, `waypoints`, `photos`
  - `trashed_journeys` (Recently Deleted), `journey_backups` (combine undo data)
  - `route_derived`, `heat_cells`, `tenant_state` (derived data, below)
- queries are scoped by setting `search_path` in `withTenantClient()`; a client whose `RESET search_path` fails is destroyed instead of returned to the pool

Migrations:

- `server/db.js` keeps an ordered list of global and per-tenant migrations; each scope's pending ones run once, in one transaction, under an advisory lock, and are recorded in `schema_migrations`
- add schema changes as a new migration at the end of `GLOBAL_MIGRATIONS` or `TENANT_MIGRATIONS`

Derived data (`server/utils/journeyDerived.js`):

- `route_derived` holds, per journey: point count, bounding box, recorded time span, extreme points, the 100-point Atlas overview, a simplified detail line (Douglas–Peucker, ~2 m), US states, and its heatmap cells at all six zoom levels
- `heat_cells` is the per-account heatmap grid: for each level and cell, how many journeys passed through and how many GPS points they recorded. Triggers add a journey's cells when its derived row is inserted and subtract them when it is deleted, so the grid stays exact
- a trigger on `routes` deletes the derived row when a journey's track, times, distance or visibility change; rows are rebuilt on demand by the requests that need them and in the background after writes and at startup. Bump `VERSION` there when the derived output changes
- `tenant_state.data_version` moves with every change to `routes` and keys the Fun Stats cache

Legacy migration:

- startup ensures tenant schemas for users
- legacy shared-table rows can be moved into tenant schemas
- migration utility is also exposed through auth route (`POST /api/auth/migrate`, admin only)

## Data lifecycle

- Deleting a journey moves it to Recently Deleted (`trashed_journeys`) for 7 days; then it is hard-deleted (expiry sweep every 6 hours, or when Trash is listed). Permanent delete and Empty Trash hard-delete immediately
- A hard delete removes the Trash entry, its photo and video files and thumbnails, its raw upload archive(s) (`archive_names`, deleted when no journey or Trash entry still refers to them), and the combine backups of that journey, including nested ones
- Combining keeps the originals in `journey_backups` until the combined journey is hard-deleted; undo-combine restores them
- Deleting an account drops its schema and deletes its sessions, pairing tokens, avatar, photos and videos, and its whole `uploads/archive/<userId>/` folder
- Upload archives saved before this tracking existed are linked to their journeys once at startup (by recording time). `npm run archive:prune` lists archives that belong to nothing (dry run); `npm run archive:prune -- --apply` deletes them. It keeps an archive whose recording overlaps a journey, Trash entry or combined journey's source (within an hour), since a journey whose first points were dropped on upload doesn't match its archive by start time; it also keeps archives under a day old and unreadable ones

## Weather privacy and outbound requests

- Weather is fetched for the **city** a journey starts in, never its exact start point. `resolveWeatherLocation()` asks the configured geocoder (`GEOCODE_BASE_URL`, your own service) for the start's city; if its reply includes `city_lat`/`city_lon` (or `city_center: { lat, lon }`) that point is used, otherwise the city's point comes from Open-Meteo's geocoding search, which is sent only the city name (same-named places are told apart by country, state and distance). Without a city (rural, at sea, geocoder down or not configured) weather uses the center of the 0.1° grid cell (~11 km)
- The resolved city and point are stored on the journey (`weather_city`, `weather_lat`, `weather_lon`) and reused by soundings and backfills. Weather is cached in memory by place and hour
- Custom providers receive that point in `{lat}`/`{lon}` and the name in `{city}`; their URL must be `http(s)`
- Other outbound requests: CARTO basemap tiles (from the browser; they reveal which map areas are viewed), FlightAware (flight number/airports, only with an API key), the geocoder (`GEOCODE_BASE_URL`), and Ollama for Marco (the admin-configured URL)

## API Surface

## Health and System

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/ping` | none | Event-loop health check (`pong`); never touches the database |
| `GET` | `/health` | none | `{ status, database }`; `503` when the database is unreachable |
| `GET` | `/database` | session | Raw dump of the account's journeys as one JSON array, streamed (any size) |

## Export

Mounted at `/api/export` and guarded by `requireSession`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/export/journeys` | session | Every journey as newline-delimited JSON (gzip when accepted): a `header` line, one `journey` line each, an `end` line with the count |
| `GET` | `/api/export/journeys/:id.gpx` | session | One journey as GPX 1.1 (track points with time and elevation, waypoints) |
| `GET` | `/api/export/journeys/:id.geojson` | session | One journey as a GeoJSON FeatureCollection (`coordTimes` included) |

## Auth

Mounted at `/api/auth`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/status` | none | Setup/auth status, user snapshot (`isAdmin`), `registration`: `first-run` or `invite-only` |
| `GET` | `/invite?token=` | none | Whether an invite link can still be used (rate limited) |
| `POST` | `/register` | none | `{ username, password, firstName?, lastName?, invite? }`; the first account, or with a valid invite. Starts a session |
| `POST` | `/login` | none | Validates credentials, starts a new session (rate limited) |
| `POST` | `/logout` | session | Destroys session |
| `DELETE` | `/account` | session | Deletes the account and everything it owns (the only admin can't while other accounts exist) |
| `POST` | `/migrate` | admin | Migrates legacy data |
| `POST` | `/avatar` | session | Upload a JPG/PNG/WebP avatar (max 8 MB); it is decoded and re-encoded as a JPEG |
| `GET` | `/avatar/:filename` | none | Serves an avatar, always as `image/jpeg` with `nosniff` (the iOS app loads it without credentials) |

## Admin

Mounted at `/api/admin`; session and admin only.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/invites` | Invites with status (`pending`/`used`/`expired`/`revoked`) |
| `POST` | `/api/admin/invites` | `{ note?, expiresInDays? }` -> the invite with its `url`, shown once |
| `DELETE` | `/api/admin/invites/:id` | Revoke an unused invite |
| `GET` | `/api/admin/users` | Accounts |
| `PATCH` | `/api/admin/users/:id` | `{ isAdmin }` |
| `DELETE` | `/api/admin/users/:id` | Delete another account and everything it owns |

## Journeys

Mounted at `/api/routes` and guarded by `requireAuth` (pairing tokens are limited as described above).

Visible journeys are those at least `MIN_ROUTE_MILES` long plus shorter ones restored from Trash (`force_visible`); the list, maps, heatmap, Fun Stats and Marco all use this one rule (`server/utils/visibility.js`).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/routes` | session or token | List summaries of visible journeys |
| `GET` | `/api/routes/:id` | session or token | Detail route; supports `?maxPoints=` downsampling |
| `PATCH` | `/api/routes/:id/name` | session or token | Rename journey (max 200 characters) |
| `PATCH` | `/api/routes/:id/travel-mode` | session or token | Set travel mode (`foot|scooter|drive|train|metro|flight`) |
| `PATCH` | `/api/routes/:id/waypoints/:wpId` | session | Rename waypoint label |
| `DELETE` | `/api/routes/:id` | session or token | Move the journey to Recently Deleted (files kept for a restore) |
| `DELETE` | `/api/routes/:id/points/:index` | session | Delete one point and recompute every statistic |
| `POST` | `/api/routes/:id/points/delete` | session | `{ indices: [...] }`: delete several points at once |
| `POST` | `/api/routes/combine` | session | `{ journeyIds, name? }`: merge 2–50 journeys into the earliest, points interleaved by time |
| `POST` | `/api/routes/:id/undo-combine` | session | `{ force? }`: split a combined journey back up (see below) |
| `GET` | `/api/routes/trash` | session | Recently Deleted (expired entries are purged first) |
| `GET` | `/api/routes/trash/:trashId` | session | One trashed journey in full |
| `POST` | `/api/routes/trash/:trashId/restore` | session | Restore; `409` if a journey with that id (or recording) already exists, and the entry stays in Trash |
| `DELETE` | `/api/routes/trash/:trashId` | session | Hard-delete one entry |
| `DELETE` | `/api/routes/trash` | session | Empty Trash |

Point deletion and statistics (`server/utils/journeyStats.js`, shared by upload, point deletion, combine and flight import):

- automatic GPS outlier filtering is intentionally off (it can't tell a GPS spike from a flight), so deleting points is how bad points are fixed
- after a deletion, distance, duration, start/end, speeds and elevation are recomputed from the remaining points with the upload's rules: distance only counts steps forward in time, elevation gain/loss ignores steps of 0.5 m or less. A speed the upload derived from the distance to a deleted point is derived again from the new previous point
- the journey row is locked for the edit; indices must be whole numbers in range; profiles that don't line up with the coordinates are refused (`409`)

Undo-combine keeps changes made after combining: photos added later go to the earliest journey, deleted photos stay deleted, renamed waypoints keep their names. If points were deleted from the combined journey since, undo answers `409` (`code: edited_since_combine`) unless `force: true`.

## Upload

Mounted at `/upload` and guarded by `requireAuth` (session or bearer token).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/upload` | session or token | Accepts zipped CSV journey payload |

Input:

- `multipart/form-data`
- field `journey`: a zip containing exactly one CSV (`__MACOSX`/`._*` entries are ignored); at most `MAX_JOURNEY_UPLOAD_MB`, the CSV at most `MAX_JOURNEY_CSV_MB` and `MAX_JOURNEY_ROWS` rows, read within 60 s
- optional field `source`: `iphone` or `watch`
- optional field `recordingId`: the device's id for this recording (the iOS app sends its upload queue item's UUID)

Parsed CSV columns:

- `ts_ms`
- `lat`
- `lon`
- `ele_m`
- `speed_ms`
- `waypoint`
- `note`

Behavior:

- a malformed upload (not a zip, no CSV, several CSVs, corrupt data, over a limit) answers `400`/`408`/`413` and leaves nothing behind
- rows without a usable time and position are skipped; rows out of time order are put back in order; exact repeated rows are dropped
- speed spikes are **not** filtered (that would drop flights); delete bad points instead
- computes distance, duration, elevation gain/loss, profile arrays, waypoints; auto-detects travel mode from average speed
- uploads are idempotent: the same `recordingId`, or the same recorded content from a client that sends none, returns the journey already stored with `200` and `duplicate: true` instead of saving it again (also for uploads that went to Recently Deleted)
- journeys below `MIN_ROUTE_MILES` (or with too little data) go to Recently Deleted so they can be restored
- the original zip is kept in `uploads/archive/` and recorded on the journey (see Data lifecycle)

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
| `GET` | `/api/heatmap-grid` | session | Heatmap cells for a view: `zoom`, `bounds`, optional `start`/`end` (ISO or epoch ms) |
| `GET` | `/api/fun-stats` | session | Fun Stats, cached until the account's journeys (or the date) change |

All of these read `route_derived`/`heat_cells` rather than every recorded point:

- `alltime-map-data` without `bounds` and `maxPoints=100` (the Atlas's first load) returns each journey's stored overview, identical to sampling the full track. With `bounds`, only journeys whose bounding box meets the view are read; those within `maxPoints` are sent exactly as recorded, longer ones as their simplified line (thinned to `maxPoints` if needed). `maxPoints=0` sends every point
- `heatmap-grid` cells are `[lat, lon, journeys, samples]`: how many journeys passed through the cell and how many GPS points they recorded there; `totalPoints` is the sum of samples in view. Without dates it reads `heat_cells`; with dates, journeys wholly inside the range use their stored cells and journeys crossing a boundary are counted point by point using recorded timestamps
- Fun Stats clusters journey starts with DBSCAN over a spatial grid (same clusters as a full scan) and finds the furthest point from home exactly, reading only journeys whose bounding box could hold a farther point

## Pairing

Mounted at `/api/pairing` and guarded by `requireSession`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/pairing/tokens` | session | Paired devices (`status`: `active`, or `pending` until first use); lapsed and long-unused tokens are removed |
| `POST` | `/api/pairing/tokens` | session | Create a token: `{ id, token, label, serverUrl, expiresAt }`. The token is returned only here (the QR code) and must be used within 15 minutes |
| `DELETE` | `/api/pairing/tokens/:id` | session | Revoke token |
| `GET` | `/api/pairing/qr-data` | session | Removed (`410`): tokens can't be shown again |

## Settings

Mounted at `/api/settings` and guarded by `requireSession`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET`/`PUT` | `/api/settings/units` | session | Unit preference |
| `GET` | `/api/settings/database` | admin | Host, port, database and user from `DATABASE_URL` (read-only) |
| `GET` | `/api/settings/storage` | session | This account's database share, photo count/bytes and where photos are stored; the admin also gets the whole database size |
| `GET` | `/api/settings/weather` | session | `weather_enabled` and `weather_sounding_enabled`; the admin also gets the provider settings (API key masked) |
| `PUT` | `/api/settings/weather` | admin | `{ enabled?, provider?, apiKey?, customUrl?, soundingEnabled? }`; custom URLs must be `http(s)` |
| `GET` | `/api/settings/weather/sounding?routeId=` | session | Pressure-level sounding at the journey's start city and time (cached on the journey) |
| `GET`/`PUT` | `/api/settings/flights` | session / admin | FlightAware key (`configured` for other accounts) |
| `GET` | `/api/settings/attachment-storage` | session | Attachment location, files still waiting elsewhere, move progress, `canManage` |
| `GET` | `/api/settings/attachment-storage/drives` | admin | External drives (`?refresh=1` rescans; takes ~2 s) plus this PC's free space |
| `GET` | `/api/settings/attachment-storage/plan` | admin | `?target=internal\|<volumeId>`: files, bytes and space a move needs |
| `PUT` | `/api/settings/attachment-storage` | admin | `{ target: { kind: 'internal' } \| { kind: 'drive', volumeId } }`: switch location and move files there |
| `POST` | `/api/settings/attachment-storage/pause` | admin | Pause a move (files already moved stay put) |
| `POST` | `/api/settings/attachment-storage/resume` | admin | Resume, or retry after an error |

The database connection can no longer be changed at runtime: it comes only from `DATABASE_URL`, and the old stored `db_*` settings (including a plaintext password) are removed by a migration.

## Journey AI (Marco)

Mounted at `/api/ask` and guarded by `requireSession`. Marco answers
natural-language questions about the requesting user's journeys via an Ollama
server (typically on another machine on the LAN). The model only ever selects
one of six fixed tools with enum arguments; all SQL is hand-written and
tenant-scoped in `server/ai/handlers.js`, and all numbers are computed by
Postgres and formatted server-side. See `server/ai/README.md` for the design.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/ask/config` | session | Current settings (`enabled`, `url`, `model`) for the admin; `enabled` only for other accounts |
| `PUT` | `/api/ask/config` | admin | Save settings; enabling requires a valid `http(s)` URL |
| `POST` | `/api/ask/config/test` | admin | Probe Ollama: reachable? model pulled? tools capability? |
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
- `npm test` -> Marco suite and server tests (needs `TEST_DATABASE_URL`, see Testing)
- `npm run test:ai` -> offline test suite for Journey AI (Marco)
- `npm run test:server` -> server tests against a throwaway PostgreSQL database
- `npm run migrate:import` -> import `database.json` into the legacy tables (assigned to the first account on its first sign-in)
- `npm run migrate:export` -> export every account's journeys to `exports/<username>-<date>.ndjson` (`JOURNEY_EXPORT_DIR` overrides the folder)
- `npm run archive:prune` -> list upload archives that belong to nothing (keeping any whose recording overlaps a journey); add `-- --apply` to delete them

Script files:

- `server/scripts/migrate-import.js`
- `server/scripts/migrate-export.js`
- `server/scripts/prune-archives.js`
- `server/scripts/move-attachments.js` (moves photos and videos between this PC and external drives; see Attachment storage)

## Backup and restore

Journey's data is the PostgreSQL database plus files on disk. A complete backup is:

1. The database: `pg_dump --format=custom --file=journey-$(date +%F).dump "$DATABASE_URL"`
2. The media folder: `photos/` (or the `journey` folder on the external drive chosen in Attachment storage)
3. `avatars/` and, if you want the original uploads, `uploads/archive/`
4. The root `.env` (keep it private)

Restore onto a fresh server:

1. Create an empty database and user (see `GETTING_STARTED.md`), then `pg_restore --no-owner --dbname="$DATABASE_URL" journey-YYYY-MM-DD.dump`
2. Copy `photos/`, `avatars/` and `uploads/archive/` back into the Journey folder (or `JOURNEY_DATA_DIR`)
3. Start Journey; migrations bring an older dump up to date, and derived map data is rebuilt in the background

Copying the files while the server is stopped (or right after the dump) keeps them consistent with the database. For a portable copy of one account's journeys instead, use Settings → Your Data → Export Journeys (NDJSON) or `npm run migrate:export`.

## Testing

- `npm run test:ai`: Marco, offline (no database, no Ollama)
- `npm run test:server`: integration tests in `server/tests/` (`node:test`). Set `TEST_DATABASE_URL` to a PostgreSQL server where the tests may create databases, e.g. `postgres://postgres:postgres@localhost:5432/postgres`; each test file creates its own `journey_test_*` database and a temp data folder, and never reads `.env`. Without `TEST_DATABASE_URL` they are skipped
  - `unit`: statistics against the original upload algorithm, grid DBSCAN against a full scan, the furthest-point bound
  - `auth`: invite-only registration, the first-run race, the admin-only settings matrix, cross-account isolation, sessions, rate limits, pairing tokens, avatars, account deletion
  - `upload`: malformed zips, limits, duplicates and retries, ordering, archives
  - `journeys`: point deletion (the spike case), concurrency, very long journeys, combine/undo-combine, restore conflicts, the hard-delete lifecycle
  - `maps`: Atlas output, viewport requests, heatmap cells against a full scan (all zoom levels and date ranges), visibility, Fun Stats values against a full scan, caching
  - `weather`: the exact start point never reaches a third party
  - `export`: NDJSON, GPX, GeoJSON, `/database`, `migrate:export`
  - `perf`: latency and event-loop blocking budgets with 300k points (`PERF_JOURNEYS`, `PERF_POINTS` to scale up)
- CI runs both against a PostgreSQL service container, plus `npm audit --omit=dev --audit-level=high` for the server and client

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

- `TRUST_PROXY` (default one hop) decides which `X-Forwarded-*` headers are believed: the client address used for rate limits, and whether the request was HTTPS (`Secure` cookies). Set it to `false` without a reverse proxy.
- Request timeouts are per route: headers must arrive within 60 s; request bodies within 60 s (15 min for `/upload`); photo/video uploads have no overall limit but drop connections idle for 5 minutes.
- Postgres statements time out after `DB_STATEMENT_TIMEOUT_MS` (30 s); migrations and account deletion lift the limit for their own transaction.
- In production, `PUBLIC_URL` should be HTTPS and match your public domain for pairing and invite links.
- `GET /health` checks the database; `/ping` checks only that the process answers.

## Extension Guide

When adding a backend feature:

1. Add route/module in `server/routes/`
2. Mount it in `server/app.js` with proper auth middleware
3. Add schema changes as a new migration in `server/db.js` (`GLOBAL_MIGRATIONS` or `TENANT_MIGRATIONS`)
4. Keep tenant scoping via `withTenantClient()` or `queryTenant()`
5. Add tests under `server/tests/` and update `documentation/FRONTEND.md` if client flow changes
