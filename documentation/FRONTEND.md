# Frontend Documentation

## Overview

Journey frontend is a React + Vite single-page app that provides:

- authenticated journey browsing and editing
- map + chart visualization for route telemetry
- all-time atlas (lines + heatmap)
- photo gallery management
- account/settings and client pairing flows
- in-app API docs page

Entry file:

- `client/src/main.jsx`

## Stack

- React 19
- React Router
- Vite
- OpenLayers (every map, including the flight import preview)
- Chart.js + `react-chartjs-2`
- `lucide-react` icon set

## App Bootstrap and Providers

Provider order in `client/src/main.jsx`:

1. `BrowserRouter`
2. `ThemeProvider`
3. `ToastProvider`
4. `AuthProvider`

Global responsibilities:

- `ThemeProvider`: dark/light theme state, tile URL selection, chart palette
- `ToastProvider`: success/error/info/loading toasts
- `AuthProvider`: session status, login/register/logout, migration and account deletion state

## Routing and Auth Gating

Main route config lives in `client/src/App.jsx`.

App-level auth gating:

- while auth state is loading -> spinner
- if system setup not complete -> render register flow (the first account becomes the server admin)
- if migration is required -> render migration flow
- if unauthenticated -> allow only login/register pages; registering needs an invite link (`/register?invite=…`) once the first account exists
- if authenticated -> render full app shell + `Header`

Authenticated routes:

- `/journeys` -> Dashboard
- `/topjourneys` -> Top Journeys
- `/atlas` -> Atlas
- `/heatmap` -> redirect to `/atlas?view=heatmap`
- `/alltime` -> redirect to `/atlas`
- `/settings` -> Settings
- `/pair` -> Pair Client
- `/api-docs` and `/api.html` -> API docs UI

## API Client Modules

`client/src/api/`:

- `auth.js` -> auth + avatar + migration actions, invite check
- `admin.js` -> invites and account management (admin)
- `journeys.js` -> journey CRUD, photos, map/heatmap endpoints, combine/undo
- `pairing.js` -> pairing tokens (a new token, shown once, for each QR code)
- `settings.js` -> units, storage, weather (sounding by journey id), flight settings, read-only database info

Notes:

- calls are made with `fetch` (through `apiFetch` for anything that should show the top loading bar) and rely on browser-managed cookies
- `apiFetch` counts a request as loading until its headers arrive and then while its body is read, so a response whose body is never read (e.g. an error) can't leave the loading bar on

## Page-Level Behavior

## `Dashboard` (`/journeys`)

Key features:

- lists routes with search + travel-mode filter
- optimistic updates for rename, delete, travel-mode changes
- detail pane with map, stats, charts, and photos
- route point deletion with server-side stat recalculation
- large-route UX warning for very large datasets

Performance strategy:

- initial detail fetch uses `maxPoints=100`
- full detail fetch upgrades to `maxPoints=0` when zoom threshold is reached
- detail cache prevents repeated network fetches for same route; it is an LRU bounded to 40 journeys and 1M points (`client/src/utils/lruCache.js`)
- undo-combine asks before discarding points deleted from the combined journey (`409 edited_since_combine` -> retry with `force`)

## `TopJourneys` (`/topjourneys`)

Key features:

- ranking/sorting by distance, duration, top speed
- travel-mode filtering
- same map/chart detail surface as dashboard
- same progressive detail loading behavior and bounded cache
- with "Preload journey data" on, the top journey and the next three are fetched in full, one at a time (not every journey at once)

## `Atlas` (`/atlas`)

Modes:

- line mode (route overlays, markers, clustering, date filter)
- heatmap mode (viewport + zoom aware grid fetch). Cells carry how many journeys passed through them; weights are `log(1 + journeys)` normalized to the 95th percentile of the cells in view (`client/src/utils/heatmapWeights.js`), so busy places stand out without the rest saturating. The date filter sends the same instants the Lines view filters by

Key features:

- all-time aggregate stats
- mode distance totals
- date range filtering
- route click-through into dashboard
- detail route refresh in high zoom bounds
- tooltip text (journey names, dates, waypoint labels and notes) is HTML-escaped (`client/src/utils/html.js`); `RouteMap` does the same

## `Settings` (`/settings`)

Key features:

- theme toggle
- suppress large-route warning toggle
- avatar upload
- client pairing link
- Your Data: export every journey (NDJSON download)
- admin only: weather provider, FlightAware, Journey AI, read-only database connection info, Accounts & Invites (create/revoke invite links, promote/demote/delete accounts)
- sign out + account deletion modal

## `PairClient` (`/pair`)

Key features:

- QR code for a fresh pairing token, made when the page opens; it works once, within 15 minutes, and can't be shown again
- paired device list (created/last-used, or "waiting to be scanned")
- new pairing code and revoke

## `ApiDocs` (`/api-docs`)

- static interactive documentation UI for core journey/photo endpoints
- intended as quick in-app reference, not generated from server source

## `Login` / `Register` / `DataMigration`

- login and registration flows; `Register` validates the `?invite=` link first and explains when one is missing or used up; passwords need 8+ characters
- migration prompt shown after first account creation when legacy unassigned data exists

## Key Components

- `Header`: top navigation, search input, profile menu
- `Sidebar`: collapsible left panel wrapper
- `RouteMap`: OpenLayers detail route map with tooltip hover overlays
- `StatsGrid`: primary route metrics
- `ElevationChart`, `SpeedChart`, `AccelerationChart`: telemetry visualizations
- `PhotoGallery` + `PhotoViewer`: media upload/view/delete flow
- `JourneyCard`: compact route list card
- `FilterBar`: travel-mode filtering controls
- `TopLoader`: transition loading indicator
- `Modal`: shared modal shell
- `FirstRunOnboarding`: zero-data onboarding surface

## Maps and Performance Details

`RouteMap` behavior:

- simplification for large polylines using Douglas-Peucker (`client/src/utils/simplify.js`)
- hover segments enabled conditionally by zoom to balance UX/performance
- map invalidation after sidebar collapse/expand to avoid layout artifacts

`Atlas` journey lines:

- drawn by a WebGL2 layer (`client/src/utils/routeLinesLayer.js`) that uploads each journey once, so panning and zooming only change shader uniforms; falls back to OpenLayers' canvas renderer where WebGL2 is unavailable
- keeps Douglas-Peucker copies of every journey for zoomed-out views, each within half a pixel of the full line at the zooms it is drawn
- hover and click hit-test the source geometry directly (`forEachAtlasFeatureAt` in `Atlas.jsx`), not rendered pixels

Large route warning:

- threshold-based toast surfaced when route points are high
- suppression state persisted in `localStorage` key `suppressLargeRouteWarning`

## Theme and Visual State

- default theme is `dark` unless `localStorage.theme` is set
- `ThemeProvider` pushes `data-theme` to `<html>`
- tile source and chart color palette are theme dependent

## Tests

From `client/`: `npm test` runs the unit tests in `client/tests/` with Node's built-in runner (loading indicator, HTML escaping, the bounded cache, heatmap weights). `npm run lint` and `npm run build` run in CI too.

## Development

Run frontend dev server (from `client/`):

```bash
npm run dev
```

Project root dev mode:

```bash
npm run dev
```

This uses Vite proxy settings (`client/vite.config.js`) to forward:

- `/api`
- `/photos`
- `/upload`
- `/database`
- `/ping`

to backend `http://localhost:3003`.

## Extending the Frontend

When adding frontend features:

1. Add or update API calls in `client/src/api/`
2. Keep auth-sensitive UI behind `AuthProvider` state
3. Add route in `client/src/App.jsx` if creating a page
4. Reuse shared components where possible (`Modal`, `TopLoader`, `Toast`)
5. For map-heavy features, preserve viewport-aware fetches and simplification patterns
6. Update `documentation/BACKEND.md` if API contracts changed
