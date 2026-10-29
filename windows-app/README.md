# Journey for Windows

A native Windows desktop app.

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
