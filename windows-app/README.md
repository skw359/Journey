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
(the server's `PUBLIC_URL`); override with the `JOURNEY_DEFAULT_SERVER` env
var at build time, or change it any time in the app (File → Change Server…, or first run).

## Tests

```bash
# The in-memory store vs. the real server, driven by real tenant rows. Regenerate the
# fixture first (read-only DB dump); the test seeds it into a throwaway database:
node tests/fixtures/dump-fixture.cjs      # needs ../.env DATABASE_URL; writes tests/fixtures/tenants.json (~250 MB)
TEST_DATABASE_URL=postgres://user@localhost:5432/postgres npm test

# End-to-end: drives the real protocol handler through Electron's network stack.
npm run test:smoke                        # optional arg: a reachable server URL
```

The equivalence test starts the real server (`server/app.js`) against a database created
for the run (`TEST_DATABASE_URL` must point at a Postgres server where it may create
databases), loads the fixture into it, warms the store from the server's own response and
asserts that Atlas overviews and journey detail match the server's byte for byte, and that
viewport requests return the same journeys. The heatmap is no longer served from memory.
