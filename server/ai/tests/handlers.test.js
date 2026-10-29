#!/usr/bin/env node
'use strict';

/**
 * Handler tests: every SQL statement Marco can run, executed against a
 * scripted fake database. Asserts three things per handler:
 *   1. the SQL and parameter order are exactly what we designed,
 *   2. the arithmetic (differences, percentages, shares) is right,
 *   3. the summary string is unit-correct in both unit systems and honest
 *      about missing data.
 *
 *   node server/ai/tests/handlers.test.js
 */

const { check, checkMatch, checkNoMatch, fakeQuery, aggRow, report } = require('./testkit');
const { runTool, buildWhere, SORT_SQL, escapeLike, placeCandidates, placeWords, isStateQuery } = require('../handlers');
const { resolvePeriod } = require('../periods');

const NOW = new Date('2026-08-26T14:00:00Z'); // Wednesday, matching the eval clock
const TZ = 'America/New_York';

const ctxBase = { tz: TZ, units: 'imperial', minMiles: 0.25 };
const P = (token) => resolvePeriod(token, { timeZone: TZ, now: NOW });

async function main() {
    /* ---------------- buildWhere composition ---------------- */

    {
        const w = buildWhere({ range: null, mode: null }, ctxBase);
        check('where: bare', w, {
            where: 'WHERE (distance >= $1 OR force_visible = TRUE)',
            params: [0.25],
        });
    }
    {
        const w = buildWhere({ range: P('last_week'), mode: null }, ctxBase);
        check('where: range params in tz,start,end order', w.params, [0.25, TZ, '2026-08-17', '2026-08-23']);
        checkMatch('where: range clause uses AT TIME ZONE $2 and BETWEEN $3 AND $4', w.where,
            /\(start_time AT TIME ZONE \$2\)::date BETWEEN \$3 AND \$4/);
    }
    {
        const w = buildWhere({ range: P('last_week'), mode: 'drive' }, ctxBase);
        check('where: mode appended after range', w.params, [0.25, TZ, '2026-08-17', '2026-08-23', 'drive']);
        checkMatch('where: mode clause is parameterized', w.where, /travel_mode = \$5$/);
    }
    {
        const w = buildWhere({ range: P('all_time'), mode: 'foot' }, ctxBase);
        check('where: all_time adds no date clause', w.params, [0.25, 'foot']);
        checkNoMatch('where: all_time has no BETWEEN', w.where, /BETWEEN/);
    }

    /* ---------------- compare_periods ---------------- */

    {
        // The user's literal question: driving speed this week vs last week.
        const q = fakeQuery([
            [aggRow({ journey_count: 5, avg_speed_mph: 28.4, distance_mi: 120 })],   // period_a
            [aggRow({ journey_count: 7, avg_speed_mph: 24.9, distance_mi: 140 })],   // period_b
            [{ n: 0 }],                                                              // undated
        ]);
        const out = await runTool(
            'compare_periods',
            { metric: 'avg_speed', period_a: 'this_week', period_b: 'last_week', travel_mode: 'drive' },
            { period_a: P('this_week'), period_b: P('last_week') },
            { ...ctxBase, query: q },
        );
        check('compare: three queries (a, b, undated)', q.calls.length, 3);
        check('compare: A params carry this_week range', q.calls[0].params, [0.25, TZ, '2026-08-24', '2026-08-26', 'drive']);
        check('compare: B params carry last_week range', q.calls[1].params, [0.25, TZ, '2026-08-17', '2026-08-23', 'drive']);
        checkMatch('compare: undated query filters start_time IS NULL', q.calls[2].text, /start_time IS NULL/);
        check('compare: pct change computed server-side', Math.round(out.data.pct_change * 10) / 10, 14.1);
        checkMatch('compare: summary carries both values and both labels', out.summary,
            /Average speed, driving only: 28\.4 mph in Aug 24 – Aug 26, 2026 \(5 journeys\) vs 24\.9 mph in Aug 17 – Aug 23, 2026 \(7 journeys\)/);
        checkMatch('compare: summary states direction', out.summary, /up 14% \(\+3\.5 mph\)/);
    }
    {
        // Zero baseline: no percentage, no fake zero.
        const q = fakeQuery([
            [aggRow({ journey_count: 3, distance_mi: 42.3 })],
            [aggRow()],
            [{ n: 2 }],
        ]);
        const out = await runTool(
            'compare_periods',
            { metric: 'distance', period_a: 'this_week', period_b: 'last_week', travel_mode: 'any' },
            { period_a: P('this_week'), period_b: P('last_week') },
            { ...ctxBase, query: q },
        );
        checkMatch('compare: empty baseline says so instead of dividing by zero', out.summary,
            /no journeys at all in Aug 17 – Aug 23, 2026/);
        checkMatch('compare: undated caveat present', out.summary, /2 journeys have no recorded date/);
        check('compare: no pct on empty baseline', out.data.pct_change, undefined);
    }
    {
        // Metric units flow through formatting: 10 mi -> 16.1 km.
        const q = fakeQuery([
            [aggRow({ journey_count: 1, distance_mi: 10 })],
            [aggRow({ journey_count: 1, distance_mi: 5 })],
            [{ n: 0 }],
            [],
            [],
        ]);
        const out = await runTool(
            'compare_periods',
            { metric: 'distance', period_a: 'this_week', period_b: 'last_week', travel_mode: 'any' },
            { period_a: P('this_week'), period_b: P('last_week') },
            { ...ctxBase, units: 'metric', query: q },
        );
        checkMatch('compare: metric units in summary', out.summary, /16\.1 km .* 8 km /);
        checkMatch('compare: metric diff', out.summary, /\+8 km/);
    }
    {
        // In-progress week: B is cut to the same days, the change is
        // attributed to trips, and the rest of B gives a projection.
        const EC = 'Ellicott City';
        const row = (day, distance_mi, cities) => ({ day, distance_mi, duration_s: distance_mi * 60, elevation_gain_m: 0, cities });
        const q = fakeQuery([
            [aggRow({ journey_count: 4, distance_mi: 248 })],
            [aggRow({ journey_count: 5, distance_mi: 165 })],
            [{ n: 0 }],
            [
                row('2026-08-24', 10, [EC, 'Columbia']),
                row('2026-08-25', 59, [EC, 'Columbia', 'Ashburn']),
                row('2026-08-25', 59, ['Ashburn', EC]),
                row('2026-08-26', 120, [EC, 'Laurel', 'Ashburn', 'Laurel', EC]), // one-recording round trip
            ],
            [
                row('2026-08-18', 59, [EC, 'Ashburn']),
                row('2026-08-18', 59, ['Ashburn', EC]),
                row('2026-08-19', 12, [EC, 'Columbia']),
                row('2026-08-21', 30, [EC, 'Baltimore']),
                row('2026-08-22', 5, null),
            ],
        ]);
        const out = await runTool(
            'compare_periods',
            { metric: 'distance', period_a: 'this_week', period_b: 'last_week', travel_mode: 'any' },
            { period_a: P('this_week'), period_b: P('last_week') },
            { ...ctxBase, query: q },
        );
        check('breakdown: five queries (a, b, undated, rows a, rows b)', q.calls.length, 5);
        check('breakdown: row query params end with tz', q.calls[3].params, [0.25, TZ, '2026-08-24', '2026-08-26', TZ]);
        checkNoMatch('breakdown: row query never pulls coordinates', q.calls[3].text, /coordinates/);
        checkMatch('breakdown: like-for-like headline', out.summary,
            /248 miles so far in Aug 24 – Aug 26, 2026 \(4 journeys\) vs 130 miles over the same days of last week, Aug 17 – Aug 19, 2026 \(3 journeys\) — up 91% \(\+118 miles\)/);
        checkMatch('breakdown: projection from the rest of last week', out.summary,
            /All of last week came to 165 miles; if the rest of this week matches it, this week would finish near 283 miles/);
        checkMatch('breakdown: top driver in summary', out.summary,
            /Biggest contributor: Ellicott City ↔ Ashburn, 3 journeys vs 2 \(\+120 miles, 102% of the change\)/);
        check('breakdown: same-days range recorded', [out.data.same_days_of_period_b.start, out.data.same_days_of_period_b.end], ['2026-08-17', '2026-08-19']);

        const bd = out.data.breakdown;
        check('breakdown: only same-direction drivers', bd.biggest_changes.map((d) => d.trip), ['Ellicott City ↔ Ashburn']);
        check('breakdown: driver sides carry journeys, value, weekdays', bd.biggest_changes[0].period_a,
            { journeys: 3, value: '238 miles', days: ['Tue Aug 25', 'Wed Aug 26'] });
        check('breakdown: driver B side uses same days only', bd.biggest_changes[0].period_b,
            { journeys: 2, value: '118 miles', days: ['Tue Aug 18'] });
        check('breakdown: everything else is the remainder', bd.everything_else,
            { period_a: '10 miles', period_b: '12 miles', change: '-2 miles' });
        check('breakdown: busiest day A', bd.busiest_day.period_a,
            { date: 'Wed Aug 26', value: '120 miles', journeys: 1, trips: ['Ellicott City ↔ Ashburn'] });
        check('breakdown: busiest day B within same days', bd.busiest_day.period_b.date, 'Tue Aug 18');
        check('breakdown: compared totals', bd.compared.period_b, { journeys: 3, distance: '130 miles', time_in_motion: '2h 10m' });
    }
    {
        // Two finished periods: no same-days cut, no projection.
        const q = fakeQuery([
            [aggRow({ journey_count: 2, distance_mi: 40 })],
            [aggRow({ journey_count: 1, distance_mi: 20 })],
            [{ n: 0 }],
            [{ day: '2026-08-17', distance_mi: 40, duration_s: 0, elevation_gain_m: 0, cities: ['A', 'B'] }],
            [{ day: '2026-08-10', distance_mi: 20, duration_s: 0, elevation_gain_m: 0, cities: ['B', 'A'] }],
        ]);
        const out = await runTool(
            'compare_periods',
            { metric: 'distance', period_a: 'last_week', period_b: 'week_before_last', travel_mode: 'any' },
            { period_a: P('last_week'), period_b: P('week_before_last') },
            { ...ctxBase, query: q },
        );
        check('breakdown: finished periods have no projection', out.data.projection, undefined);
        checkMatch('breakdown: finished periods compare whole ranges', out.summary, /40 miles in Aug 17 – Aug 23, 2026 \(2 journeys\) vs 20 miles in Aug 10 – Aug 16, 2026/);
        check('breakdown: direction-insensitive trip grouping', out.data.breakdown.biggest_changes[0].share_of_change_pct, 100);
    }

    /* ---------------- stats_summary ---------------- */

    {
        const q = fakeQuery([
            [aggRow({
                journey_count: 12, distance_mi: 84.23, duration_s: 24732,
                avg_speed_mph: 21.34, top_speed_mph: 62.1, elevation_gain_m: 378.2,
            })],
            [{ n: 1 }],
        ]);
        const out = await runTool(
            'stats_summary',
            { period: 'last_week', travel_mode: 'any' },
            { period: P('last_week') },
            { ...ctxBase, query: q },
        );
        checkMatch('stats: full imperial summary', out.summary,
            /Aug 17 – Aug 23, 2026: 12 journeys, 84\.2 miles, 6h 52m in motion, average speed 21\.3 mph, top speed 62\.1 mph, 1,241 ft of climbing\./);
        checkMatch('stats: undated caveat singular', out.summary, /1 journey has no recorded date/);
        checkMatch('stats: aggregate SQL sums the right columns', q.calls[0].text,
            /SUM\(distance\).*SUM\(EXTRACT\(EPOCH FROM \(end_time - start_time\)\)\).*AVG\(avg_speed\).*MAX\(top_speed\).*SUM\(elevation_gain\)/);
    }
    {
        // all_time skips the undated query entirely (nothing is excluded).
        const q = fakeQuery([[aggRow({ journey_count: 3, distance_mi: 30 })]]);
        const out = await runTool(
            'stats_summary',
            { period: 'all_time', travel_mode: 'any' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('stats: all_time runs one query only', q.calls.length, 1);
        checkMatch('stats: all_time label', out.summary, /^all recorded journeys:/);
    }
    {
        const q = fakeQuery([[aggRow()], [{ n: 0 }]]);
        const out = await runTool(
            'stats_summary',
            { period: 'yesterday', travel_mode: 'foot' },
            { period: P('yesterday') },
            { ...ctxBase, query: q },
        );
        checkMatch('stats: empty period is a plain sentence', out.summary,
            /No journeys recorded in Aug 25, 2026, on foot only\./);
    }

    /* ---------------- stats_summary: exclusion window ---------------- */

    const PC = (start, end) => resolvePeriod('custom', { timeZone: TZ, now: NOW, startDate: start, endDate: end });

    {
        // Plain total with a stretch carved out: the SQL must subtract the
        // range without dropping undated rows, and the summary must say so.
        const q = fakeQuery([
            [aggRow({ journey_count: 20, distance_mi: 300.4, duration_s: 36000 })],
            [{ n: 0 }],
        ]);
        const out = await runTool(
            'stats_summary',
            { period: 'this_year', travel_mode: 'drive', exclude: 'custom' },
            { period: P('this_year'), exclude: PC('2026-03-01', '2026-03-31') },
            { ...ctxBase, query: q },
        );
        checkMatch('exclude: SQL carves the range out NULL-safely', q.calls[0].text,
            /NOT COALESCE\(\(start_time AT TIME ZONE \$\d+\)::date BETWEEN \$\d+ AND \$\d+, FALSE\)/);
        check('exclude: exclusion dates parameterized', q.calls[0].params.slice(4, 7), [TZ, '2026-03-01', '2026-03-31']);
        checkMatch('exclude: summary names the carved range', out.summary,
            /^Jan 1 – Aug 26, 2026 excluding Mar 1 – Mar 31, 2026, driving only: 20 journeys, 300\.4 miles/);
        check('exclude: excluded range in data', out.data.excluded.start, '2026-03-01');
    }
    {
        // The literal user question: Jul 6 – Aug 27 (53 days) minus Aug 17–23
        // (7 days) = 46 counted days; 412.1 mi × 7 / 46 = 62.7 mi per week.
        const q = fakeQuery([
            [aggRow({ journey_count: 9, distance_mi: 412.1, duration_s: 65520, avg_speed_mph: 31.2 })],
            [{ n: 0 }],
        ]);
        const out = await runTool(
            'stats_summary',
            { period: 'custom', travel_mode: 'drive', average_per: 'week', exclude: 'custom' },
            { period: PC('2026-07-06', '2026-08-27'), exclude: PC('2026-08-17', '2026-08-23') },
            { ...ctxBase, query: q },
        );
        check('average: counted days = span minus exclusion overlap', out.data.average_span,
            { start: '2026-07-06', end: '2026-08-27', days: 53, excluded_days: 7, counted_days: 46 });
        checkMatch('average: weekly rate from counted days only', out.summary,
            /^Jul 6 – Aug 27, 2026 excluding Aug 17 – Aug 23, 2026, driving only: averaging 62\.7 miles and 1\.4 journeys per week, from 412\.1 miles across 9 journeys over 46 counted days\./);
        check('average: machine-readable rate', Math.round(out.data.average.distance_mi * 10) / 10, 62.7);
    }
    {
        // Unbounded average: the span floor is the first dated journey, the
        // ceiling is today, and undated journeys are excluded and caveated.
        const q = fakeQuery([
            [aggRow({ journey_count: 10, distance_mi: 100, duration_s: 7200 })],
            [{ n: 2 }],
            [{ first_day: '2026-08-14' }],
        ]);
        const out = await runTool(
            'stats_summary',
            { period: 'all_time', travel_mode: 'drive', average_per: 'week' },
            { period: P('all_time') },
            { ...ctxBase, query: q, now: NOW },
        );
        checkMatch('average all-time: aggregate counts dated journeys only', q.calls[0].text,
            /start_time IS NOT NULL/);
        checkMatch('average all-time: span floor query uses MIN', q.calls[2].text, /MIN\(\(start_time AT TIME ZONE/);
        // Aug 14 – Aug 26 inclusive = 13 days; 100 × 7 / 13 = 53.8; 10 × 7 / 13 = 5.4.
        checkMatch('average all-time: since-first-journey phrasing', out.summary,
            /^Since your first journey on Aug 14, 2026, driving only: averaging 53\.8 miles and 5\.4 journeys per week, from 100 miles across 10 journeys over 13 counted days\. \(2 journeys have no recorded date and are not included\)/);
        check('average all-time: span from first journey to today', out.data.average_span,
            { start: '2026-08-14', end: '2026-08-26', days: 13, excluded_days: 0, counted_days: 13 });
    }
    {
        // Exclusion swallowing the whole period leaves nothing to average.
        const q = fakeQuery([[aggRow()], [{ n: 0 }]]);
        const out = await runTool(
            'stats_summary',
            { period: 'custom', travel_mode: 'any', average_per: 'week', exclude: 'custom' },
            { period: PC('2026-08-17', '2026-08-23'), exclude: PC('2026-08-10', '2026-08-30') },
            { ...ctxBase, query: q },
        );
        checkMatch('average: fully-excluded period is honest', out.summary, /no days left to average over/);
        check('average: no rate reported', out.data.average, undefined);
    }
    {
        // Zero journeys inside the counted window reads as the plain sentence,
        // not as "averaging 0 miles".
        const q = fakeQuery([[aggRow()], [{ n: 0 }]]);
        const out = await runTool(
            'stats_summary',
            { period: 'last_month', travel_mode: 'foot', average_per: 'day' },
            { period: P('last_month') },
            { ...ctxBase, query: q },
        );
        checkMatch('average: zero journeys is a plain sentence', out.summary, /^No journeys recorded in Jul 1 – Jul 31, 2026, on foot only\./);
    }

    /* ---------------- new_places ---------------- */

    {
        // this_week vs last_week with case-insensitive dedupe and a missing row.
        const q = fakeQuery([
            [   // period rows
                { arr: ['Seattle', 'Lynnwood'] },
                { arr: ['seattle', 'Everett'] },
                { arr: null },                        // unprocessed journey
            ],
            [   // baseline rows
                { arr: ['Seattle', 'Shoreline'] },
            ],
        ]);
        const out = await runTool(
            'new_places',
            { period: 'this_week', compared_to: 'last_week', granularity: 'city' },
            { period: P('this_week'), compared_to: P('last_week') },
            { ...ctxBase, query: q },
        );
        check('new: set difference is case-insensitive', out.data.new_places, ['Everett', 'Lynnwood']);
        check('new: missing counts split by side', out.data.journeys_missing_location_data, { period: 1, baseline: 0 });
        checkMatch('new: summary lists the fresh cities', out.summary, /2 new cities .* Everett, Lynnwood\./);
        checkMatch('new: summary carries the missing-data note', out.summary, /location data is still missing for 1 journey/);
        checkMatch('new: period query selects the cities column', q.calls[0].text, /SELECT cities_passed AS arr/);
    }
    {
        // all_time baseline must become STRICTLY BEFORE the period start.
        const q = fakeQuery([
            [{ arr: ['Portland'] }],
            (text, params) => {
                check('new: all_time baseline params are [min, tz, periodStart]', params, [0.25, TZ, '2026-08-24']);
                checkMatch('new: all_time baseline uses < not BETWEEN', text, /::date < \$3/);
                return [{ arr: ['Seattle'] }];
            },
        ]);
        const out = await runTool(
            'new_places',
            { period: 'this_week', compared_to: 'all_time', granularity: 'city' },
            { period: P('this_week'), compared_to: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('new: Portland is genuinely new', out.data.new_places, ['Portland']);
        checkMatch('new: baseline label explains the cutoff', out.summary, /anything before Aug 24, 2026/);
    }
    {
        // period=all_time is unanswerable by design.
        const q = fakeQuery([]);
        const out = await runTool(
            'new_places',
            { period: 'all_time', compared_to: 'last_week', granularity: 'place' },
            { period: P('all_time'), compared_to: P('last_week') },
            { ...ctxBase, query: q },
        );
        check('new: all_time period runs no SQL', q.calls.length, 0);
        checkMatch('new: all_time period explains itself', out.summary, /not answerable/);
    }
    {
        // Supporting context is computed server-side: the repeat/new split,
        // both totals, and the busiest debut day (tie broken to the earlier day).
        const q = fakeQuery([
            [   // period rows, in start_time order as the query now guarantees
                { arr: ['Leesburg', 'Belmont'], civil: '2026-08-25' },
                { arr: ['Leesburg', 'Ashburn'], civil: '2026-08-26' },
                { arr: ['Lansdowne', 'Broadlands'], civil: '2026-08-27' },
            ],
            [   // baseline rows
                { arr: ['Ashburn', 'Sterling'] },
            ],
        ]);
        const out = await runTool(
            'new_places',
            { period: 'this_week', compared_to: 'last_week', granularity: 'city' },
            { period: P('this_week'), compared_to: P('last_week') },
            { ...ctxBase, query: q },
        );
        check('new: repeats split out', out.data.repeat_places, ['Ashburn']);
        check('new: counts computed server-side',
            [out.data.new_place_count, out.data.repeat_place_count, out.data.period_place_count, out.data.baseline_place_count],
            [4, 1, 5, 2]);
        check('new: busiest debut day, tie to the earlier day', out.data.most_new_places_on,
            { date: '2026-08-25', label: 'Aug 25, 2026', count: 2 });
        checkMatch('new: summary carries the totals and the split', out.summary,
            /5 cities visited in total — 4 new, 1 repeat; .* had 2 cities\./);
        checkMatch('new: summary names the busiest day', out.summary, /Aug 25, 2026 brought the most new cities \(2\)\./);
        checkMatch('new: period query selects the civil day', q.calls[0].text, /::date\)::text AS civil/);
        checkMatch('new: period query walks journeys in time order', q.calls[0].text, /ORDER BY start_time ASC NULLS LAST/);
    }

    /* ---------------- place-name normalization ---------------- */

    check('candidates: trailing abbrev', placeCandidates('Ellicott City MD'), ['Ellicott City MD', 'Ellicott City']);
    check('candidates: comma + full state', placeCandidates('Salisbury, Maryland'), ['Salisbury, Maryland', 'Salisbury']);
    check('candidates: comma + abbrev', placeCandidates('Ashburn, VA'), ['Ashburn, VA', 'Ashburn']);
    check('candidates: dotted D.C.', placeCandidates('Washington D.C.'), ['Washington D.C.', 'Washington']);
    check('candidates: bare state-name city is left alone', placeCandidates('New York'), ['New York']);
    check('candidates: no strip without comma or abbrev', placeCandidates('Port Washington'), ['Port Washington']);
    check('candidates: lone two-letter name is left alone', placeCandidates('LA'), ['LA']);
    check('words: significant words extracted', placeWords('Hyattsville Fire Department'), ['hyattsville', 'fire', 'department']);
    check('words: stopwords and short tokens dropped', placeWords('The Church of the Ascension'), ['church', 'ascension']);
    check('words: single word', placeWords('Starbucks'), ['starbucks']);

    check('state query: full name', isStateQuery('California'), true);
    check('state query: case and trailing period', isStateQuery('nevada.'), true);
    check('state query: USPS code', isStateQuery('CA'), true);
    check('state query: dotted DC', isStateQuery('D.C.'), true);
    check('state query: state name plus more is a place', isStateQuery('California Tortilla'), false);
    check('state query: city with a state suffix is a place', isStateQuery('Salisbury MD'), false);
    check('state query: multi-word city is a place', isStateQuery('New York City'), false);
    check('state query: empty', isStateQuery(''), false);

    /* ---------------- place_visits ---------------- */

    {
        const q = fakeQuery([
            [   // exact match on the chosen column succeeds; arr feeds the roles
                { id: 'r2', name: 'Errand run', start_time: new Date('2026-08-21T18:00:00Z'), distance: 8.1, travel_mode: 'drive', arr: ['Bellevue', 'Seattle'] },
                { id: 'r1', name: 'Morning loop', start_time: new Date('2026-03-02T15:00:00Z'), distance: 3.2, travel_mode: 'foot', arr: ['Seattle', 'Shoreline', 'Seattle'] },
            ],
            [{ cities_null: 0, places_null: 0 }],   // unindexed-journeys count
        ]);
        const out = await runTool(
            'place_visits',
            { place: 'Seattle', period: 'all_time', granularity: 'city' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('visits: two queries when exact matches (search + missing count)', q.calls.length, 2);
        check('visits: exact pass sends the lowercased candidate array', q.calls[0].params[q.calls[0].params.length - 1], ['seattle']);
        checkMatch('visits: exact match SQL uses ANY over candidates', q.calls[0].text, /LOWER\(v\) = ANY\(\$2::text\[\]\)/);
        checkMatch('visits: SQL selects the city array for role counts', q.calls[0].text, /cities_passed AS arr/);
        checkMatch('visits: missing count covers both indexes', q.calls[1].text,
            /COUNT\(\*\) FILTER \(WHERE cities_passed IS NULL\).*COUNT\(\*\) FILTER \(WHERE places_passed IS NULL\)/);
        check('visits: match mode exact', out.data.match_mode, 'exact');
        check('visits: matched granularity is the chosen one', out.data.matched_granularity, 'city');
        check('visits: dates converted to civil in tz', out.data.first_visit, '2026-03-02');
        check('visits: roles from the ordered array', out.data.roles, { started_there: 1, ended_there: 2, passed_through_mid: 0 });
        checkMatch('visits: summary has count, roles and both dates', out.summary,
            /2 journeys through Seattle in all recorded journeys \(started there 1, ended there 2, passed through mid-route 0\) — first on Mar 2, 2026, most recently Aug 21, 2026\./);
    }
    {
        // Full miss cascades chosen-exact, other-exact, chosen-partial,
        // other-partial, then the two word-level passes — with % escaped in
        // the ILIKE patterns — and the zero answer admits how many journeys
        // are unindexed.
        const q = fakeQuery([
            [],   // places_passed exact (chosen)
            [],   // cities_passed exact (cross-column)
            (text, params) => {
                check('visits: fallback patterns escape ILIKE metacharacters', params[params.length - 1], ['%50\\% Off Outlet%']);
                checkMatch('visits: fallback uses ILIKE ANY', text, /v ILIKE ANY\(\$2::text\[\]\)/);
                checkMatch('visits: third pass is back on the chosen column', text, /places_passed AS arr/);
                return [];
            },
            [],   // cities_passed partial
            [],   // places_passed words
            [],   // cities_passed words
            [{ cities_null: 4, places_null: 9 }],
            [],   // near-match suggestions come up empty too
        ]);
        const out = await runTool(
            'place_visits',
            { place: '50% Off Outlet', period: 'all_time', granularity: 'place' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('visits: eight queries on a full miss (6 passes + missing + suggestions)', q.calls.length, 8);
        check('visits: no-match mode', out.data.match_mode, 'none');
        checkMatch('visits: no-match summary mentions the matching tried', out.summary, /including partial and word-level name matches/);
        checkMatch('visits: no-match summary admits the unindexed journeys', out.summary, /location data is still missing for 9 journeys/);
    }
    {
        // "Salisbury MD" must match the stored bare "Salisbury" via the
        // state-stripped candidate, in the SAME exact pass — no ILIKE needed.
        const q = fakeQuery([
            (text, params) => {
                check('visits: state-suffixed input tries both forms', params[params.length - 1], ['salisbury md', 'salisbury']);
                return [
                    { id: 'r5', name: 'Beach run', start_time: new Date('2026-07-04T12:00:00Z'), distance: 40, travel_mode: 'drive', arr: ['Ocean City', 'Salisbury', 'Fruitland'] },
                ];
            },
            [{ cities_null: 0, places_null: 0 }],
        ]);
        const out = await runTool(
            'place_visits',
            { place: 'Salisbury MD', period: 'all_time', granularity: 'city' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('visits: one search query — exact ANY covers both forms', q.calls.length, 2);
        check('visits: reports the stored name that matched', out.data.matched_name, 'Salisbury');
        check('visits: mid-route pass counted', out.data.roles, { started_there: 0, ended_there: 0, passed_through_mid: 1 });
        checkMatch('visits: summary notes the normalized match', out.summary, /\(matched as "Salisbury"\)/);
    }
    {
        // "Ever been to Ocean City" with the model guessing granularity=place
        // while only the cities index knows it: the cross-column fallback must
        // find it instead of claiming "never".
        const q = fakeQuery([
            [],   // places_passed exact — the guessed column misses
            (text) => {
                checkMatch('visits: cross-column pass reads cities_passed', text, /cities_passed AS arr/);
                return [
                    { id: 'r7', name: 'Shore weekend', start_time: new Date('2026-06-20T14:00:00Z'), distance: 120, travel_mode: 'drive', arr: ['Salisbury', 'Ocean City'] },
                ];
            },
            [{ cities_null: 0, places_null: 12 }],
        ]);
        const out = await runTool(
            'place_visits',
            { place: 'Ocean City', period: 'all_time', granularity: 'place' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('visits: three queries (miss, cross-column hit, missing count)', q.calls.length, 3);
        check('visits: matched granularity reported', out.data.matched_granularity, 'city');
        check('visits: roles computed because the match came from cities', out.data.roles, { started_there: 0, ended_there: 1, passed_through_mid: 0 });
        check('visits: per-column unindexed counts carried', out.data.journeys_missing_location_data, { cities: 0, places: 12 });
        checkMatch('visits: summary counts the visit', out.summary, /1 journey through Ocean City in all recorded journeys/);
    }
    {
        // "Hyattsville Fire Department" vs the indexed "Hyattsville Volunteer
        // Fire Department": the phrase is not a substring of the stored name,
        // but every significant word is — the words tier must find it.
        const q = fakeQuery([
            [], [], [], [],   // exact + partial phrase, both columns
            (text, params) => {
                checkMatch('visits: words tier requires every word', text, /v ILIKE ALL\(\$2::text\[\]\)/);
                check('visits: word patterns', params[params.length - 1], ['%hyattsville%', '%fire%', '%department%']);
                return [
                    { id: 'r9', name: 'Station visit', start_time: new Date('2026-04-05T15:00:00Z'), distance: 6.2, travel_mode: 'drive', arr: ['Hyattsville Volunteer Fire Department', 'Franklins'] },
                ];
            },
            [{ cities_null: 0, places_null: 0 }],
        ]);
        const out = await runTool(
            'place_visits',
            { place: 'Hyattsville Fire Department', period: 'all_time', granularity: 'place' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('visits: six queries (4 name passes + words hit + missing)', q.calls.length, 6);
        check('visits: words match mode', out.data.match_mode, 'words');
        check('visits: full stored name reported', out.data.matched_name, 'Hyattsville Volunteer Fire Department');
        checkMatch('visits: summary names the real place', out.summary,
            /1 journey through Hyattsville Fire Department .*\(matched as "Hyattsville Volunteer Fire Department"\)/);
    }
    {
        // Abbreviations the words tier can't bridge ("Dept" is not a substring
        // of "Department") still produce ranked near-matches with counts, so
        // the answer can offer the real name instead of a bare "never".
        const q = fakeQuery([
            [], [], [], [], [], [],   // all six passes miss
            [{ cities_null: 0, places_null: 0 }],
            (text, params) => {
                checkMatch('visits: suggestion query unions both indexes', text, /UNION/);
                check('visits: suggestion patterns are per-word', params[params.length - 1], ['%hyattsville%', '%fire%', '%dept%']);
                return [
                    { name: 'Hyattsville Volunteer Fire Department', journeys: 12 },
                    { name: 'Fire Creek Trail', journeys: 2 },
                ];
            },
        ]);
        const out = await runTool(
            'place_visits',
            { place: 'Hyattsville Fire Dept', period: 'all_time', granularity: 'place' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('visits: eight queries (6 passes + missing + suggestions)', q.calls.length, 8);
        check('visits: near matches ranked and filtered', out.data.near_matches,
            [{ name: 'Hyattsville Volunteer Fire Department', journeys: 12, matched_words: 2 }]);
        checkMatch('visits: zero summary offers the closest indexed name', out.summary,
            /Closest indexed place names: "Hyattsville Volunteer Fire Department" \(12 journeys\)/);
    }
    check('escapeLike backslash then percent then underscore', escapeLike('a\\b%c_d'), 'a\\\\b\\%c\\_d');

    {
        // The California regression: "California" partial-matched the indexed
        // POI "California Tortilla" — a burrito place in Maryland — and Marco
        // reported a California visit. A bare state name must stop at the
        // exact tiers and say the data cannot answer it.
        const q = fakeQuery([
            (text) => {
                checkMatch('state: first pass is exact, not ILIKE', text, /LOWER\(v\) = ANY/);
                return [];
            },
            [],   // cross-column exact
            [{ cities_null: 0, places_null: 0 }],
        ]);
        const out = await runTool(
            'place_visits',
            { place: 'California', period: 'all_time', granularity: 'place' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('state: three queries — two exact passes and the missing count', q.calls.length, 3);
        check('state: no ILIKE pass ran at all', q.calls.filter((c) => /ILIKE/.test(c.text)).length, 0);
        check('state: flagged as a state query', out.data.is_us_state, true);
        check('state: no near-match suggestions for a state', out.data.near_matches, []);
        checkMatch('state: summary says states are not indexed', out.summary,
            /not by state, so whether any journey entered the state of California is not answerable/);
        checkNoMatch('state: summary makes no visit claim', out.summary, /journeys? through California/);
    }
    {
        // The same guard must not break cities that share a state's name:
        // "New York" and "Washington" are indexed cities, and the exact tier
        // still finds them — with the answer saying which one it means.
        const q = fakeQuery([
            [
                { id: 'r31', name: 'Amtrak up', start_time: new Date('2026-05-02T13:00:00Z'), distance: 210, travel_mode: 'train', arr: ['Baltimore', 'Philadelphia', 'New York'] },
            ],
            [{ cities_null: 0, places_null: 0 }],
        ]);
        const out = await runTool(
            'place_visits',
            { place: 'New York', period: 'all_time', granularity: 'city' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('state: exact tier still answers a state-named city', out.data.visit_count, 1);
        check('state: match mode stays exact', out.data.match_mode, 'exact');
        checkMatch('state: summary counts the city visit', out.summary, /1 journey through New York/);
        checkMatch('state: summary distinguishes city from state', out.summary,
            /the city or named place recorded as "New York", not the state of the same name/);
    }

    /* ---------------- trips_between ---------------- */

    {
        // The Ashburn regression: unincorporated areas never appear in
        // cities_passed (the geocoder stores their micro-communities), so the
        // union search must find the pair via places_passed — and end-to-end
        // classification must accept either index's endpoints.
        const q = fakeQuery([
            [   // ordered-pair union superset, newest first
                {   // pair provable ONLY via places: cities has no "Ashburn"
                    id: 'r21', name: 'Work run', start_time: new Date('2026-08-14T12:00:00Z'), distance: 52.1, travel_mode: 'drive',
                    cities: ['Ellicott City', 'Columbia', 'McNair'], places: ['Ellicott City', 'Ashburn'],
                },
                {   // pair via cities, but not end-to-end
                    id: 'r20', name: 'Long loop', start_time: new Date('2026-06-01T12:00:00Z'), distance: 80.0, travel_mode: 'drive',
                    cities: ['Baltimore', 'Ellicott City', 'Ashburn', 'Leesburg'], places: [],
                },
            ],
            [{ n: 1 }],   // reverse direction count
            [{ n: 3 }],   // touching-both count
            [{ cities_null: 3, places_null: 1 }],
        ]);
        const out = await runTool(
            'trips_between',
            { from_place: 'Ellicott City MD', to_place: 'Ashburn VA', period: 'all_time', travel_mode: 'any' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('between: four queries (ordered union, reverse, touching, missing)', q.calls.length, 4);
        checkMatch('between: SQL walks the ordered pair in BOTH indexes', q.calls[0].text,
            /cities_passed, '\[\]'::jsonb\)\) WITH ORDINALITY.*b\.j > a\.i.*places_passed, '\[\]'::jsonb\)\) WITH ORDINALITY.*b\.j > a\.i/);
        check('between: from candidates lowercased', q.calls[0].params[q.calls[0].params.length - 2], ['ellicott city md', 'ellicott city']);
        check('between: to candidates lowercased', q.calls[0].params[q.calls[0].params.length - 1], ['ashburn va', 'ashburn']);
        checkMatch('between: missing-data query covers both indexes', q.calls[3].text,
            /COUNT\(\*\) FILTER \(WHERE cities_passed IS NULL\).*COUNT\(\*\) FILTER \(WHERE places_passed IS NULL\)/);
        check('between: end-to-end recognized via the places index', out.data.end_to_end_count, 1);
        check('between: ordered pass-through superset counted', out.data.ordered_pass_through_count, 2);
        check('between: reverse count carried', out.data.reverse_count, 1);
        check('between: per-index unindexed counts carried', out.data.journeys_missing_location_data, { cities: 3, places: 1 });
        checkMatch('between: summary leads with the end-to-end count and date', out.summary,
            /1 journey from Ellicott City MD to Ashburn VA in all recorded journeys — on Aug 14, 2026\./);
        checkMatch('between: summary reports the mid-route extra', out.summary,
            /1 more passed through Ellicott City MD and later Ashburn VA mid-route/);
        checkMatch('between: summary reports the reverse direction', out.summary,
            /In the opposite direction \(Ashburn VA to Ellicott City MD\): 1\./);
        checkMatch('between: summary carries the missing-data note', out.summary,
            /location data is still missing for 3 journeys/);
    }
    {
        // Exact miss -> partial pass; zero matches stays honest: opposite
        // direction and direction-unknown journeys are still reported.
        const q = fakeQuery([
            [],           // exact ordered union pass
            [],           // partial ordered union pass
            (text) => {
                checkMatch('between: words tier mixes kinds per side (1-word FROM stays phrase, 2-word TO goes words)',
                    text, /a\.nm ILIKE ANY\(\$\d+::text\[\]\).*b\.nm ILIKE ALL\(\$\d+::text\[\]\)/);
                return [];
            },
            [{ n: 2 }],   // reverse
            [{ n: 4 }],   // touching-both -> 4 - 0 - 2 = 2 direction-unknown
            [{ cities_null: 0, places_null: 0 }],
        ]);
        const out = await runTool(
            'trips_between',
            { from_place: 'Ashburn', to_place: 'Ellicott City', period: 'this_year', travel_mode: 'drive' },
            { period: P('this_year') },
            { ...ctxBase, query: q },
        );
        check('between: six queries when all tiers miss', q.calls.length, 6);
        checkMatch('between: partial pass uses ILIKE ANY', q.calls[1].text, /a\.nm ILIKE ANY\(\$\d+::text\[\]\)/);
        check('between: mode filter flows into params', q.calls[0].params[q.calls[0].params.length - 3], 'drive');
        check('between: no-match mode', out.data.match_mode, 'none');
        check('between: direction-unknown computed conservatively', out.data.direction_unknown_count, 2);
        checkMatch('between: zero-match summary names both endpoints', out.summary,
            /No journeys from Ashburn to Ellicott City found in .*driving only \(checked the ordered city and place sequences/);
        checkMatch('between: zero-match summary reports the opposite way', out.summary,
            /2 journeys went the opposite way, Ellicott City to Ashburn\./);
        checkMatch('between: zero-match summary reports direction-unknown touches', out.summary,
            /2 journeys touched both Ashburn and Ellicott City, but the recorded sequence doesn't show the direction\./);
    }
    {
        // POI on the FROM side: "Hyattsville Fire Department" is not a
        // substring of the indexed "Hyattsville Volunteer Fire Department",
        // so the words tier must carry the pair.
        const q = fakeQuery([
            [],   // exact
            [],   // partial phrase
            (text, params) => {
                checkMatch('between: words tier requires every FROM word in order search', text,
                    /a\.nm ILIKE ALL\(\$\d+::text\[\]\)/);
                check('between: FROM word patterns', params[params.length - 2],
                    ['%hyattsville%', '%fire%', '%department%']);
                check('between: TO word patterns', params[params.length - 1],
                    ['%college%', '%park%']);
                return [
                    {
                        id: 'r31', name: 'Back to campus', start_time: new Date('2026-03-10T16:00:00Z'), distance: 7.4, travel_mode: 'drive',
                        cities: ['Hyattsville', 'College Park'],
                        places: ['Hyattsville Volunteer Fire Department', 'College Park'],
                    },
                ];
            },
            [{ n: 0 }],   // reverse
            [{ n: 1 }],   // touching-both
            [{ cities_null: 0, places_null: 0 }],
        ]);
        const out = await runTool(
            'trips_between',
            { from_place: 'Hyattsville Fire Department', to_place: 'College Park', period: 'all_time', travel_mode: 'any' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('between: six queries (3 tiers + reverse + touching + missing)', q.calls.length, 6);
        check('between: words match mode', out.data.match_mode, 'words');
        check('between: end-to-end proven via the places sequence', out.data.end_to_end_count, 1);
        checkMatch('between: summary counts the POI-to-city trip', out.summary,
            /1 journey from Hyattsville Fire Department to College Park in all recorded journeys — on Mar 10, 2026\./);
        checkMatch('between: summary notes word-level matching', out.summary, /\(matched by place-name words\)/);
    }

    {
        // A state endpoint gets the same guard as place_visits: no ILIKE tier
        // on that side, so "College Park to California" cannot be answered by
        // a burrito place. The non-state side keeps its escalation.
        const q = fakeQuery([
            (text) => {
                checkMatch('between: state endpoint stays on exact matching', text, /LOWER\(a\.nm\) = ANY/);
                return [];
            },
            (text, params) => {
                checkMatch('between: the non-state side still escalates', text, /a\.nm ILIKE ANY/);
                checkMatch('between: the state side does not', text, /LOWER\(b\.nm\) = ANY/);
                check('between: state side keeps the literal candidate', params[params.length - 1], ['california']);
                return [];
            },
            (text, params) => {
                checkMatch('between: words tier too keeps the state side exact', text, /LOWER\(b\.nm\) = ANY/);
                check('between: words tier splits only the non-state side', params[params.length - 2], ['%college%', '%park%']);
                return [];
            },
            [{ n: 0 }],   // reverse
            [{ n: 0 }],   // touching-both
            [{ cities_null: 0, places_null: 0 }],
        ]);
        const out = await runTool(
            'trips_between',
            { from_place: 'College Park', to_place: 'California', period: 'all_time', travel_mode: 'any' },
            { period: P('all_time') },
            { ...ctxBase, query: q },
        );
        check('between: six queries (3 tiers + reverse + touching + missing)', q.calls.length, 6);
        check('between: state endpoint reported', out.data.us_state_endpoints, ['California']);
        check('between: nothing found', out.data.end_to_end_count, 0);
        checkMatch('between: summary says the state is not answerable', out.summary,
            /California is a US state, and journeys are indexed by the cities and named places they pass through, not by state/);
    }

    /* ---------------- list_journeys ---------------- */

    {
        const q = fakeQuery([
            [
                { id: 'r9', name: 'Coast drive', start_time: new Date('2026-08-20T16:00:00Z'), distance: 42.3, duration: '1h 12m', avg_speed: 35.2, top_speed: 61.0, travel_mode: 'drive' },
            ],
        ]);
        const out = await runTool(
            'list_journeys',
            { period: 'last_month', travel_mode: 'any', sort: 'distance_desc', limit: 1 },
            { period: P('last_month') },
            { ...ctxBase, query: q },
        );
        checkMatch('list: ORDER BY comes from the whitelist', q.calls[0].text, /ORDER BY distance DESC NULLS LAST/);
        check('list: limit is the final parameter', q.calls[0].params, [0.25, TZ, '2026-07-01', '2026-07-31', 1]);
        checkMatch('list: line format', out.summary, /1\. Coast drive — 42\.3 miles, 1h 12m, driving, Aug 20, 2026/);
        check('list: every sort value has SQL', Object.keys(SORT_SQL).length, 7);
    }

    /* ---------------- travel_mode_breakdown ---------------- */

    {
        const q = fakeQuery([
            [
                { mode: 'drive', journey_count: 18, distance_mi: 412.7, duration_s: 43440 },
                { mode: 'foot', journey_count: 9, distance_mi: 23.1, duration_s: 27840 },
            ],
        ]);
        const out = await runTool(
            'travel_mode_breakdown',
            { period: 'this_month' },
            { period: P('this_month') },
            { ...ctxBase, query: q },
        );
        checkMatch('breakdown: SQL groups by mode with COALESCE', q.calls[0].text, /COALESCE\(travel_mode, 'unknown'\)/);
        check('breakdown: share percentages', out.data.modes.map((m) => m.share_pct), [95, 5]);
        checkMatch('breakdown: summary walks the modes in distance order', out.summary,
            /driving: 412\.7 miles \(95%\) across 18 journeys, 12h 4m; on foot: 23\.1 miles \(5%\) across 9 journeys, 7h 44m\./);
    }

    report('handlers.test');
}

main().catch((err) => { console.error(err); process.exit(1); });
