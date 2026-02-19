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
- Leaflet (+ heatmap, fullscreen, marker cluster plugins)
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
- if system setup not complete -> render register flow
- if migration is required -> render migration flow
- if unauthenticated -> allow only login/register pages
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

- `auth.js` -> auth + avatar + migration actions
- `journeys.js` -> journey CRUD, photos, map/heatmap endpoints
- `pairing.js` -> pairing token + QR data endpoints
- `settings.js` -> runtime DB connection config endpoints

Notes:

- calls are made with `fetch` and rely on browser-managed cookies
- `journeys.js` contains `fetchHeatmapData()` for `/api/heatmap-data`, but backend does not expose that endpoint; current Atlas flow uses `/api/heatmap-grid`

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
- detail cache prevents repeated network fetches for same route

## `TopJourneys` (`/topjourneys`)

Key features:

- ranking/sorting by distance, duration, top speed
- travel-mode filtering
- same map/chart detail surface as dashboard
- same progressive detail loading behavior

## `Atlas` (`/atlas`)

Modes:

- line mode (route overlays, markers, clustering, date filter)
- heatmap mode (viewport + zoom aware grid fetch)

Key features:

- all-time aggregate stats
- mode distance totals
- date range filtering
- route click-through into dashboard
- detail route refresh in high zoom bounds

## `Settings` (`/settings`)

Key features:

- theme toggle
- suppress large-route warning toggle
- avatar upload
- client pairing link
- runtime DB connection test and save/reconnect
- sign out + account deletion modal

## `PairClient` (`/pair`)

Key features:

- QR code rendering for pairing URI
- token list display (created/last-used metadata)
- create and revoke pairing tokens

## `ApiDocs` (`/api-docs`)

- static interactive documentation UI for core journey/photo endpoints
- intended as quick in-app reference, not generated from server source

## `Login` / `Register` / `DataMigration`

- login and registration flows
- migration prompt shown after first account creation when legacy unassigned data exists

## Unrouted/Legacy Page

- `client/src/pages/Heatmap.jsx` exists but is not mounted in router
- current heatmap user flow is `Atlas` with `?view=heatmap`

## Key Components

- `Header`: top navigation, search input, profile menu
- `Sidebar`: collapsible left panel wrapper
- `RouteMap`: Leaflet detail route map with tooltip hover overlays
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

Large route warning:

- threshold-based toast surfaced when route points are high
- suppression state persisted in `localStorage` key `suppressLargeRouteWarning`

## Theme and Visual State

- default theme is `dark` unless `localStorage.theme` is set
- `ThemeProvider` pushes `data-theme` to `<html>`
- tile source and chart color palette are theme dependent

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
