# Journey AI (Marco) — the ask layer

Marco, the natural-language layer for asking questions about your own journeys.
Every SQL statement in the feature is hand-written in `handlers.js` and reaches
the database only through an injected, tenant-scoped query function — nothing
in this directory opens a connection itself, which is why the entire feature
tests offline (`npm run test:ai`).

## The one rule

> The model chooses a function and its arguments. It never writes SQL, never
> computes a date, and never does arithmetic.

Everything below follows from that.

## Files

| File | Role |
|---|---|
| `periods.js` | The closed set of period tokens and the timezone-correct resolver that turns each into a concrete date range. |
| `tools.js` | Tool schemas in Ollama/OpenAI format, plus `validateToolCall()` — the gate every model output passes through before anything runs. |
| `prompt.js` | Builds both system prompts (Marco's identity, the pre-resolved period table, the answer-phrasing rules). |
| `format.js` | Every number Marco speaks: unit-aware formatting from the storage units (miles / mph / meters). |
| `handlers.js` | The seven tool handlers — every SQL statement in the feature, hand-written, tenant-scoped via the injected query fn. |
| `pipeline.js` | Question → tool selection → validation → SQL → phrasing, with every degradation branch explicit. |
| `ollama.js` | Wire client: tool round, answer round, connection test. Normalized error codes, hard timeouts. |
| `history.js` | Conversation memory: the sanitizer that turns a client-sent transcript into the turns both Ollama rounds see. |
| `marco-config.js` | Settings persistence in `app_config` (`marco_enabled`, `marco_ollama_url`, `marco_model`, `marco_timeout_s`). |
| `evals/ask-evals.json` | 54 question phrasings — six multi-turn follow-ups, five average/exclusion cases — and the exact tool call each must produce. |
| `evals/run-evals.js` | Scores a model against that set via Ollama. |
| `evals/selftest.js` | Offline correctness checks. No model, no network, no DB. |
| `tests/` | Offline unit suites: handlers (fake DB), history (pure), ollama (real mock HTTP server), pipeline (fake both). `run-all.js` runs everything. |

## Quick start

```bash
# 1. Prove the scaffolding itself is correct (fast, offline)
node server/ai/evals/selftest.js

# 2. See exactly what the model will be told
node server/ai/evals/run-evals.js --show-prompt

# 3. Score a model
OLLAMA_URL=http://<your-box>:11434 \
node server/ai/evals/run-evals.js --model gemma4:e4b-it-qat --runs 3
```

Step 3 exits non-zero below 95% exact accuracy, so it can gate a deploy.

## Why dates are pre-resolved into the prompt

Date arithmetic is where small models fail quietly — not with an error, with a
confidently wrong week. So no date arithmetic is asked of the model at all.
Instead the system prompt carries a table computed server-side at request time:

```
TOKEN              RESOLVED RANGE            MEANING
last_week          2026-08-17 .. 2026-08-23  the previous complete calendar week
trailing_7_days    2026-08-19 .. 2026-08-25  the 7 complete days ending yesterday
week_before_last   2026-08-10 .. 2026-08-16  the calendar week before last_week
```

The model's job collapses from *computing* a range to *recognising which row a
phrase points at*. The range is in its context verbatim, so the written answer
can state the dates without inventing them.

`week_before_last` and `month_before_last` exist for exactly this reason. Without
them, "last week versus the week before" forces the model into the `custom`
escape hatch and back into date arithmetic. Any phrase that recurs should become
a token rather than a calculation — that is the extension rule for this file.

## How conversation memory works

The transcript lives in the **client** — it is literally the chat on screen.
Each `/api/ask` request carries the recent completed exchanges
(`history: [{role, content}]`, oldest first); `history.js` sanitizes them
(roles whitelisted, per-turn and total caps, most recent turns win, never
assistant-first) and both Ollama rounds see the result between the system
prompt and the latest message. The server stays stateless, nothing new is
persisted, and the whole feature still tests offline. New chat or a page
reload empties the transcript, and with it the memory — exactly what the
screen shows.

The system prompt's CONVERSATION CONTEXT rules make follow-ups work without
breaking the one rule: history is only for resolving what the latest question
refers to ("what about the week before?" keeps the metric and mode, swaps the
period token; "there" is the last-named place), a complete question must
ignore the transcript entirely, and numbers from earlier answers never
influence the tool call. The phrasing round gets the same transcript for
conversational continuity, with the mirror-image rule that every figure it
speaks must come from the current query result.

The caps in `history.js` are deliberately tight (10 turns / ~6KB). They are
not about the context window — the Ollama box runs 64k and ten short turns
are a couple of KB — they are about small models drifting when handed long
transcripts: stale periods and places start bleeding into new tool calls.
Client-side, `Marco.jsx` sends only completed pairs: a reply that errored is
skipped (its question was never answered), a stopped reply keeps whatever
text arrived.

The `conversation-memory` eval cases score exactly this behaviour — carry-over,
reference resolution, and the negative case where history must be ignored.
`--filter conversation` runs just those.

## Averages and exclusion windows

"Excluding August 17–23, how much do I usually drive per week, from July 6 to
August 27?" used to die as an invalid tool call — there was no way to say
*average* or *except* in the schemas, so the model invented arguments and
validation (correctly) refused them. Both are now `stats_summary` arguments,
and both keep the one rule: the model declares intent, the server does every
piece of arithmetic.

`average_per: day|week|month` divides the period's totals by the days actually
counted: rate = total × unit-days ÷ counted days (a month is 30.4375 days).
No week-boundary conventions, no partial-week ambiguity — the span is exact.
For an unbounded period (`all_time`) the span floor is the first *dated*
journey and the ceiling is today; that path counts dated journeys only and the
standard undated caveat reports the rest. The summary always states the basis
("… from 412.1 miles across 9 journeys over 46 counted days"), so the answer
shows its own arithmetic.

`exclude` is a period like any other — the same token vocabulary ("not
counting last week" → `exclude: last_week`), with `custom` backed by its own
`exclude_start_date`/`exclude_end_date` so a custom period and a custom
exclusion coexist in one call. The SQL carves the range out NULL-safely
(`NOT COALESCE(… BETWEEN …, FALSE)`, so undated rows are not silently dropped
from all-time totals), and when averaging, the excluded days leave the
denominator too. Two deterministic fill-ins exist: both exclude dates
present with no `exclude` token means `custom`, and a period argument emitted
as a nested OBJECT — gemma does this live, at temperature 0, identically every
time: `exclude: {custom: true, exclude_start_date: …}` — is flattened to the
token + date fields before validation. Both are complete information, the same
spirit as a missing comparison side defaulting to its partner, not a model
retry; an object the flattener cannot read stays in place and is rejected
honestly. `exclude: all_time` is not offered; there would be nothing left to
count.

## Conventions worth knowing

**Weeks start Monday.** Set by `WEEK_START` in `periods.js`. The prompt states
the live convention, so changing the constant changes what the model is told.

**"last week" means the calendar week.** Not a rolling 7 days. Rolling windows
are named `trailing_*` / `prior_*` so the distinction is visible to the model in
the enum itself.

**Rolling windows end yesterday, not today.** Today is a partial day; including
it makes the same question give different answers at 9am and 9pm, and makes
`trailing_7_days` incomparable with `prior_7_days`. Use `this_week` or `today`
when the partial day is wanted. This is a one-line change in `periods.js` if you
disagree — the reasoning is in a comment there.

**Timezone conversion belongs to Postgres.** The resolver emits civil dates and
the query layer compares with `(start_time AT TIME ZONE $tz)::date BETWEEN $a AND $b`.
No hand-rolled offset math, and DST is the database's problem. Note this
expression will not use `idx_routes_start_time`; at personal-journal row counts
that is fine, but if it ever stops being fine, convert the civil bounds to a
half-open UTC range at the edge rather than moving timezone logic into JS.

**Invalid tool calls are not retried.** `validateToolCall()` rejects unknown
tools, unknown arguments, bad enum values and out-of-range integers, and the
caller returns `capabilityMessage()`. Re-prompting a small model on a malformed
call mostly yields a differently malformed call at twice the latency.

**The name stays internal.** The feature, its files and its config keys are
called Marco, and the client tab keeps the name — but the prompts deliberately
never tell the model a name, so replies self-present generically ("the travel
assistant in Journey"), even when the user addresses it as Marco. Don't "fix"
the prompts by adding the name back.

**Place matching is server-side.** `place_visits` and `trips_between` take the
user's text verbatim. Matching lowercases it, also tries a state-suffix-stripped
form ("Salisbury MD" → "Salisbury", because the geocoder stores bare city
names), then falls back to substring match, then to word-level match — every
significant word contained, so "Hyattsville Fire Department" finds the formally
indexed "Hyattsville Volunteer Fire Department". When everything misses on a
multi-word name, `place_visits` returns ranked near-matches with journey counts
so the reply can offer the real indexed name instead of a bare "never".
`trips_between` runs the same escalation independently on each side, so cities
and named places mix freely — "from Hyattsville Fire Department to College
Park" works.

**A bare US state name stops at exact matching.** The geocoder indexes cities
and named places, never states, so substring-matching a state name answers
"have I been to California?" with "California Tortilla" — a burrito place in
Maryland — which is exactly what it used to do. `isStateQuery()` detects a
query that is *entirely* a state name or USPS code and drops the substring and
word tiers for it (in `trips_between`, only for the side that is a state); the
exact tiers still run, because California, New York and Washington are also
real city names, and the answer then says it means the city, not the state. A
miss says plainly that journeys are not indexed by state rather than reporting
a false "no visits". Nothing about a state name plus more text ("California
Tortilla", "Salisbury MD") is affected. `trips_between` reads BOTH indexes
as the route-ordered sequences they are (`cities_passed` consecutively deduped,
`places_passed` by first encounter): a from→to journey is one where either
index shows a FROM match strictly before a TO match; rows whose first and last
entries match are reported separately as true end-to-end trips, and the
opposite direction comes back as a bonus. Searching both indexes is not
optional: the geocoder never labels unincorporated areas as cities — Ashburn VA
shows up in `cities_passed` only as its micro-communities (Loudoun Valley
Estates, Moorefield, McNair, …) but as plain "Ashburn" in `places_passed`.
`place_visits` uses the cities ordering to report started-there / ended-there /
passed-through-mid-route role counts, which is what "in and out of X" questions
are really asking. It also
cross-checks the other index when the model's granularity guess misses (a city
question answered from `places_passed`, or vice versa), and zero-visit answers
report how many journeys have no computed index yet — an honest "not found in
the index" instead of a false "never". `server/scripts/diagnose-places.js` runs
the same matching directly against the database when an answer looks wrong.

## Running the evals honestly

- The clock is pinned to a **Wednesday**. On a Monday, `last_week` and
  `trailing_7_days` resolve identically and every case testing that distinction
  silently stops testing it. `selftest.js` asserts they differ, so this cannot
  regress unnoticed.
- Use `--runs 3` or more. A case that passes twice and fails once is a failing
  case; the runner marks it `FLAKY` and it should be treated as red.
- `exact_accuracy` is the number that matters. `tool_accuracy` will look
  flattering because picking among seven functions is easy; getting `metric` *and*
  `travel_mode` right at the same time is where models actually separate.
- When a case fails, check whether the schema description is ambiguous before
  concluding the model is too small. Most early failures are prompt bugs.

## Running everything

```bash
npm run test:ai            # full offline suite — selftest + handlers + ollama + pipeline
node server/ai/evals/run-evals.js --model gemma4:e4b --runs 3   # live model scoring
```

The Express surface is `server/routes/ask.js` (mounted at `/api/ask`); the
client lives in `client/src/pages/Marco.jsx` with settings in the Journey AI
card on the Settings page. Answer flow: the handler returns finished numbers
plus a preformatted `summary`; the model rephrases it and elaborates —
supporting detail and a closing observation drawn from the `data` fields
(totals, the repeat/new split, the busiest debut day), every one of them
computed server-side. If the phrasing round fails the summary itself is the
answer — wrong numbers are structurally impossible, only less-charming ones.

The phrasing round streams: `chatAnswerStream` relays Ollama's NDJSON token
fragments, the pipeline re-emits them as `onEvent` tokens, and the route frames
them as SSE. The UI drains them a few characters per animation frame so the
reply types itself. If the stream dies mid-answer a `replace` event swaps in
the complete summary; if the user hits stop, the abort travels all the way to
the Ollama fetch and the generation is actually cancelled, not just hidden.
