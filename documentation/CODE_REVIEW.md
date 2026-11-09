# Journey code review

- **Date:** 2026-11-09
- **Commit reviewed:** `c847327` (the tip of `main` at the time of review)
- **Scope:** `server/`, `client/`, `windows-app/`, `Journey-iOS/`, CI and project setup

## Summary

The server is carefully built: per-account schemas, hashed tokens and invites, parameterized SQL throughout (including the Marco layer), idempotent uploads, and a real integration test suite. Most of what follows is at the edges of that work rather than in its core.

One issue should be fixed before anything else: a paired-device token can bypass its restrictions and permanently empty Recently Deleted (finding 1). Beyond that, the main themes are:

- **Recordings can be lost on the phone and watch.** A failed zip deletes the only copy, an interrupted recording is never recovered, and failed uploads are only retried by hand (findings 15–17).
- **Fun Stats shows some wrong numbers.** Elevation is metres labelled as feet, and every time-of-day and day-of-week figure is computed in UTC (findings 5–6).
- **A few server inputs are trusted too far.** Flight ids go straight into the FlightAware URL, journey uploads can use very large amounts of memory, and anyone can lock an account out of sign-in (findings 2–4).

Each finding says whether I confirmed it by running the code or only by reading it. Findings 1–3, 5, 8 and 9 were confirmed against a live server on a throwaway database, and finding 7 with a standalone reproduction.

### What I ran

| Check | Result |
|---|---|
| `npm test` (Marco suites and server integration tests, Node 22, PostgreSQL 16) | 5 Marco suites and 62 server tests pass |
| Client `npm run lint` | 0 errors, 5 `react-hooks/exhaustive-deps` warnings |
| Client `npm test`, `npm run build` | 4 tests pass, build succeeds |
| `npm audit --omit=dev` (root and client) | 0 vulnerabilities |
| A script exercising findings 1–3, 5, 8 and 9 against a test server, and a standalone reproduction of finding 7 | Results quoted under each finding |

Not run: the iOS and watchOS apps (no Xcode here), the Electron app, video and HEIC conversion, and anything needing a real geocoder, Ollama or FlightAware.

### How much was read

- **Server:** all routes, `db.js`, middleware and most of `utils/` read in full. `ai/handlers.js` was checked for how it builds SQL rather than read line by line. `scripts/` and `logger.js` were not reviewed.
- **Web client:** the API layer, app shell, auth context, every raw-HTML sink and the settings save logic. The large pages (Atlas, Dashboard, Fun Stats rendering) and all CSS were sampled only.
- **Windows app:** `main`, `proxy`, `router`, `static`, `preload` and `data-service` read in full; `store.js` and `media-cache.js` skimmed.
- **iOS and watchOS:** pairing, token storage, the API client, the upload queue, location recording, and the watch's log, filter and phone link. SwiftUI screens, charts and the chunked video uploader were not reviewed.

## Findings to act on first

| # | Severity | Area | Finding | Confirmed by |
|---|---|---|---|---|
| 1 | High | Server | Paired-device tokens can list and empty Recently Deleted | Running |
| 2 | Medium | Server | Any account can make arbitrary FlightAware calls with the admin's key | Running |
| 3 | Medium | Server | Anyone who knows a username can keep it locked out of sign-in | Running |
| 4 | Medium | Server | Journey upload limits allow memory exhaustion | Reading |
| 5 | Medium | Server, web | Fun Stats elevation is metres labelled as feet | Running |
| 6 | Medium | Server | Fun Stats day and hour figures are in UTC; journey names use the server's time zone | Reading |
| 7 | Medium | Server | Marco's Stop button doesn't stop the Ollama generation | Running |
| 8 | Low | Server | An empty `ts_ms` is read as 1 Jan 1970 | Running |
| 9 | Low | Server | Average elevation is wrong when some points lack elevation | Running |
| 10 | Medium | Server | A photo upload that fails partway leaves rows pointing at deleted files | Reading |
| 11 | Medium | Server | There is no way to change or reset a password | Reading |
| 12 | Medium | Web | An expired session leaves the app showing generic errors | Reading |
| 13 | Medium | Windows app | Every edit re-downloads all journeys; changes made elsewhere never appear | Reading |
| 14 | Low | Windows app | Electron hardening gaps | Reading |
| 15 | Medium | iOS | A failed zip deletes the only copy of a recording | Reading |
| 16 | Medium | iOS, watch | An interrupted recording is never recovered | Reading |
| 17 | Medium | iOS | Failed uploads are only retried by hand, and the token can't be read while locked | Reading |

## Server

### 1. Paired-device tokens can list and empty Recently Deleted (High)

`pairingTokenAllowed` in `server/app.js:48-63` blocks tokens from session-only paths by comparing the first path segment against `TOKEN_RESERVED` exactly. Express matches routes case-insensitively by default, so `/api/routes/TRASH` is not recognised as reserved. It then passes the "one segment, GET or DELETE" rule meant for journey ids and is routed to the Trash handlers at `server/routes/journeys.js:202` and `:216`.

Confirmed with a pairing token:

- `GET /api/routes/trash` returns 403, as intended.
- `GET /api/routes/TRASH` returns 200 with the Trash list.
- `DELETE /api/routes/Trash` returns 200 `{"message":"Trash emptied","removed":1}`.

Tokens are meant to be limited to soft deletes. With this gap, a leaked or stolen token can move every journey to Recently Deleted and then empty it, which also deletes the photos, videos and upload archives. `Cities-Status` and `Places-Status` are readable the same way, which is harmless.

Suggested fix: lowercase the segment before the lookup as the immediate patch. The sturdier fix is to stop mirroring the router in a path parser: put `requireSession` on the session-only routes inside `routes/journeys.js`, or move them to a second router mounted behind it. Add mixed-case paths to the pairing-token test in `server/tests/auth.test.js`.

### 2. Any account can make arbitrary FlightAware calls with the admin's key (Medium)

`flightId` (track and import) and `flightNumber` (search) come from the request body and are concatenated into the AeroAPI URL at `server/utils/flight.js:248` and `:325`. Only whitespace is stripped.

Confirmed as a non-admin account: `flightId: "../airports/KSEA/flights?max_pages=5&x="` made the server request `https://aeroapi.flightaware.com/aeroapi/airports/KSEA/flights?max_pages=5&x=/track` with the configured key. The caller sees little or none of the response, but the calls are billed to the admin's FlightAware account.

Two related gaps in `server/routes/flights.js`:

- `/track` and `/import` skip the airport and date validation that `/search` has. A non-string `departure` or `flightId` returns 500 with the internal message (`departure.toUpperCase is not a function`, `flightId.startsWith is not a function`).
- `/import` accepts any `name` (other routes cap names at 200 characters) and any `departureTime` or `arrivalTime`.

Suggested fix: validate ids and flight numbers against a strict pattern and `encodeURIComponent` them, and share one validator across the three routes.

### 3. Anyone who knows a username can keep it locked out of sign-in (Medium)

Sign-in failures are counted per username, from any address (`server/routes/auth.js:35`, `:298`). Ten failures block every sign-in for that username for 15 minutes.

Confirmed: after 10 wrong passwords from one client, the correct password from another client got 429 with `Retry-After: 898`.

Ten requests every 15 minutes keeps an account, including the admin, out of the web app indefinitely. Existing sessions keep working. This is a trade-off against distributed guessing, which the per-address limit and bcrypt cost 12 already slow down. Counting failures per username and address together would remove the lockout.

### 4. Journey upload limits allow memory exhaustion (Medium)

`readJourneyCsv` collects every parsed row as an object before any statistics are computed (`server/utils/journeyIngest.js:43-89`). The defaults in `server/config.js:39-41` allow a 100 MB zip that expands to a 1 GiB CSV with 2,000,000 rows.

I did not test this at the limits. From the code, an upload near them needs heap on the order of a gigabyte, so a couple of concurrent uploads from any account or paired device could crash the server for everyone.

Suggested fix: lower the defaults to something tied to real recordings (24 hours at one point a second is 86,400 rows, a few megabytes), convert rows to numbers as they stream instead of keeping the row objects, and set `maxRowBytes` on the CSV parser.

### 5. Fun Stats elevation is metres labelled as feet (Medium)

`server/routes/funstats.js:1269-1273` returns `totalGainFt`, `totalLossFt` and `peakElevationFt`, and `client/src/pages/FunStats.jsx:1103-1118` prints them with "ft" and divides by 29,032 for "Everests climbed". The values come straight from `elevation_gain` and `top_elevation`, which are metres.

Confirmed: two journeys whose detail views showed gains of 342 m and 257 m produced `totalGainFt: 599`.

The page therefore understates climbing by a factor of 3.28 and ignores the metric preference. The "Mountaineer: 50,000+ ft" achievement (`funstats.js:1224`) and the spirit-animal thresholds compare metres against feet values too. Returning metres under honest names and converting in the client, as the journey detail view already does, fixes all of these.

### 6. Fun Stats day and hour figures are in UTC; journey names use the server's time zone (Medium)

Fun Stats buckets journeys with `getUTCHours`, `getUTCDay` and `getUTCMonth` (`funstats.js:476-611`, `:1146-1149`). That covers time of day, weekday and weekend counts, the commute window, seasons, per-day totals, streaks and several bingo squares. For someone at UTC−8, a Friday 6 pm drive counts as a Saturday night journey.

Marco already takes the browser's time zone and uses `AT TIME ZONE`. Doing the same for `/api/fun-stats`, with the zone in the cache key, would fix it.

Two smaller time-zone problems:

- Auto-generated journey names and the `date` text use the server's time zone (`server/utils/journeyIngest.js:148-154`, `server/routes/flights.js:86-91`). A server running in UTC names an evening journey with the next day's date.
- `funstats.js:394-395` computes "last month" in local time and formats it in UTC, which picks the wrong month on servers east of UTC.

### 7. Marco's Stop button doesn't stop the Ollama generation (Medium)

`server/routes/ask.js:189` cancels the Ollama request from `req.on('close')`. By the time that listener is attached, `express.json()` has consumed the body and the request stream is already destroyed, so the event never fires.

Confirmed with a small Express reproduction on Node 22: the `req` listener never fired after the client aborted, while a `res.on('close')` listener did.

The browser stops showing tokens, but the server keeps the generation running until the model finishes. Listening on `res` fixes it. The tool-selection round takes no abort signal at all, so it would be worth passing one there as well.

### 8. An empty `ts_ms` is read as 1 Jan 1970 (Low)

`Number('')` is `0`, so `server/utils/journeyIngest.js:96` accepts a row with an empty timestamp as epoch zero. The documentation says rows without a usable time are skipped.

Confirmed: one empty `ts_ms` in a 300-row upload produced a start time of `1970-01-01T00:00:00Z`, a duration of `485772h 4m` and the name "Journey - Jan 01, 1970 - 00:00".

Rejecting empty, non-positive and implausible timestamps would fix this. It would also turn the current 500 for out-of-range values into a 400.

### 9. Average elevation is wrong when some points lack elevation (Low)

`server/utils/journeyStats.js:187` divides the elevation sum by the number of points, not by the number of points that have an elevation.

Confirmed: 150 points at 100 m plus 150 points with no elevation gave `avgElevation: 50.00`.

In the same file, line 66 replaces a reported speed of exactly 0 with a speed derived from GPS movement. A stationary sample then contributes jitter to the average speed. This is a small effect, but probably not intended.

### 10. A photo upload that fails partway leaves rows pointing at deleted files (Medium)

`POST /api/routes/:id/photos` inserts one row per file outside a transaction (`server/routes/photos.js:131-139`). If a later file fails, the catch block at `:155-162` deletes every uploaded file, including those whose rows were already inserted. The journey is left with gallery entries that 404. Wrapping the inserts in a transaction, or deleting only files that have no row, fixes it.

The same handler enqueues conversions after sending the response. An error there reaches the catch block, which then tries to send a second response.

### 11. There is no way to change or reset a password (Medium)

The only routes that touch passwords are register, login and delete-account (`server/routes/auth.js`). A forgotten or leaked password can only be fixed by editing the database, or by deleting the account and its data. A change-password route that requires the current password and ends other sessions, plus an admin reset, would close the gap.

### Lower-priority server items

**Security and privacy**

- **Username probing.** Registration inserts the user before checking the invite (`auth.js:234-259`), so without an invite an existing username returns 409 and an unknown one returns 403. Confirmed. Checking the invite first removes the difference.
- **Case-variant usernames.** "Owner" can be registered next to "owner" (confirmed), while the rate limiter treats them as one account. A unique index on `lower(username)` would prevent look-alike accounts.
- **Storage details shown to every account.** `GET /api/settings/attachment-storage` returns the server's absolute media path to non-admins (confirmed). During a move it also returns `current.name` and failed file names, which contain other accounts' ids (`server/routes/settings.js:136-149`).
- **Geocoder responses passed through.** `server/routes/geocode.js:22-24` relays the geocoder's content type and body on Journey's own origin. Forcing `application/json` avoids trusting the geocoder with HTML.
- **No Content-Security-Policy or HSTS.** `securityHeaders` in `server/app.js:20-27` sets three headers but neither of these.
- **Legacy tables in the search path.** Tenant queries run with `search_path = tenant_x, public`, and `public` still holds legacy `routes`, `waypoints` and `photos` tables. If a tenant table were ever missing, queries would fall through to the shared tables silently. Dropping or renaming the legacy tables once migration is done removes that risk.
- **Secrets stored in plain text.** The weather and FlightAware keys, and the generated session secret outside production, sit unencrypted in `app_config`. This is reasonable for a self-hosted app, but worth stating in the backup documentation.

**Robustness**

- **Outbound requests with no timeout.** `server/utils/weather.js:227`, `:291`, `:339`, `:509` and `server/utils/flight.js:176` call `fetch` without a timeout. `GET /api/settings/weather/sounding` waits on one of them directly.
- **Exports can hold a database connection indefinitely.** `forEachJourney` in `server/utils/exporter.js` keeps a pooled connection and an open transaction while the client reads. A stalled download holds both, and ten of them exhaust the default pool.
- **Video and HEIC conversion have no limits.** ffmpeg runs with no time limit, so one malformed video can occupy the single video slot forever. The HEIC worker decodes with no pixel or memory cap.
- **`MIN_ROUTE_MILES` isn't validated.** A non-numeric value becomes `NaN`, and Postgres then treats every journey as too short, so all of them are hidden (`server/config.js:19`).
- **Importing `config.js` creates folders.** `server/config.js:13-14` creates `uploads/` and `avatars/` at import time. Running `npm run test:ai` therefore creates both in the repository root, because the Marco handlers import it through `utils/visibility.js`.

**Performance**

- **Media requests are query-heavy.** Each photo or thumbnail request reads and touches the session, then runs three statements to check ownership with no index on `photos.filename` or `poster_filename` (`server/routes/photos.js:32-40`). The client build is also served after the session middleware (`server/app.js:86-105`), so asset requests carrying a cookie hit the session table too. Worth doing: an index, mounting static files before the session, and `disableTouch` or a throttled touch.
- **Cities and places geocode every point.** `server/utils/cities.js` and `places.js` make one sequential request per coordinate. A two-hour drive at one point a second is thousands of requests per journey. Geocoding the simplified line in `route_derived.detail` would cut this sharply. The two files are near-duplicates and could share one implementation.
- **`maxPoints=0` builds everything in memory.** `/api/alltime-map-data?maxPoints=0` loads every coordinate of every journey and stringifies it in one blocking call (`server/routes/maps.js:214-217`). See finding 13 for why the desktop app makes this hot.

**Smaller correctness notes**

- `GET /api/routes` never selects `places_passed`, so `placesPassed` in the list response is always `[]` (confirmed). Nothing reads it today, and the iOS model decodes it but never uses it.
- Fun Stats leaves flights out of `modeCounts` and `modeDistances` (`funstats.js:371-372`) while counting them in top speed, longest journey and furthest point. The map endpoint does include a flight bucket.
- `GET /api/routes/:id` and `DELETE /api/routes/:id` answer 404 with plain text, while the rest of the API answers JSON.

## Web client

### 12. An expired session leaves the app showing generic errors (Medium)

Nothing in `client/src` handles a 401. The session cookie lasts 30 days from sign-in and is not rolling (`server/app.js:96-101`), so it lapses on a schedule even for someone who uses the app daily. If the app is open when that happens, it stays in its signed-in state and each request fails with a message such as "Failed to fetch journeys" until the page is reloaded.

Handling 401 once in `client/src/api/apiFetch.js` by re-checking auth status would fix it. Setting `rolling: true` on the session would make it rarer.

### Lower-priority web items

- **No error boundary.** A render error in any page blanks the whole app. One boundary around the routes in `client/src/App.jsx` would contain it.
- **Stored API keys can't be cleared.** `client/src/pages/Settings.jsx:191-193` and `:215-217` only send a key when the field is non-empty, so a saved weather or FlightAware key can be replaced but not removed.
- **Thin test coverage.** There are four unit tests for about 14,600 lines of JavaScript. The pure helpers in `utils/` (`dateSearch`, `routeMeasure`, `units`, `travelStats`) are the cheapest place to add more.
- **Lint warnings.** The five `exhaustive-deps` warnings are in `hooks/useGeoLabel.js:85`, `pages/Atlas.jsx:598`, `:932`, `:937` and `pages/Dashboard.jsx:212`. Each should be fixed or given a comment saying why it is intentional.

Raw-HTML handling looks sound. Tooltips and the building popup escape every interpolated value, the Marco renderer escapes before applying markdown, and the API docs page renders static content.

## Windows app

### 13. Every edit re-downloads all journeys; changes made elsewhere never appear (Medium)

After any successful mutation under `/api/routes` or `/api/flights`, including a rename or a travel-mode change, `onMutation` schedules a full re-warm (`windows-app/src/main/data-service.js:210-241`). The re-warm fetches `/api/alltime-map-data?maxPoints=0`, which is every point of every journey (`:92`). With a few years of data that can be tens of megabytes built and parsed per edit.

The opposite problem also exists. Atlas data and cached journey details are served from memory with no revalidation (`windows-app/src/main/router.js:53-65`). A journey uploaded from the phone, or an edit made in a browser, doesn't appear until a local mutation, a new sign-in or a restart.

The server already keeps `tenant_state.data_version`. Exposing it would let the app check cheaply on focus or on a timer, and re-fetch only what changed.

### 14. Electron hardening gaps (Low)

- **Sandbox is off.** `sandbox: false` is set at `windows-app/src/main/main.js:168`. The preload only uses `contextBridge` and `ipcRenderer`, which both work with the sandbox on.
- **The setup bridge is exposed everywhere.** `journeySetup.save` and `.test` are exposed on every page (`windows-app/src/preload/preload.js:30-36`), and the handlers at `main.js:258-280` don't check the sender. Any script running in the app could silently point it at a different server, which would then receive the next sign-in. Exposing the bridge only under `/__setup` and checking `event.senderFrame` would close this.
- **No Content-Security-Policy.** Responses from `journey://` carry none (`windows-app/src/main/static.js:79`).
- **Caches outlive the account.** The media cache is keyed by path and never cleared on sign-out (`router.js:67-75`). The route store only reacts to status, login and logout, so registering or deleting an account in the same run leaves the previous account's data in memory.
- **Tests aren't in CI.** CI only syntax-checks this package, so `tests/store-equivalence.test.js` never runs there.

## iOS and watchOS

None of these were run on a device. They come from reading the code.

### 15. A failed zip deletes the only copy of a recording (Medium)

`createZip` in `Journey-iOS/Journey/Services/LocationService.swift:395-402` catches and prints any error. `stopRecording` then deletes the CSV and returns the zip URL regardless (`:259-262`). If zipping fails, for example on a full disk, the journey is gone and a missing file is queued for upload.

The watch handles the same step correctly (`JourneyWatch/Model/RouteLog.swift:39-45`): it deletes the CSV only after the zip succeeds.

### 16. An interrupted recording is never recovered (Medium)

The phone and the watch both write `route_<ms>.csv` to Documents and only zip it on stop. Nothing looks for leftover CSVs at launch. A crash, a memory kill or a flat battery mid-recording leaves the data on disk, but it is never uploaded and never shown to the user.

Scanning for orphaned CSVs at launch and queueing them would recover these. Two related gaps on the watch:

- When zipping fails, `close()` returns nil and the CSV is orphaned.
- A file transfer that ends in an error is never retried (`JourneyWatch/Model/PhoneLink.swift:65-68`).

### 17. Failed uploads are only retried by hand, and the token can't be read while locked (Medium)

`uploadAll()` and `retryFailed()` are only called from buttons in `Journey-iOS/Journey/Screens/SettingsScreen.swift:99-102`. An upload that fails because there was no signal at the end of a trip stays queued until the user opens Settings and taps retry. Retrying at launch and when connectivity returns would cover the common case.

The Keychain item is also saved without `kSecAttrAccessible` (`Journey-iOS/Journey/Utilities/KeychainHelper.swift:9-13`), so the default "when unlocked" class applies. A watch trip that arrives while the phone is locked can't read the token, and the upload most likely fails as "Not paired with server". `kSecAttrAccessibleAfterFirstUnlock` is the usual class for background work. I have not confirmed this on a device.

### Lower-priority iOS items

- **A leftover cleanup can delete recordings.** `Journey-iOS/Journey/Services/UploadManager.swift:108-113` deletes any queued recording whose failure message contains "201". It looks like a workaround for an old bug, and any other error text containing those digits would delete a recording that was never uploaded.
- **Token prefix in logs.** `Journey-iOS/Journey/Services/APIService.swift:93` and `:98` print the first eight characters of the bearer token and the raw response body.
- **Inconsistent GPS filtering.** The server deliberately does not filter speed spikes so that flights survive. The watch drops any fix implying more than 40 m/s, about 144 km/h (`JourneyWatch/Model/SpikeFilter.swift:7`, `:36`), so on a fast train or a flight it keeps roughly one fix every 30 seconds. On the phone the thresholds at `LocationService.swift:37-39` are set to values like `4000000000.0` to disable the checks, while other heuristics in the same function still run. It would be worth choosing one policy and deleting the disabled code.
- **Plain-HTTP servers.** No App Transport Security exception is declared. If pairing with an `http://` LAN address is meant to work, test it and add `NSAllowsLocalNetworking`. Otherwise the setup guide should say the iOS app needs HTTPS.
- **No CI and uneven tests.** The Xcode project has 67 tests covering chunked uploads, the video queue and chart data, but none for the location filter, the CSV writer or `UploadManager`.

## Tests, CI and project setup

- **Server coverage is strong where it exists.** Auth, uploads, journeys, maps and exports are tested against a real database. Chunked media uploads, the conversion queue, the attachment mover, flights and the settings routes have little or none.
- **CI covers Node only.** It runs the server tests, the client lint, tests and build, and an audit. There is no server lint (no ESLint config outside `client/`), no run of the Windows app's tests and no iOS build.
- **Unused dependency.** `ffmpeg@^0.0.4` in the root `package.json` is never imported. The server spawns the system binary.
- **No licence file.** For a public repository that means all rights reserved, which may not be the intent.
- **Naming and documentation drift.** The root package is still named `routes-backend`. `documentation/BACKEND.md` says Marco has six tools, and `server/ai/handlers.js` registers seven.
- **Repository size.** `docs/assets/journey-demo.gif` is 17 MB and is cloned by everyone. A release asset or a short video link would keep the repository light.

## What is solid

These are worth knowing so that later changes don't undo them:

- **Tenant isolation.** One schema per account, `search_path` reset on release, and the connection destroyed if the reset fails (`server/db.js:471-486`).
- **Credential handling.** Pairing tokens and invites are stored as SHA-256 hashes and shown once. Sessions are regenerated at sign-in. First-run registration takes an advisory lock.
- **SQL construction.** Everything is parameterized. Marco can only choose among fixed tools with enum arguments, and its sort order comes from a whitelist map.
- **Upload idempotency.** Recording ids and content fingerprints are backed by unique indexes, and the insert race is handled.
- **Attachment moves.** Files are copied, hash-verified and renamed before the original is deleted, under an advisory lock.
- **Weather privacy.** Lookups use the start city's centre or a coarse grid cell, never the exact start point, and a test asserts it.
- **Test harness.** Each test file creates and drops its own database and data folder and never reads `.env`.
