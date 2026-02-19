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
- `photos/`: persisted route photos (per-user subdirectory)
- `avatars/`: user avatars

Files are created on startup if missing.

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
| `PATCH` | `/api/routes/:id/travel-mode` | session | Set travel mode (`foot|scooter|drive`) |
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
| `GET` | `/photos/<filename>` | session or token | Serves photo only if DB ownership check passes |
| `POST` | `/api/routes/:id/photos` | session or token | Upload photos (max 250 files per route) |
| `DELETE` | `/api/routes/:id/photos/:photoId` | session or token | Delete one photo row + file |

Photo upload constraints:

- accepted types: JPG/JPEG/HEIC/HEIF
- max file size: 50MB each
- HEIC/HEIF is converted to JPEG on ingest

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

## Scripts

Root `package.json` scripts:

- `npm start` -> run backend
- `npm run dev` -> backend + Vite dev server
- `npm run build` -> build frontend (`client/dist`)
- `npm run migrate:import` -> import `database.json` into DB
- `npm run migrate:export` -> export DB to `database-export.json`

Script files:

- `server/scripts/migrate-import.js`
- `server/scripts/migrate-export.js`

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
