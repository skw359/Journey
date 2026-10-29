'use strict';

/**
 * Tool handlers for Marco. One function per tool; every SQL statement in the
 * ask feature lives in this file, hand-written — the model never writes a
 * query. Each handler receives already-validated arguments (tools.js), already-
 * resolved periods (periods.js), and a `ctx`:
 *
 *   ctx = {
 *     query(text, params) -> { rows }   tenant-scoped executor, injected —
 *                                       production binds queryTenant(userId),
 *                                       tests inject a fake
 *     tz        IANA timezone for bucketing (e.g. 'America/New_York')
 *     units     'imperial' | 'metric'
 *     minMiles  MIN_ROUTE_MILES, so Marco counts the same journeys the UI shows
 *   }
 *
 * Every handler returns { data, summary }. `summary` is a finished, unit-
 * correct sentence built HERE — the model only rephrases it, so a phrasing
 * failure can never corrupt a number.
 *
 * Timezone rule: bucketing compares `(start_time AT TIME ZONE tz)::date`
 * against inclusive civil dates. Postgres owns the conversion, so DST is its
 * problem, not ours. Rows with NULL start_time cannot be bucketed; ranged
 * handlers count them separately and the summary says so instead of silently
 * pretending they do not exist.
 */

const {
    fmtDistance, fmtSpeed, fmtElevation, fmtDuration, fmtPctChange,
    fmtJourneys, fmtMetric, fmtMetricDiff, prettyCivil, civilInZone, modeLabel,
} = require('./format');
const { todayInZone, rangeLabel, addDays } = require('./periods');

/* ------------------------------------------------------------------ *
 * Shared SQL building blocks
 * ------------------------------------------------------------------ */

/**
 * Visibility filter matching GET /api/routes exactly: a journey Marco counts
 * is a journey the dashboard shows.
 */
const VISIBLE = '(distance >= $1 OR force_visible = TRUE)';

/**
 * Sum of per-journey moving time, from the recorded timestamps rather than
 * the display-formatted duration text column.
 */
const DURATION_SUM = `COALESCE(SUM(EXTRACT(EPOCH FROM (end_time - start_time)))
      FILTER (WHERE start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time), 0)::float`;

/**
 * Compose the WHERE clause for a handler query.
 *
 * @param {object} opts
 * @param {object|null} opts.range    resolved period ({start, end} civil dates, or null/all_time)
 * @param {string} [opts.mode]        travel mode filter; 'any' or falsy means none
 * @param {object|null} [opts.exclude] resolved period to subtract from the range
 * @param {boolean} [opts.datedOnly]  drop rows with no start_time (unbounded averages)
 * @param {object} ctx
 * @returns {{ where: string, params: any[] }}  params[0] is always minMiles
 */
function buildWhere({ range, mode, exclude = null, datedOnly = false }, ctx) {
    const clauses = [VISIBLE];
    const params = [ctx.minMiles];

    if (range && range.start !== null && range.end !== null) {
        params.push(ctx.tz, range.start, range.end);
        clauses.push(
            `(start_time AT TIME ZONE $${params.length - 2})::date BETWEEN $${params.length - 1} AND $${params.length}`
        );
    }

    // COALESCE, because for a row with no start_time the BETWEEN is NULL and a
    // bare NOT NULL would silently drop it — an exclusion window must only
    // remove rows that are provably inside it. (When a period range is also
    // present, undated rows are already outside it, exactly as before.)
    if (exclude && exclude.start !== null && exclude.end !== null) {
        params.push(ctx.tz, exclude.start, exclude.end);
        clauses.push(
            `NOT COALESCE((start_time AT TIME ZONE $${params.length - 2})::date BETWEEN $${params.length - 1} AND $${params.length}, FALSE)`
        );
    }

    if (datedOnly) {
        clauses.push('start_time IS NOT NULL');
    }

    if (mode && mode !== 'any') {
        params.push(mode);
        clauses.push(`travel_mode = $${params.length}`);
    }

    return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

/** Aggregate totals for one period. */
async function aggregate(ctx, { range, mode, exclude = null, datedOnly = false }) {
    const { where, params } = buildWhere({ range, mode, exclude, datedOnly }, ctx);
    const { rows } = await ctx.query(`
        SELECT
            COUNT(*)::int AS journey_count,
            COALESCE(SUM(distance), 0)::float AS distance_mi,
            ${DURATION_SUM} AS duration_s,
            AVG(avg_speed)::float AS avg_speed_mph,
            MAX(top_speed)::float AS top_speed_mph,
            COALESCE(SUM(elevation_gain), 0)::float AS elevation_gain_m
        FROM routes
        ${where}
    `, params);
    return rows[0];
}

/**
 * Journeys that can never match any dated range because they have no
 * start_time. Reported so ranged answers can be caveated honestly.
 */
async function countUndated(ctx, { mode }) {
    const { where, params } = buildWhere({ range: null, mode }, ctx);
    const { rows } = await ctx.query(`
        SELECT COUNT(*)::int AS n
        FROM routes
        ${where} AND start_time IS NULL
    `, params);
    return rows[0].n;
}

function undatedCaveat(n) {
    return n > 0
        ? ` (${n === 1 ? '1 journey has' : `${n} journeys have`} no recorded date and ${n === 1 ? 'is' : 'are'} not included)`
        : '';
}

/* ------------------------------------------------------------------ *
 * Calendar arithmetic for per-unit averages. Civil YYYY-MM-DD strings,
 * parsed as UTC midnights so a day is always exactly 24h here — DST lives
 * in Postgres, which produced the civil dates in the first place.
 * ------------------------------------------------------------------ */

const DAY_MS = 86400000;
const AVERAGE_UNIT_DAYS = { day: 1, week: 7, month: 30.4375 }; // 365.25 / 12
const AVERAGE_UNIT_LABEL = { day: 'per day', week: 'per week', month: 'per month' };

function civilMs(civil) {
    return Date.parse(`${civil}T00:00:00Z`);
}

function daysInclusive(start, end) {
    return Math.round((civilMs(end) - civilMs(start)) / DAY_MS) + 1;
}

/** Inclusive day count of the intersection of two civil ranges; 0 if disjoint. */
function overlapDays(a, b) {
    const start = a.start > b.start ? a.start : b.start;
    const end = a.end < b.end ? a.end : b.end;
    return start <= end ? daysInclusive(start, end) : 0;
}

/** First dated journey's civil day under the current filters, or null. */
async function firstJourneyDay(ctx, { mode }) {
    const { where, params } = buildWhere({ range: null, mode }, ctx);
    const { rows } = await ctx.query(`
        SELECT MIN((start_time AT TIME ZONE $${params.length + 1})::date)::text AS first_day
        FROM routes
        ${where} AND start_time IS NOT NULL
    `, [...params, ctx.tz]);
    return rows[0]?.first_day || null;
}

function modePhrase(mode) {
    return mode && mode !== 'any' ? `, ${modeLabel(mode)} only` : '';
}

/* ------------------------------------------------------------------ *
 * Metric definitions shared by compare_periods and stats_summary
 * ------------------------------------------------------------------ */

const METRIC_INFO = {
    distance: { field: 'distance_mi', kind: 'distance', label: 'Distance' },
    duration: { field: 'duration_s', kind: 'duration', label: 'Time in motion' },
    avg_speed: { field: 'avg_speed_mph', kind: 'speed', label: 'Average speed', isMean: true },
    top_speed: { field: 'top_speed_mph', kind: 'speed', label: 'Top speed', isMean: true },
    elevation_gain: { field: 'elevation_gain_m', kind: 'elevation', label: 'Elevation gain' },
    journey_count: { field: 'journey_count', kind: 'count', label: 'Journey count' },
};

/* ------------------------------------------------------------------ *
 * Change breakdown for additive comparisons: which trips moved the
 * total, the busiest day on each side, and a like-for-like baseline
 * when the near period is still in progress.
 * ------------------------------------------------------------------ */

// Per-journey contribution for metrics that sum; means (speeds) don't attribute.
const ROW_VALUE = {
    distance: (r) => r.distance_mi,
    duration: (r) => r.duration_s,
    journey_count: () => 1,
    elevation_gain: (r) => r.elevation_gain_m,
};

// In-progress period -> the finished period it is naturally compared with.
const IN_PROGRESS_PARTNER = { this_week: 'last_week', this_month: 'last_month', this_year: 'last_year' };
const PERIOD_NOUN = {
    this_week: 'this week', last_week: 'last week',
    this_month: 'this month', last_month: 'last month',
    this_year: 'this year', last_year: 'last year',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_DRIVERS = 3;

async function journeyRows(ctx, { range, mode }) {
    const { where, params } = buildWhere({ range, mode }, ctx);
    params.push(ctx.tz);
    const { rows } = await ctx.query(`
        SELECT
            (start_time AT TIME ZONE $${params.length})::date::text AS day,
            COALESCE(distance, 0)::float AS distance_mi,
            (CASE WHEN start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time
                  THEN EXTRACT(EPOCH FROM (end_time - start_time)) ELSE 0 END)::float AS duration_s,
            COALESCE(elevation_gain, 0)::float AS elevation_gain_m,
            cities_passed AS cities
        FROM routes
        ${where}
        ORDER BY start_time
    `, params);
    return rows;
}

/**
 * Endpoint cities as an unordered pair, so the out and back legs of one trip
 * group together. A round trip recorded as a single journey uses the middle
 * of its route-ordered city list as the turnaround.
 */
function tripOf(cities) {
    if (!Array.isArray(cities) || cities.length === 0) return null;
    const start = cities[0];
    let far = cities[cities.length - 1];
    if (far === start && cities.length >= 3) far = cities[Math.floor(cities.length / 2)];
    if (far === start) return { key: `around\u0000${start}`, label: `around ${start}` };
    return { key: [start, far].sort().join('\u0000'), label: `${start} ↔ ${far}` };
}

/** '2026-10-13' -> "Tue Oct 13" */
function shortDay(civil) {
    return `${WEEKDAYS[new Date(civilMs(civil)).getUTCDay()]} ${prettyCivil(civil).replace(/, \d{4}$/, '')}`;
}

const sumOf = (rows, valueOf) => rows.reduce((s, r) => s + (Number(valueOf(r)) || 0), 0);

function glance(rows, units) {
    return {
        journeys: rows.length,
        distance: fmtDistance(sumOf(rows, ROW_VALUE.distance), units),
        time_in_motion: fmtDuration(sumOf(rows, ROW_VALUE.duration)),
    };
}

function busiestDay(rows, valueOf, kind, units) {
    const days = new Map();
    for (const r of rows) {
        if (!r.day) continue;
        const d = days.get(r.day) || { value: 0, journeys: 0, trips: new Map() };
        d.value += Number(valueOf(r)) || 0;
        d.journeys += 1;
        const trip = tripOf(r.cities);
        if (trip && !d.trips.has(trip.key)) d.trips.set(trip.key, trip.label);
        days.set(r.day, d);
    }
    let best = null;
    for (const [day, d] of days) if (!best || d.value > best.d.value) best = { day, d };
    if (!best) return null;
    return {
        date: shortDay(best.day),
        value: fmtMetric(kind, best.d.value, units),
        journeys: best.d.journeys,
        trips: [...best.d.trips.values()].slice(0, 3),
    };
}

/**
 * Attribute the A-minus-B change to trips. Drivers move the total in the
 * same direction as the overall change; everything else is the remainder.
 */
function changeBreakdown(metric, kind, rowsA, rowsB, units) {
    const valueOf = ROW_VALUE[metric];
    const groups = new Map();
    const add = (rows, side) => {
        for (const r of rows) {
            const trip = tripOf(r.cities);
            if (!trip) continue;
            const g = groups.get(trip.key) || {
                label: trip.label,
                a: { journeys: 0, value: 0, days: [] },
                b: { journeys: 0, value: 0, days: [] },
            };
            const s = g[side];
            s.journeys += 1;
            s.value += Number(valueOf(r)) || 0;
            if (r.day && !s.days.includes(r.day)) s.days.push(r.day);
            groups.set(trip.key, g);
        }
    };
    add(rowsA, 'a');
    add(rowsB, 'b');

    const totalA = sumOf(rowsA, valueOf);
    const totalB = sumOf(rowsB, valueOf);
    const total = totalA - totalB;
    const sign = Math.sign(total);

    const ranked = [...groups.values()]
        .map((g) => ({ ...g, change: g.a.value - g.b.value }))
        .filter((g) => g.change !== 0 && (sign === 0 || Math.sign(g.change) === sign))
        .sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
    // Below a tenth of the overall change a "driver" is noise.
    const floor = Math.abs(total) * 0.1;
    const drivers = ranked.filter((g, i) => i === 0 || Math.abs(g.change) >= floor).slice(0, MAX_DRIVERS);

    const side = (s) => ({
        journeys: s.journeys,
        value: fmtMetric(kind, s.value, units),
        days: s.days.slice(0, 4).map(shortDay),
    });
    const driverA = drivers.reduce((s, g) => s + g.a.value, 0);
    const driverB = drivers.reduce((s, g) => s + g.b.value, 0);

    return {
        compared: { period_a: glance(rowsA, units), period_b: glance(rowsB, units) },
        biggest_changes: drivers.map((g) => ({
            trip: g.label,
            period_a: side(g.a),
            period_b: side(g.b),
            change: fmtMetricDiff(kind, g.change, units),
            share_of_change_pct: total !== 0 ? Math.round((g.change / total) * 100) : null,
        })),
        everything_else: drivers.length === 0 ? null : {
            period_a: fmtMetric(kind, totalA - driverA, units),
            period_b: fmtMetric(kind, totalB - driverB, units),
            change: fmtMetricDiff(kind, (totalA - driverA) - (totalB - driverB), units),
        },
        busiest_day: {
            period_a: busiestDay(rowsA, valueOf, kind, units),
            period_b: busiestDay(rowsB, valueOf, kind, units),
        },
    };
}

/**
 * Last civil day of B that lines up with in-progress A (Mon–Thu this week ->
 * Mon–Thu last week), or null when A isn't B's in-progress partner or the
 * cut would cover all of B anyway.
 */
function sameDaysCutoff(rangeA, rangeB) {
    if (IN_PROGRESS_PARTNER[rangeA.token] !== rangeB.token) return null;
    const cut = addDays(rangeB.start, daysInclusive(rangeA.start, rangeA.end) - 1);
    return cut < rangeB.end ? cut : null;
}

/* ------------------------------------------------------------------ *
 * compare_periods
 * ------------------------------------------------------------------ */

async function compare_periods(args, periods, ctx) {
    const info = METRIC_INFO[args.metric];
    const rangeA = periods.period_a;
    const rangeB = periods.period_b;

    const [a, b, undated] = [
        await aggregate(ctx, { range: rangeA, mode: args.travel_mode }),
        await aggregate(ctx, { range: rangeB, mode: args.travel_mode }),
        await countUndated(ctx, { mode: args.travel_mode }),
    ];

    const valueA = a[info.field];
    const valueB = b[info.field];

    const data = {
        metric: args.metric,
        travel_mode: args.travel_mode,
        period_a: { ...describeRange(rangeA), totals: a },
        period_b: { ...describeRange(rangeB), totals: b },
        undated_journeys: undated,
    };

    // Averages over zero journeys are absence, not zero — say so instead of
    // reporting a fake 0 that a percentage would then amplify.
    if (a.journey_count === 0 && b.journey_count === 0) {
        return {
            data,
            summary: `No journeys recorded in either ${rangeA.label} or ${rangeB.label}`
                + `${modePhrase(args.travel_mode)}.${undatedCaveat(undated)}`,
        };
    }
    if (b.journey_count === 0) {
        return {
            data,
            summary: `${info.label}${modePhrase(args.travel_mode)}: `
                + `${fmtMetric(info.kind, valueA, ctx.units)} in ${rangeA.label} `
                + `(${fmtJourneys(a.journey_count)}), but no journeys at all in ${rangeB.label}, `
                + `so there is nothing to compare against.${undatedCaveat(undated)}`,
        };
    }
    if (a.journey_count === 0) {
        return {
            data,
            summary: `No journeys${modePhrase(args.travel_mode)} in ${rangeA.label}, `
                + `versus ${fmtMetric(info.kind, valueB, ctx.units)} `
                + `(${fmtJourneys(b.journey_count)}) in ${rangeB.label}.${undatedCaveat(undated)}`,
        };
    }

    // A half-finished week measured against a whole one always reads as a
    // drop, so an in-progress A is compared with the same days of B.
    let baseValue = valueB;
    let baseCount = b.journey_count;
    let rowsA = null;
    let rowsB = null;
    let sameDays = null;
    const valueOf = ROW_VALUE[args.metric];
    if (valueOf) {
        rowsA = await journeyRows(ctx, { range: rangeA, mode: args.travel_mode });
        rowsB = await journeyRows(ctx, { range: rangeB, mode: args.travel_mode });
        const cut = sameDaysCutoff(rangeA, rangeB);
        const early = cut ? rowsB.filter((r) => r.day && r.day <= cut) : [];
        if (early.length > 0) {
            baseValue = sumOf(early, valueOf);
            baseCount = early.length;
            sameDays = { start: rangeB.start, end: cut, label: rangeLabel(rangeB.start, cut) };
            rowsB = early;
        }
    }

    const diff = (Number(valueA) || 0) - (Number(baseValue) || 0);
    const pct = Number(baseValue) !== 0 ? (diff / Number(baseValue)) * 100 : null;
    data.difference = diff;
    data.pct_change = pct;

    const pctText = fmtPctChange(pct);
    const diffText = fmtMetricDiff(info.kind, diff, ctx.units);
    const changeText = pctText === 'about the same' ? 'about the same'
        : pctText ? `${pctText} (${diffText})` : diffText;

    const sentences = [];
    if (sameDays) {
        const nounA = PERIOD_NOUN[rangeA.token];
        const nounB = PERIOD_NOUN[rangeB.token];
        const projected = (Number(valueA) || 0) + (Number(valueB) || 0) - baseValue;
        data.same_days_of_period_b = { ...sameDays, value: fmtMetric(info.kind, baseValue, ctx.units), journeys: baseCount };
        data.projection = {
            assumes: `the rest of ${nounA} matches the rest of ${nounB}`,
            period_a_would_finish_near: fmtMetric(info.kind, projected, ctx.units),
            period_b_full_total: fmtMetric(info.kind, valueB, ctx.units),
        };
        sentences.push(`${info.label}${modePhrase(args.travel_mode)}: `
            + `${fmtMetric(info.kind, valueA, ctx.units)} so far in ${rangeA.label} (${fmtJourneys(a.journey_count)}) `
            + `vs ${fmtMetric(info.kind, baseValue, ctx.units)} over the same days of ${nounB}, `
            + `${sameDays.label} (${fmtJourneys(baseCount)}) — ${changeText}.`);
        sentences.push(`All of ${nounB} came to ${fmtMetric(info.kind, valueB, ctx.units)}; `
            + `if the rest of ${nounA} matches it, ${nounA} would finish near ${fmtMetric(info.kind, projected, ctx.units)}.`);
    } else {
        sentences.push(`${info.label}${modePhrase(args.travel_mode)}: `
            + `${fmtMetric(info.kind, valueA, ctx.units)} in ${rangeA.label} (${fmtJourneys(a.journey_count)}) `
            + `vs ${fmtMetric(info.kind, valueB, ctx.units)} in ${rangeB.label} (${fmtJourneys(b.journey_count)}) `
            + `— ${changeText}.`);
    }

    if (rowsA) {
        data.breakdown = changeBreakdown(args.metric, info.kind, rowsA, rowsB, ctx.units);
        const top = data.breakdown.biggest_changes[0];
        if (top && top.share_of_change_pct != null && diff !== 0) {
            sentences.push(`Biggest contributor: ${top.trip}, ${fmtJourneys(top.period_a.journeys)} vs `
                + `${top.period_b.journeys} (${top.change}, ${top.share_of_change_pct}% of the change).`);
        }
    }

    return {
        data,
        summary: sentences.join(' ') + undatedCaveat(undated),
    };
}

/* ------------------------------------------------------------------ *
 * stats_summary
 * ------------------------------------------------------------------ */

async function stats_summary(args, periods, ctx) {
    const range = periods.period;
    const exclude = periods.exclude || null;
    const averagePer = args.average_per || null;
    const bounded = range.start !== null;
    const excluding = Boolean(exclude && exclude.start !== null);

    // An unbounded ("all time") average needs a floor — the first dated
    // journey. Undated rows cannot sit inside any span, so that path counts
    // dated journeys only and the standard caveat reports the rest; every
    // other path keeps its existing behaviour exactly.
    const datedOnly = Boolean(averagePer) && !bounded;
    const totals = await aggregate(ctx, { range, mode: args.travel_mode, exclude, datedOnly });
    const undated = (bounded || datedOnly)
        ? await countUndated(ctx, { mode: args.travel_mode })
        : 0;

    const excludePhrase = excluding ? ` excluding ${exclude.label}` : '';
    const scope = (label) => `${label}${excludePhrase}${modePhrase(args.travel_mode)}`;

    const data = {
        travel_mode: args.travel_mode,
        period: { ...describeRange(range), totals },
        undated_journeys: undated,
    };
    if (excluding) data.excluded = describeRange(exclude);

    // ---- The denominator: days actually counted ----------------------
    let span = null;
    if (averagePer) {
        const spanStart = bounded ? range.start : await firstJourneyDay(ctx, { mode: args.travel_mode });
        if (spanStart) {
            const spanEnd = bounded ? range.end : todayInZone(ctx.tz, ctx.now);
            const days = daysInclusive(spanStart, spanEnd);
            const excludedDays = excluding
                ? overlapDays({ start: spanStart, end: spanEnd }, exclude)
                : 0;
            span = {
                start: spanStart,
                end: spanEnd,
                days,
                excluded_days: excludedDays,
                counted_days: days - excludedDays,
            };
            data.average_span = span;
        }
    }

    let average = null;
    if (span && span.counted_days > 0) {
        const unit = AVERAGE_UNIT_DAYS[averagePer];
        average = {
            per: averagePer,
            counted_days: span.counted_days,
            distance_mi: (totals.distance_mi * unit) / span.counted_days,
            duration_s: (totals.duration_s * unit) / span.counted_days,
            journey_count: (totals.journey_count * unit) / span.counted_days,
        };
        data.average = average;
    }

    // ---- Averaging summaries ------------------------------------------
    if (averagePer) {
        if (!span) {
            return {
                data,
                summary: `No dated journeys recorded yet${modePhrase(args.travel_mode)}, so there is no ${AVERAGE_UNIT_LABEL[averagePer]} average to report.${undatedCaveat(undated)}`,
            };
        }
        if (!average) {
            return {
                data,
                summary: `${scope(range.label)}: the excluded range covers every day of the period, so there are no days left to average over.${undatedCaveat(undated)}`,
            };
        }
        if (totals.journey_count === 0) {
            return {
                data,
                summary: `No journeys recorded in ${range.label}${excludePhrase}${modePhrase(args.travel_mode)}.${undatedCaveat(undated)}`,
            };
        }
        const spanLabel = bounded
            ? range.label
            : `Since your first journey on ${prettyCivil(span.start)}`;
        const rate = `${fmtDistance(average.distance_mi, ctx.units)} and ${Number(average.journey_count.toFixed(1))} journeys ${AVERAGE_UNIT_LABEL[averagePer]}`;
        const basis = `${fmtDistance(totals.distance_mi, ctx.units)} across ${fmtJourneys(totals.journey_count)} over ${span.counted_days} counted days`;
        return {
            data,
            summary: `${scope(spanLabel)}: averaging ${rate}, from ${basis}.${undatedCaveat(undated)}`,
        };
    }

    // ---- Plain totals (with or without an exclusion) -------------------
    if (totals.journey_count === 0) {
        return {
            data,
            summary: `No journeys recorded in ${range.label}${excludePhrase}${modePhrase(args.travel_mode)}.${undatedCaveat(undated)}`,
        };
    }

    const parts = [
        fmtJourneys(totals.journey_count),
        fmtDistance(totals.distance_mi, ctx.units),
        `${fmtDuration(totals.duration_s)} in motion`,
    ];
    if (totals.avg_speed_mph != null) parts.push(`average speed ${fmtSpeed(totals.avg_speed_mph, ctx.units)}`);
    if (totals.top_speed_mph != null) parts.push(`top speed ${fmtSpeed(totals.top_speed_mph, ctx.units)}`);
    if (totals.elevation_gain_m > 0) parts.push(`${fmtElevation(totals.elevation_gain_m, ctx.units)} of climbing`);

    return {
        data,
        summary: `${scope(range.label)}: ${parts.join(', ')}.${undatedCaveat(undated)}`,
    };
}

/* ------------------------------------------------------------------ *
 * new_places
 * ------------------------------------------------------------------ */

const GRANULARITY_COLUMN = {
    city: 'cities_passed',
    place: 'places_passed',
};

async function fetchPlaceSets(ctx, { range, column, beforeCivil = null, withDates = false }) {
    // beforeCivil: when set, restrict to journeys strictly before that civil
    // date instead of a BETWEEN range (the all_time-baseline case).
    // withDates: also select each row's civil day and walk rows in time order,
    // so "first seen" is first in time and each name gets a debut date.
    const clauses = [VISIBLE];
    const params = [ctx.minMiles];
    let tzIdx = null;

    if (beforeCivil !== null) {
        params.push(ctx.tz, beforeCivil);
        tzIdx = params.length - 1;
        clauses.push(`(start_time AT TIME ZONE $${tzIdx})::date < $${params.length}`);
    } else if (range && range.start !== null) {
        params.push(ctx.tz, range.start, range.end);
        tzIdx = params.length - 2;
        clauses.push(
            `(start_time AT TIME ZONE $${tzIdx})::date BETWEEN $${params.length - 1} AND $${params.length}`
        );
    }

    const dateSelect = withDates && tzIdx !== null
        ? `, ((start_time AT TIME ZONE $${tzIdx})::date)::text AS civil`
        : '';
    const { rows } = await ctx.query(`
        SELECT ${column} AS arr${dateSelect}
        FROM routes
        WHERE ${clauses.join(' AND ')}${withDates ? '\n        ORDER BY start_time ASC NULLS LAST' : ''}
    `, params);

    // Case-insensitive set, first-seen casing preserved for display.
    // NULL column = location data not computed yet (journeys.js counts
    // cities_passed IS NOT NULL as "processed"); [] = processed, none found.
    const seen = new Map();
    const firstSeen = new Map();
    let journeys = 0;
    let missing = 0;
    for (const row of rows) {
        journeys++;
        if (row.arr === null || row.arr === undefined) { missing++; continue; }
        for (const name of row.arr) {
            if (typeof name !== 'string' || !name.trim()) continue;
            const key = name.trim().toLowerCase();
            if (!seen.has(key)) {
                seen.set(key, name.trim());
                if (typeof row.civil === 'string') firstSeen.set(key, row.civil);
            }
        }
    }
    return { names: seen, firstSeen, journeys, missing };
}

async function new_places(args, periods, ctx) {
    const column = GRANULARITY_COLUMN[args.granularity];
    const noun = args.granularity === 'city' ? 'cities' : 'places';
    const period = periods.period;
    const baseline = periods.compared_to;

    if (period.start === null) {
        return {
            data: { error: 'period_all_time' },
            summary: `"New ${noun} of all time" is not answerable — every ${args.granularity} is new the first time. `
                + `Ask about a specific period, like this week or last month.`,
        };
    }

    // "New for me" against all_time means: never seen STRICTLY BEFORE this
    // period started. Using the raw all_time range would include the period
    // itself in the baseline and every genuinely new place would cancel out.
    const baselineIsAllTime = baseline.start === null;
    const current = await fetchPlaceSets(ctx, { range: period, column, withDates: true });
    const base = baselineIsAllTime
        ? await fetchPlaceSets(ctx, { range: null, column, beforeCivil: period.start })
        : await fetchPlaceSets(ctx, { range: baseline, column });

    const fresh = [];
    const repeats = [];
    const debutsByDay = new Map();
    for (const [key, display] of current.names) {
        if (base.names.has(key)) { repeats.push(display); continue; }
        fresh.push(display);
        const day = current.firstSeen.get(key);
        if (day) debutsByDay.set(day, (debutsByDay.get(day) || 0) + 1);
    }
    fresh.sort((x, y) => x.localeCompare(y));
    repeats.sort((x, y) => x.localeCompare(y));

    // The day the most debuts happened, so the answer can say "Aug 27 brought
    // the most new cities" without the model counting. Ties go to the earlier day.
    let mostNewOn = null;
    for (const [day, count] of debutsByDay) {
        if (!mostNewOn || count > mostNewOn.count || (count === mostNewOn.count && day < mostNewOn.date)) {
            mostNewOn = { date: day, count };
        }
    }
    if (mostNewOn) mostNewOn = { date: mostNewOn.date, label: prettyCivil(mostNewOn.date), count: mostNewOn.count };

    const baselineLabel = baselineIsAllTime ? `anything before ${prettyCivil(period.start)}` : baseline.label;
    const data = {
        granularity: args.granularity,
        period: describeRange(period),
        baseline: baselineIsAllTime
            ? { token: 'all_time', label: baselineLabel, strictly_before: period.start }
            : describeRange(baseline),
        new_places: fresh,
        new_place_count: fresh.length,
        repeat_places: repeats,
        repeat_place_count: repeats.length,
        period_place_count: current.names.size,
        baseline_place_count: base.names.size,
        most_new_places_on: mostNewOn,
        journeys_missing_location_data: { period: current.missing, baseline: base.missing },
    };

    const missingNote = current.missing > 0 || base.missing > 0
        ? ` Note: location data is still missing for ${current.missing + base.missing} `
        + `${current.missing + base.missing === 1 ? 'journey' : 'journeys'}, so this may be incomplete.`
        : '';

    if (current.journeys === 0) {
        return { data, summary: `No journeys recorded in ${period.label}, so no new ${noun} to report.` };
    }
    if (fresh.length === 0) {
        return {
            data,
            summary: `No new ${noun} in ${period.label} — all ${current.names.size} `
                + `${current.names.size === 1 ? args.granularity : noun} visited had already been visited in ${baselineLabel}.${missingNote}`,
        };
    }

    const shown = fresh.slice(0, 15);
    const more = fresh.length - shown.length;

    // Supporting context, all counted here: totals and the repeat/new split,
    // the baseline's own count (pointless against an all-time baseline), and
    // the busiest debut day when it actually stands out (≥2 debuts and ≥2
    // distinct days — a tie at one apiece is not a standout).
    const support = [];
    if (repeats.length > 0) {
        support.push(`${current.names.size} ${noun} visited in total — ${fresh.length} new, `
            + `${repeats.length} repeat${repeats.length === 1 ? '' : 's'}`);
    } else if (current.names.size > 1) {
        support.push(`all ${current.names.size} ${noun} visited were new`);
    }
    if (!baselineIsAllTime) {
        support.push(`${baselineLabel} had ${base.names.size === 1 ? `1 ${args.granularity}` : `${base.names.size} ${noun}`}`);
    }
    const joined = support.join('; ');
    const supportSentence = joined ? ` ${joined[0].toUpperCase()}${joined.slice(1)}.` : '';
    const busiest = mostNewOn && mostNewOn.count >= 2 && debutsByDay.size >= 2
        ? ` ${mostNewOn.label} brought the most new ${noun} (${mostNewOn.count}).`
        : '';

    return {
        data,
        summary: `${fresh.length} new ${fresh.length === 1 ? args.granularity : noun} in ${period.label} `
            + `compared with ${baselineLabel}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`
            + `${supportSentence}${busiest}${missingNote}`,
    };
}

/* ------------------------------------------------------------------ *
 * Place-name normalization (shared by place_visits and trips_between)
 * ------------------------------------------------------------------ */

function escapeLike(value) {
    return String(value).replace(/([\\%_])/g, '\\$1');
}

// The geocoder stores bare city names ("Salisbury", never "Salisbury, MD" —
// see utils/cities.js), but people naturally write "Salisbury MD" or
// "Salisbury, Maryland". Matching the user's text verbatim therefore
// guaranteed zero rows for the most common phrasing there is. These helpers
// derive the candidate forms to try: the literal text first, then a
// state-suffix-stripped form.

const US_STATE_ABBREVS = new Set([
    'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id',
    'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms',
    'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok',
    'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv',
    'wi', 'wy', 'dc',
]);

const US_STATE_NAMES = new Set([
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
    'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
    'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
    'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
    'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
    'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
    'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
    'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
    'washington', 'west virginia', 'wisconsin', 'wyoming',
    'district of columbia',
]);

/**
 * Strip one trailing US state qualifier, conservatively. Only two shapes are
 * recognized — a comma before the qualifier ("Salisbury, Maryland") or a bare
 * two-letter USPS code ("Salisbury MD") — so real city names that merely END
 * in a state word ("Port Washington") are never mangled.
 * Returns the stripped form, or null when nothing safe was found.
 */
function stripTrailingState(value) {
    const v = String(value || '').trim();

    // "City, State" / "City, ST" / "City, D.C." — the comma makes it explicit.
    const comma = v.match(/^(.+?)\s*,\s*([A-Za-z][A-Za-z.\s]*)$/);
    if (comma) {
        const tail = comma[2].trim().toLowerCase().replace(/\.+$/, '');
        const bare = tail.replace(/\./g, '');
        if (US_STATE_NAMES.has(tail) || (bare.length === 2 && US_STATE_ABBREVS.has(bare))) {
            const head = comma[1].trim();
            if (head) return head;
        }
    }

    // "City ST" — a trailing two-letter USPS code without a comma.
    const abbrev = v.match(/^(.+?)\s+([A-Za-z]{2})\.?$/);
    if (abbrev && US_STATE_ABBREVS.has(abbrev[2].toLowerCase())) {
        const head = abbrev[1].replace(/,\s*$/, '').trim();
        if (head) return head;
    }

    // "Washington D.C." — dotted DC never fits the two-letter shape above.
    const dc = v.match(/^(.+?)\s+d\.?c\.?$/i);
    if (dc) {
        const head = dc[1].replace(/,\s*$/, '').trim();
        if (head) return head;
    }

    return null;
}

/**
 * Candidate name forms for one user-written place, most precise first.
 * "Ellicott City MD" -> ["Ellicott City MD", "Ellicott City"];
 * "Seattle" -> ["Seattle"].
 */
function placeCandidates(raw) {
    const primary = String(raw || '').trim();
    if (!primary) return [];
    const stripped = stripTrailingState(primary);
    if (stripped && stripped.toLowerCase() !== primary.toLowerCase()) {
        return [primary, stripped];
    }
    return [primary];
}

/**
 * Is the whole query just a US state (or DC)? The geocoder indexes cities and
 * named places — never states — so partial matching a state name against that
 * index answers "have I been to California?" with "California Tortilla", a
 * burrito place in Maryland. Exact matching still runs: California, New York
 * and Washington are also real city names.
 */
function isStateQuery(raw) {
    const v = String(raw || '').trim().toLowerCase().replace(/\.+$/, '');
    if (US_STATE_NAMES.has(v)) return true;
    const bare = v.replace(/\./g, '');
    return bare.length === 2 && US_STATE_ABBREVS.has(bare);
}

/**
 * Split a place query into significant words for word-level matching.
 * "Hyattsville Fire Department" -> ['hyattsville', 'fire', 'department'].
 */
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'and']);
function placeWords(raw) {
    return String(raw || '')
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Does one stored name match, under the given match mode?
 * `terms` are candidate names for exact/partial, significant WORDS for words.
 */
function nameMatches(name, mode, terms) {
    if (typeof name !== 'string') return false;
    const n = name.toLowerCase();
    if (mode === 'exact') return terms.some((t) => n === t.toLowerCase());
    if (mode === 'words') return terms.every((t) => n.includes(t.toLowerCase()));
    return terms.some((t) => n.includes(t.toLowerCase()));
}

/* ------------------------------------------------------------------ *
 * place_visits
 * ------------------------------------------------------------------ */

async function place_visits(args, periods, ctx) {
    const range = periods.period;
    const placeText = args.place.trim();
    const candidates = placeCandidates(placeText);
    const stateQuery = isStateQuery(placeText);

    const base = buildWhere({ range }, ctx);

    async function search(column, matchSql, values) {
        const params = [...base.params, values];
        const { rows } = await ctx.query(`
            SELECT id, name, start_time, distance, travel_mode, ${column} AS arr
            FROM routes
            ${base.where} AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(COALESCE(${column}, '[]'::jsonb)) v
                WHERE ${matchSql.replace('$N', `$${params.length}`)}
            )
            ORDER BY start_time DESC NULLS LAST
        `, params);
        return rows;
    }

    // The model's granularity is a guess — "been to Ocean City" could mean the
    // city or a boardwalk POI — so a miss on the chosen column falls through to
    // the other one rather than becoming a false "never". Exactness outranks
    // column preference: chosen-exact, other-exact, chosen-partial,
    // other-partial. Candidates cover state-suffix stripping ("Salisbury MD" ->
    // "Salisbury"); ILIKE's default escape character is backslash, which is
    // what escapeLike() emits.
    const chosen = GRANULARITY_COLUMN[args.granularity];
    const other = chosen === 'cities_passed' ? 'places_passed' : 'cities_passed';
    const exactValues = candidates.map((c) => c.toLowerCase());
    const partialValues = candidates.map((c) => `%${escapeLike(c)}%`);

    // Word-level tier for multi-word POI names: "Hyattsville Fire Department"
    // is not a substring of the indexed "Hyattsville Volunteer Fire
    // Department", but every WORD of it is — so require all significant words
    // instead of the whole phrase. Words come from the state-stripped form.
    const words = placeWords(candidates[candidates.length - 1]);
    const wordPatterns = words.map((w) => `%${escapeLike(w)}%`);

    // A bare state name stops at the exact tiers: everything below them is
    // substring matching, which on "California" finds a burrito place.
    const passes = [
        { column: chosen, matchSql: 'LOWER(v) = ANY($N::text[])', values: exactValues, mode: 'exact', terms: candidates },
        { column: other, matchSql: 'LOWER(v) = ANY($N::text[])', values: exactValues, mode: 'exact', terms: candidates },
    ];
    if (!stateQuery) {
        passes.push(
            { column: chosen, matchSql: 'v ILIKE ANY($N::text[])', values: partialValues, mode: 'partial', terms: candidates },
            { column: other, matchSql: 'v ILIKE ANY($N::text[])', values: partialValues, mode: 'partial', terms: candidates },
        );
        if (words.length >= 2) {
            passes.push(
                { column: chosen, matchSql: 'v ILIKE ALL($N::text[])', values: wordPatterns, mode: 'words', terms: words },
                { column: other, matchSql: 'v ILIKE ALL($N::text[])', values: wordPatterns, mode: 'words', terms: words },
            );
        }
    }

    let rows = [];
    let matchMode = 'none';
    let matchedColumn = null;
    let matchedTerms = candidates;
    for (const pass of passes) {
        rows = await search(pass.column, pass.matchSql, pass.values);
        if (rows.length > 0) {
            matchMode = pass.mode;
            matchedColumn = pass.column;
            matchedTerms = pass.terms;
            break;
        }
    }

    // Journeys whose place indexes are not computed yet (NULL, not []) — a
    // "no visits" claim is only honest if it admits how much is unindexed.
    const { rows: [missing] } = await ctx.query(`
        SELECT
            COUNT(*) FILTER (WHERE cities_passed IS NULL)::int AS cities_null,
            COUNT(*) FILTER (WHERE places_passed IS NULL)::int AS places_null
        FROM routes
        ${base.where}
    `, base.params);

    // On a total miss for a multi-word name, surface the closest indexed
    // names (ranked by how many query words they contain, then by journeys)
    // so the answer can say "no 'Hyattsville Fire Dept', but 'Hyattsville
    // Volunteer Fire Department' appears in 12 journeys" instead of a bare
    // "never". Suggestions inform the reply; they are not counted as visits.
    let nearMatches = [];
    if (rows.length === 0 && words.length >= 2 && !stateQuery) {
        const params = [...base.params, wordPatterns];
        const anyWord = `v ILIKE ANY($${params.length}::text[])`;
        const { rows: cands } = await ctx.query(`
            SELECT v AS name, COUNT(*)::int AS journeys FROM (
                SELECT id, v FROM routes, jsonb_array_elements_text(COALESCE(places_passed, '[]'::jsonb)) v
                ${base.where} AND ${anyWord}
                UNION
                SELECT id, v FROM routes, jsonb_array_elements_text(COALESCE(cities_passed, '[]'::jsonb)) v
                ${base.where} AND ${anyWord}
            ) s
            GROUP BY v
            ORDER BY journeys DESC
            LIMIT 25
        `, params);
        nearMatches = cands
            .map((r) => ({
                name: r.name,
                journeys: r.journeys,
                matched_words: words.filter((w) => r.name.toLowerCase().includes(w)).length,
            }))
            .filter((r) => r.matched_words >= 2)
            .sort((x, y) => (y.matched_words - x.matched_words) || (y.journeys - x.journeys))
            .slice(0, 3);
    }

    // Role counts from the ordered city sequence (cities_passed is the route's
    // itinerary: first element = origin city, last = destination city).
    // places_passed is an unordered set, so no roles when the match came from
    // there.
    let matchedName = null;
    let roles = null;
    if (rows.length > 0) {
        if (matchedColumn === 'cities_passed') roles = { started_there: 0, ended_there: 0, passed_through_mid: 0 };
        for (const r of rows) {
            const arr = Array.isArray(r.arr) ? r.arr : [];
            const hits = [];
            for (let i = 0; i < arr.length; i++) {
                if (nameMatches(arr[i], matchMode, matchedTerms)) hits.push(i);
            }
            if (hits.length === 0) continue;
            if (matchedName === null) matchedName = arr[hits[0]];
            if (roles) {
                if (hits.includes(0)) roles.started_there++;
                if (hits.includes(arr.length - 1)) roles.ended_there++;
                if (hits.some((i) => i > 0 && i < arr.length - 1)) roles.passed_through_mid++;
            }
        }
    }

    const visits = rows.map((r) => ({
        id: r.id,
        name: r.name,
        date: civilInZone(r.start_time, ctx.tz),
        distance_mi: r.distance,
        travel_mode: r.travel_mode,
    }));
    const dated = visits.filter((v) => v.date).map((v) => v.date).sort();

    const data = {
        place: args.place,
        candidates,
        granularity: args.granularity,
        matched_granularity: matchedColumn === 'cities_passed' ? 'city'
            : matchedColumn === 'places_passed' ? 'place' : null,
        period: describeRange(range),
        is_us_state: stateQuery,
        match_mode: matchMode,
        matched_name: matchedName,
        visit_count: visits.length,
        roles,
        first_visit: dated[0] || null,
        last_visit: dated[dated.length - 1] || null,
        recent_visits: visits.slice(0, 5),
        near_matches: nearMatches,
        journeys_missing_location_data: { cities: missing.cities_null, places: missing.places_null },
    };

    if (visits.length === 0) {
        const strippedNote = candidates.length > 1 ? ` and the state-stripped form "${candidates[1]}"` : '';
        const unindexed = Math.max(missing.cities_null, missing.places_null);
        const missingNote = unindexed > 0
            ? ` Note: location data is still missing for ${unindexed} ${unindexed === 1 ? 'journey' : 'journeys'}, so this may be incomplete.`
            : '';
        const nearNote = nearMatches.length > 0
            ? ` Closest indexed place names: ${nearMatches
                .map((s) => `"${s.name}" (${s.journeys} ${s.journeys === 1 ? 'journey' : 'journeys'})`)
                .join(', ')} — one of these is probably the place meant.`
            : '';
        if (stateQuery) {
            return {
                data,
                summary: `Journeys are indexed by the cities and named places they pass through, `
                    + `not by state, so whether any journey entered the state of ${args.place} is `
                    + `not answerable from this data. No city or named place recorded as exactly `
                    + `"${args.place}" appears in ${range.label} either.${missingNote}`,
            };
        }
        return {
            data,
            summary: `No visits to "${args.place}" found in ${range.label} `
                + `(checked both cities and named places on every journey, `
                + `including partial and word-level name matches${strippedNote}).${nearNote}${missingNote}`,
        };
    }

    let matchNote = '';
    if (matchedName && matchedName.toLowerCase() !== placeText.toLowerCase()) matchNote = ` (matched as "${matchedName}")`;
    else if (matchMode === 'partial') matchNote = ` (matched by partial name against "${placeText}")`;
    const stateNote = stateQuery
        ? ` That is the city or named place recorded as "${matchedName || placeText}", not the state of `
            + `the same name — journeys are not indexed by state.`
        : '';

    const colNull = matchedColumn === 'cities_passed' ? missing.cities_null : missing.places_null;
    const missingNote = colNull > 0
        ? ` Note: location data is still missing for ${colNull} ${colNull === 1 ? 'journey' : 'journeys'}, so the count may be low.`
        : '';
    const rolesText = roles
        ? ` (started there ${roles.started_there}, ended there ${roles.ended_there}, passed through mid-route ${roles.passed_through_mid})`
        : '';
    const firstLast = dated.length > 0
        ? ` — first on ${prettyCivil(dated[0])}, most recently ${prettyCivil(dated[dated.length - 1])}`
        : '';
    return {
        data,
        summary: `${visits.length} ${visits.length === 1 ? 'journey' : 'journeys'} through ${args.place} `
            + `in ${range.label}${rolesText}${firstLast}.${matchNote}${stateNote}${missingNote}`,
    };
}

/* ------------------------------------------------------------------ *
 * trips_between
 * ------------------------------------------------------------------ */

async function trips_between(args, periods, ctx) {
    const range = periods.period;
    const fromText = args.from_place.trim();
    const toText = args.to_place.trim();
    const fromCands = placeCandidates(fromText);
    const toCands = placeCandidates(toText);

    const base = buildWhere({ range, mode: args.travel_mode }, ctx);

    // Both geocode indexes are route-ordered — cities_passed consecutively
    // deduped, places_passed by first encounter — and they complement each
    // other: unincorporated areas (Ashburn VA, say) never appear as a "city"
    // at all — the geocoder stores their micro-communities (Loudoun Valley
    // Estates, Moorefield, McNair, ...) — but DO appear by name in
    // places_passed. So a from->to journey is one where EITHER index contains
    // a FROM match strictly before a TO match. End-to-end rows (first entry
    // matches FROM, last matches TO in either index) are classified in JS
    // from the same result set.
    const orderedExists = (column, f, t) => `EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(${column}, '[]'::jsonb)) WITH ORDINALITY a(nm, i),
                     jsonb_array_elements_text(COALESCE(${column}, '[]'::jsonb)) WITH ORDINALITY b(nm, j)
                WHERE b.j > a.i AND ${f} AND ${t}
            )`;
    const memberExists = (column, m) => `EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(COALESCE(${column}, '[]'::jsonb)) v
                WHERE ${m}
            )`;

    // Matching escalates per SIDE exactly like place_visits: exact name, then
    // whole-phrase substring, then all-significant-words — so POIs work on
    // either end ("from Hyattsville Fire Department to College Park" matches
    // the indexed "Hyattsville Volunteer Fire Department"). Each side carries
    // its own kind/values/terms; a side without 2+ significant words keeps
    // phrase matching in the words tier.
    const SQL_BY_KIND = {
        exact: (ref, p) => `LOWER(${ref}) = ANY(${p}::text[])`,
        partial: (ref, p) => `${ref} ILIKE ANY(${p}::text[])`,
        words: (ref, p) => `${ref} ILIKE ALL(${p}::text[])`,
    };
    const lower = (cands) => cands.map((c) => c.toLowerCase());
    const patterns = (terms) => terms.map((t) => `%${escapeLike(t)}%`);

    // A side that is a bare state name never escalates past exact matching —
    // see isStateQuery. The other side still does, so "from Hyattsville Fire
    // Department to Nevada" keeps its POI matching on the end that has one.
    const makeSide = (cands, text) => {
        const stateQuery = isStateQuery(text);
        const words = placeWords(cands[cands.length - 1]);
        const exact = { kind: 'exact', values: lower(cands), terms: cands };
        return {
            stateQuery,
            exact,
            partial: stateQuery ? exact : { kind: 'partial', values: patterns(cands), terms: cands },
            words: !stateQuery && words.length >= 2
                ? { kind: 'words', values: patterns(words), terms: words }
                : null,
        };
    };
    const fromSide = makeSide(fromCands, fromText);
    const toSide = makeSide(toCands, toText);

    const tiers = [
        { mode: 'exact', from: fromSide.exact, to: toSide.exact },
    ];
    if (!fromSide.stateQuery || !toSide.stateQuery) {
        tiers.push({ mode: 'partial', from: fromSide.partial, to: toSide.partial });
    }
    if (fromSide.words || toSide.words) {
        tiers.push({
            mode: 'words',
            from: fromSide.words || fromSide.partial,
            to: toSide.words || toSide.partial,
        });
    }

    async function searchOrdered(tier) {
        const params = [...base.params, tier.from.values, tier.to.values];
        const f = SQL_BY_KIND[tier.from.kind]('a.nm', `$${params.length - 1}`);
        const t = SQL_BY_KIND[tier.to.kind]('b.nm', `$${params.length}`);
        const { rows } = await ctx.query(`
            SELECT id, name, start_time, distance, travel_mode,
                   cities_passed AS cities, places_passed AS places
            FROM routes
            ${base.where} AND (
                ${orderedExists('cities_passed', f, t)}
                OR ${orderedExists('places_passed', f, t)}
            )
            ORDER BY start_time DESC NULLS LAST
        `, params);
        return rows;
    }

    let rows = [];
    let winner = tiers[tiers.length - 1];   // broadest tier, for zero-match follow-ups
    let matchMode = 'none';
    for (const tier of tiers) {
        rows = await searchOrdered(tier);
        if (rows.length > 0) {
            winner = tier;
            matchMode = tier.mode;
            break;
        }
    }

    const endsMatch = (arr) => Array.isArray(arr) && arr.length > 0
        && nameMatches(arr[0], winner.from.kind, winner.from.terms)
        && nameMatches(arr[arr.length - 1], winner.to.kind, winner.to.terms);
    const endToEnd = rows.filter((r) => endsMatch(r.cities) || endsMatch(r.places));

    // Opposite direction, same union semantics (TO strictly before FROM),
    // matched at the tier that found rows (broadest tier when none did, so
    // the honest notes below don't under-report).
    async function countReverse() {
        const params = [...base.params, winner.to.values, winner.from.values];
        const f = SQL_BY_KIND[winner.to.kind]('a.nm', `$${params.length - 1}`);
        const t = SQL_BY_KIND[winner.from.kind]('b.nm', `$${params.length}`);
        const { rows: r } = await ctx.query(`
            SELECT COUNT(*)::int AS n
            FROM routes
            ${base.where} AND (
                ${orderedExists('cities_passed', f, t)}
                OR ${orderedExists('places_passed', f, t)}
            )
        `, params);
        return r[0].n;
    }

    // Journeys that touch both, in any order and across either index —
    // covers e.g. FROM known only as a city and TO known only as a place,
    // where no single index can prove the direction.
    async function countTouchingBoth() {
        const params = [...base.params, winner.from.values, winner.to.values];
        const mf = SQL_BY_KIND[winner.from.kind]('v', `$${params.length - 1}`);
        const mt = SQL_BY_KIND[winner.to.kind]('v', `$${params.length}`);
        const { rows: r } = await ctx.query(`
            SELECT COUNT(*)::int AS n
            FROM routes
            ${base.where}
              AND (${memberExists('cities_passed', mf)} OR ${memberExists('places_passed', mf)})
              AND (${memberExists('cities_passed', mt)} OR ${memberExists('places_passed', mt)})
        `, params);
        return r[0].n;
    }

    const reverse = await countReverse();
    const touching = await countTouchingBoth();

    // Journeys whose place indexes have not been computed yet (NULL, not []).
    const { rows: [missingRow] } = await ctx.query(`
        SELECT
            COUNT(*) FILTER (WHERE cities_passed IS NULL)::int AS cities_null,
            COUNT(*) FILTER (WHERE places_passed IS NULL)::int AS places_null
        FROM routes
        ${base.where}
    `, base.params);
    const missing = Math.max(missingRow.cities_null, missingRow.places_null);

    // Conservative: forward and reverse can overlap on round trips, so this
    // can only under-count, never invent direction-unknown journeys.
    const unknownDirection = Math.max(0, touching - rows.length - reverse);

    const mapRow = (r) => ({
        id: r.id,
        name: r.name,
        date: civilInZone(r.start_time, ctx.tz),
        distance_mi: r.distance,
        travel_mode: r.travel_mode,
    });
    const visits = endToEnd.map(mapRow);
    const dated = visits.filter((v) => v.date).map((v) => v.date).sort();
    const passThrough = rows.length;
    const extra = passThrough - visits.length;

    const data = {
        from: args.from_place,
        to: args.to_place,
        from_candidates: fromCands,
        to_candidates: toCands,
        us_state_endpoints: [
            ...(fromSide.stateQuery ? [args.from_place] : []),
            ...(toSide.stateQuery ? [args.to_place] : []),
        ],
        period: describeRange(range),
        travel_mode: args.travel_mode,
        match_mode: rows.length ? matchMode : 'none',
        end_to_end_count: visits.length,
        ordered_pass_through_count: passThrough,
        reverse_count: reverse,
        touching_both_count: touching,
        direction_unknown_count: unknownDirection,
        first_trip: dated[0] || null,
        last_trip: dated[dated.length - 1] || null,
        recent_trips: (visits.length > 0 ? visits : rows.map(mapRow)).slice(0, 5),
        journeys_missing_location_data: { cities: missingRow.cities_null, places: missingRow.places_null },
    };

    const mp = modePhrase(args.travel_mode);
    const missingNote = missing > 0
        ? ` Note: location data is still missing for ${missing} ${missing === 1 ? 'journey' : 'journeys'}, so this may be incomplete.`
        : '';
    const tierNote = rows.length === 0 ? ''
        : matchMode === 'partial' ? ' (matched by partial place names)'
            : matchMode === 'words' ? ' (matched by place-name words)'
                : '';

    if (visits.length > 0) {
        const when = dated.length === 0 ? ''
            : dated.length === 1 ? ` — on ${prettyCivil(dated[0])}`
                : ` — first on ${prettyCivil(dated[0])}, most recently ${prettyCivil(dated[dated.length - 1])}`;
        const extraNote = extra > 0
            ? ` ${extra} more passed through ${fromText} and later ${toText} mid-route without starting and ending there.`
            : '';
        const reverseNote = reverse > 0
            ? ` In the opposite direction (${toText} to ${fromText}): ${reverse}.`
            : '';
        return {
            data,
            summary: `${visits.length} ${visits.length === 1 ? 'journey' : 'journeys'} from ${fromText} to ${toText} `
                + `in ${range.label}${mp}${when}.${extraNote}${reverseNote}${tierNote}${missingNote}`,
        };
    }

    if (passThrough > 0) {
        const recentCivil = rows.map((r) => civilInZone(r.start_time, ctx.tz)).filter(Boolean);
        const when = recentCivil.length > 0 ? ` — most recently ${prettyCivil(recentCivil[0])}` : '';
        const reverseNote = reverse > 0
            ? ` In the opposite direction (${toText} to ${fromText}): ${reverse}.`
            : '';
        return {
            data,
            summary: `No journeys started in ${fromText} and ended in ${toText} in ${range.label}${mp}, `
                + `but ${passThrough} passed through ${fromText} and later ${toText} along the way${when}.`
                + `${reverseNote}${tierNote}${missingNote}`,
        };
    }

    const reverseNote = reverse > 0
        ? ` ${reverse} ${reverse === 1 ? 'journey' : 'journeys'} went the opposite way, ${toText} to ${fromText}.`
        : '';
    const unknownNote = unknownDirection > 0
        ? ` ${unknownDirection} ${unknownDirection === 1 ? 'journey' : 'journeys'} touched both ${fromText} and ${toText}, but the recorded sequence doesn't show the direction.`
        : '';
    const stateEndpoints = data.us_state_endpoints;
    const stateNote = stateEndpoints.length > 0
        ? ` ${stateEndpoints.join(' and ')} ${stateEndpoints.length === 1 ? 'is a US state' : 'are US states'}, `
            + `and journeys are indexed by the cities and named places they pass through, not by `
            + `state — so travel to or from the state itself is not answerable from this data.`
        : '';
    return {
        data,
        summary: `No journeys from ${fromText} to ${toText} found in ${range.label}${mp} `
            + `(checked the ordered city and place sequences on every journey, including partial and word-level name matches).`
            + `${stateNote}${reverseNote}${unknownNote}${missingNote}`,
    };
}

/* ------------------------------------------------------------------ *
 * list_journeys
 * ------------------------------------------------------------------ */

// Whitelisted ORDER BY fragments — sort values are already schema-enum-checked,
// this map is the second lock on the door.
const SORT_SQL = {
    distance_desc: 'distance DESC NULLS LAST',
    distance_asc: 'distance ASC NULLS LAST',
    start_time_desc: 'start_time DESC NULLS LAST',
    start_time_asc: 'start_time ASC NULLS LAST',
    avg_speed_desc: 'avg_speed DESC NULLS LAST',
    top_speed_desc: 'top_speed DESC NULLS LAST',
    duration_desc: 'EXTRACT(EPOCH FROM (end_time - start_time)) DESC NULLS LAST',
};

async function list_journeys(args, periods, ctx) {
    const range = periods.period;
    const orderBy = SORT_SQL[args.sort];
    if (!orderBy) throw new Error(`Unknown sort: ${args.sort}`);

    const { where, params } = buildWhere({ range, mode: args.travel_mode }, ctx);
    params.push(args.limit);
    const { rows } = await ctx.query(`
        SELECT id, name, start_time, distance, duration, avg_speed, top_speed, travel_mode
        FROM routes
        ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length}
    `, params);

    const journeys = rows.map((r) => ({
        id: r.id,
        name: r.name || 'Unnamed journey',
        date: civilInZone(r.start_time, ctx.tz),
        distance: fmtDistance(r.distance, ctx.units),
        duration: r.duration || null,
        avg_speed: fmtSpeed(r.avg_speed, ctx.units),
        top_speed: fmtSpeed(r.top_speed, ctx.units),
        travel_mode: r.travel_mode || null,
    }));

    const data = {
        period: describeRange(range),
        travel_mode: args.travel_mode,
        sort: args.sort,
        limit: args.limit,
        journeys,
    };

    if (journeys.length === 0) {
        return {
            data,
            summary: `No journeys found in ${range.label}${modePhrase(args.travel_mode)}.`,
        };
    }

    const lines = journeys.map((j, i) => {
        const bits = [j.distance];
        if (j.duration) bits.push(j.duration);
        if (j.travel_mode) bits.push(modeLabel(j.travel_mode));
        if (j.date) bits.push(prettyCivil(j.date));
        return `${i + 1}. ${j.name} — ${bits.join(', ')}`;
    });

    return {
        data,
        summary: `${journeys.length === 1 ? 'Top journey' : `Top ${journeys.length} journeys`} in ${range.label}`
            + `${modePhrase(args.travel_mode)}:\n${lines.join('\n')}`,
    };
}

/* ------------------------------------------------------------------ *
 * travel_mode_breakdown
 * ------------------------------------------------------------------ */

async function travel_mode_breakdown(args, periods, ctx) {
    const range = periods.period;
    const { where, params } = buildWhere({ range }, ctx);
    const { rows } = await ctx.query(`
        SELECT
            COALESCE(travel_mode, 'unknown') AS mode,
            COUNT(*)::int AS journey_count,
            COALESCE(SUM(distance), 0)::float AS distance_mi,
            ${DURATION_SUM} AS duration_s
        FROM routes
        ${where}
        GROUP BY 1
        ORDER BY 3 DESC
    `, params);

    const totalMi = rows.reduce((sum, r) => sum + r.distance_mi, 0);
    const modes = rows.map((r) => ({
        mode: r.mode,
        journey_count: r.journey_count,
        distance_mi: r.distance_mi,
        duration_s: r.duration_s,
        share_pct: totalMi > 0 ? Math.round((r.distance_mi / totalMi) * 100) : null,
    }));

    const data = { period: describeRange(range), total_distance_mi: totalMi, modes };

    if (modes.length === 0) {
        return { data, summary: `No journeys recorded in ${range.label}.` };
    }

    const parts = modes.map((m) => {
        const share = m.share_pct != null ? ` (${m.share_pct}%)` : '';
        return `${modeLabel(m.mode)}: ${fmtDistance(m.distance_mi, ctx.units)}${share} `
            + `across ${fmtJourneys(m.journey_count)}, ${fmtDuration(m.duration_s)}`;
    });

    return {
        data,
        summary: `${range.label} — ${fmtDistance(totalMi, ctx.units)} total. ${parts.join('; ')}.`,
    };
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

function describeRange(range) {
    return {
        token: range.token,
        start: range.start,
        end: range.end,
        label: range.label,
    };
}

const HANDLERS = {
    compare_periods,
    new_places,
    stats_summary,
    list_journeys,
    place_visits,
    trips_between,
    travel_mode_breakdown,
};

/**
 * Run one validated tool call.
 * @param {string} name       tool name (validated upstream)
 * @param {object} args       validated arguments
 * @param {object} periods    map of period-field -> resolved period
 * @param {object} ctx        { query, tz, units, minMiles }
 */
async function runTool(name, args, periods, ctx) {
    const handler = HANDLERS[name];
    if (!handler) throw new Error(`No handler for tool: ${name}`);
    return handler(args, periods, ctx);
}

module.exports = {
    runTool,
    HANDLERS,
    buildWhere,
    SORT_SQL,
    METRIC_INFO,
    escapeLike,
    placeCandidates,
    placeWords,
    isStateQuery,
};
