# Journey for Windows

A native Windows desktop app that runs **100% of the Journey web experience** — login,
the loading animations, the full Atlas, Dashboard, Top
Journeys, Recently Deleted, Fun Stats, Marco (streaming), Settings, Pairing, API Docs,
photos — in a real application window, shipped as a **one-click `Journey-Setup.exe`**.

It reads everything from the existing Journey server over its normal HTTP API. **No
changes were made to the Journey codebase** (`client/` and `server/` are untouched); this
app lives entirely in `windows-app/` and talks to the server the same way a browser does.

## Why it's fast (the Atlas "no lag" story)

The web Atlas is laggy because every pan re-requests route geometry and the browser burns
1–2 s in `JSON.parse` on a ~75 MB payload (see the profiling notes in the repo). This app
fixes that by keeping the **entire route dataset in memory in the main process** and
answering the map endpoints from RAM:

- On login it fetches `GET /api/alltime-map-data?maxPoints=0` **once** and loads every
  route's coordinates into typed arrays (`Float64Array`), plus per-route bounding boxes.
- `GET /api/alltime-map-data`, `GET /api/heatmap-grid`, and cached `GET /api/routes/:id`
  are then served **from memory**, producing **byte-for-byte the same JSON** the server
  would — the same downsampling, bounds-clipping (Liang–Barsky), heatmap cell snapping,
  date semantics, number formatting, and key order.
- In the background it prefetches every journey's full-resolution detail, so Dashboard /
  Top Journeys detail panes open instantly.

Measured on the live 2,020-route / 2.23 M-point tenant: warming takes ~230 ms, a bounded
Atlas pan responds in ~35 ms (vs. multi-second on the web), and a full-resolution
`maxPoints=0` response serializes in ~3 ms. Memory use is intentionally generous and
configurable (default caps: 768 MB route detail + 512 MB photos).

This equivalence is not assumed — it is **tested against the real server code**. See
`tests/store-equivalence.test.js`.

## Architecture

The whole unmodified web client runs in one `BrowserWindow` served from a privileged
`journey://app` origin. A single custom-protocol handler decides, per request:

```
journey://app/…            request                         served by
─────────────────────────  ──────────────────────────────  ─────────────────────────────
/  /atlas  /assets/*  …     SPA shell + hashed bundle        bundled build (static.js)
/__fonts/*                  Montserrat / Marco / ApiDocs      bundled woff2 (no network)
/api/alltime-map-data       Atlas lines                       in-memory RouteStore
/api/heatmap-grid           Atlas heatmap                     in-memory RouteStore
/api/routes/:id (cached)    journey detail                    in-memory RouteStore
/photos/*  /api/auth/avatar images                            RAM media cache → proxy
/api/*  /auth/*  /upload …  everything else                   proxied to the real server
```

Because the client uses **relative URLs** (`/api/...`) and this is a *standard* + *secure*
scheme, `fetch`, `history.pushState`, `localStorage`, cookies, and CORS all behave exactly
as on the web, and the proxy sees the same paths the server would. The proxy forwards
through Chromium's network stack with the shared cookie jar, streaming bodies both ways —
so **Marco's Server-Sent Events**, 50 MB photo uploads, and the session cookie all work
untouched.

| File | Responsibility |
| --- | --- |
| `src/main/main.js` | Electron entry: scheme registration, window, menu, IPC |
| `src/main/router.js` | The one `protocol.handle` — static vs. store vs. media vs. proxy |
| `src/main/data/store.js` | In-memory `RouteStore` — the memory-backed Atlas/detail responder |
| `src/main/data-service.js` | Warms the store after login, background-prefetches details, invalidates on writes |
| `src/main/proxy.js` | Streaming reverse proxy to the real server (cookie jar, SSE, uploads) |
| `src/main/static.js` | In-memory static file server for the SPA bundle + fonts |
| `src/main/media-cache.js` | LRU RAM cache for photos / avatars |
| `src/main/config.js` | Persisted settings (server URL, cache sizes, window bounds) |
| `src/renderer-setup/setup.html` | First-run / "Change Server" screen |
| `scripts/build-renderer.mjs` | Builds the client into `build/renderer` and bundles fonts locally |

### Auth

Password login/logout flows straight through the proxy (the `journey.sid` cookie is stored
in the shared jar).

## Build & run

Prerequisites: Node 18+ and the app's dev dependencies (`npm install` in this folder).
Python + Pillow are optional (used only to regenerate the icon).

```bash
cd windows-app
npm install

# 1. Build the web client into build/renderer and bundle its fonts locally.
#    (Never writes into ../client — uses an absolute Vite outDir.)
npm run build:renderer

# 2. Run the app in development (opens DevTools, points at the default server).
npm start

# 3. Build the one-click installer  ->  dist/Journey-Setup-<version>.exe
npm run dist
```

`npm run dist` produces **`dist/Journey-Setup-1.0.0.exe`** — a one-click NSIS installer
that installs per-user, adds Start-menu + desktop shortcuts, and launches Journey on
finish. `npm run pack` produces an unpacked `dist/win-unpacked/Journey.exe` for testing.

The default server URL is baked from the server's `.env` `PUBLIC_URL` at build time
(currently `https://journey.mdoan.com`); override with the `JOURNEY_DEFAULT_SERVER` env
var at build time, or change it any time in the app (File → Change Server…, or first run).

## Tests

```bash
# Byte-for-byte equivalence of the in-memory store vs. the REAL server handlers,
# driven by real tenant rows. Regenerate the fixture first (read-only DB dump):
node tests/fixtures/dump-fixture.cjs      # needs ../.env DATABASE_URL; writes tests/fixtures/tenants.json (~250 MB)
npm test

# End-to-end: drives the real protocol handler through Electron's network stack.
npm run test:smoke                        # optional arg: a reachable server URL
```

The equivalence test loads `server/routes/maps.js` and `server/routes/journeys.js`
unmodified (with only the DB layer stubbed by fixture rows) and asserts the store's output
matches the server's across 130+ generated Atlas/heatmap/detail queries, including edge
cases (empty tenant, malformed coordinates, invalid params, date-filtered heatmaps).

## Notes & limitations

- **CARTO tiles / reverse-geocoding** still load from their real hosts (as on the web);
  the CARTO key returned identical tiles regardless of `Referer`, and the geocoder sends
  `Access-Control-Allow-Origin: *`, so both work from the app origin.
- **Fonts are bundled** (34 woff2, ~630 KB) so typography is identical offline; if font
  bundling can't reach Google at build time it falls back to loading them online.
- The store serves the Atlas/detail endpoints only while warm and only for cached routes;
  anything not in memory falls through to the live server, so correctness never depends on
  the cache. Writes (rename, travel-mode, point delete, combine, trash, upload) proxy
  normally and then invalidate the affected slice of the store.
- `build/`, `dist/`, and `tests/fixtures/tenants.json` are git-ignored build artifacts.
