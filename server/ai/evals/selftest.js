#!/usr/bin/env node
'use strict';

/**
 * Offline self-test. No model, no database, no network.
 *
 * Two jobs:
 *   1. Prove the period resolver produces the exact ranges we claim, including
 *      across both US DST transitions and in a zone west of UTC.
 *   2. Prove every expectation in ask-evals.json is self-consistent with the
 *      tool schemas — so a failing eval means the model was wrong, never that
 *      the eval file was.
 *
 *   node server/ai/evals/selftest.js
 */

const fs = require('fs');
const path = require('path');

const {
    resolvePeriod, todayInZone, dayOfWeek, PERIOD_TOKENS, PeriodError,
} = require('../periods');
const { TOOL_BY_NAME, validateToolCall } = require('../tools');
const { buildSystemPrompt } = require('../prompt');

let passed = 0;
const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}

function checkThrows(label, fn, code) {
    try {
        fn();
        failures.push(`${label}\n      expected a PeriodError(${code}), nothing was thrown`);
    } catch (err) {
        if (err instanceof PeriodError && (!code || err.code === code)) passed++;
        else failures.push(`${label}\n      expected PeriodError(${code}), got ${err.name}(${err.code || '?'}): ${err.message}`);
    }
}

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

/* ---------------- 1. calendar anchor ---------------- */

const now = new Date('2026-08-26T14:00:00Z'); // 10:00 EDT, a Wednesday
// A midweek anchor is deliberate: on a Monday, last_week and trailing_7_days
// resolve to the same range, and an eval run on that date cannot tell whether
// the model understood the distinction or simply got lucky.
check('todayInZone(NY) at the pinned clock', todayInZone(NY, now), '2026-08-26');
check('2026-08-26 is a Wednesday (dow 3)', dayOfWeek('2026-08-26'), 3);

/* ---------------- 2. period ranges ---------------- */

const R = (token, extra = {}) => {
    const r = resolvePeriod(token, { timeZone: NY, now, ...extra });
    return [r.start, r.end];
};

check('today', R('today'), ['2026-08-26', '2026-08-26']);
check('yesterday', R('yesterday'), ['2026-08-25', '2026-08-25']);

check('this_week (Mon start, through today)', R('this_week'), ['2026-08-24', '2026-08-26']);
check('last_week (previous Mon..Sun)', R('last_week'), ['2026-08-17', '2026-08-23']);

check('week_before_last (two Mon..Sun back)', R('week_before_last'), ['2026-08-10', '2026-08-16']);

check('this_month', R('this_month'), ['2026-08-01', '2026-08-26']);
check('last_month', R('last_month'), ['2026-07-01', '2026-07-31']);
check('month_before_last', R('month_before_last'), ['2026-06-01', '2026-06-30']);
check('this_year', R('this_year'), ['2026-01-01', '2026-08-26']);
check('last_year', R('last_year'), ['2025-01-01', '2025-12-31']);

// Rolling windows end yesterday and must tile without overlap or gap.
check('trailing_7_days', R('trailing_7_days'), ['2026-08-19', '2026-08-25']);
check('prior_7_days', R('prior_7_days'), ['2026-08-12', '2026-08-18']);
check('trailing_30_days', R('trailing_30_days'), ['2026-07-27', '2026-08-25']);
check('prior_30_days', R('prior_30_days'), ['2026-06-27', '2026-07-26']);
check('trailing_90_days', R('trailing_90_days'), ['2026-05-28', '2026-08-25']);
check('all_time carries no filter', R('all_time'), [null, null]);

// Calendar weeks must tile too: week_before_last, last_week, this_week in a row.
const dayAfter = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
check(
    'week_before_last abuts last_week abuts this_week',
    [
        dayAfter(resolvePeriod('week_before_last', { timeZone: NY, now }).end),
        dayAfter(resolvePeriod('last_week', { timeZone: NY, now }).end),
    ],
    [
        resolvePeriod('last_week', { timeZone: NY, now }).start,
        resolvePeriod('this_week', { timeZone: NY, now }).start,
    ],
);
check(
    'month_before_last abuts last_month',
    dayAfter(resolvePeriod('month_before_last', { timeZone: NY, now }).end),
    resolvePeriod('last_month', { timeZone: NY, now }).start,
);

// The tiling property itself: prior_N must end exactly one day before trailing_N.
for (const n of [7, 30]) {
    const trailing = resolvePeriod(`trailing_${n}_days`, { timeZone: NY, now });
    const prior = resolvePeriod(`prior_${n}_days`, { timeZone: NY, now });
    const dayAfterPrior = new Date(Date.parse(`${prior.end}T00:00:00Z`) + 86400000)
        .toISOString().slice(0, 10);
    check(`prior_${n}_days abuts trailing_${n}_days`, dayAfterPrior, trailing.start);
}

// This is the ambiguity the whole design exists to kill, so assert that the two
// windows are genuinely different at the pinned clock — if they ever coincide
// here, every eval case testing the distinction silently stops testing it.
check(
    'last_week and trailing_7_days differ at the pinned clock',
    [R('last_week'), R('trailing_7_days')],
    [['2026-08-17', '2026-08-23'], ['2026-08-19', '2026-08-25']],
);
// They do coincide when asked on a Monday, which is correct, not a bug.
check(
    'last_week and trailing_7_days coincide on a Monday',
    resolvePeriod('last_week', { timeZone: NY, now: new Date('2026-08-24T14:00:00Z') }).start
        === resolvePeriod('trailing_7_days', { timeZone: NY, now: new Date('2026-08-24T14:00:00Z') }).start,
    true,
);

/* ---------------- 3. timezone correctness ---------------- */

// 04:00Z on the 24th is still the evening of the 23rd in Los Angeles.
check(
    'todayInZone is genuinely zone-derived, not UTC',
    todayInZone(LA, new Date('2026-08-24T04:00:00Z')),
    '2026-08-23',
);

// DST ends in the US on Sunday 2026-11-01 at 02:00 local. At 04:30Z on the 2nd
// New York is back on EST (UTC-5), so the local civil date is still the 1st.
check(
    'DST end: 2026-11-02T04:30Z is still Nov 1 in New York',
    todayInZone(NY, new Date('2026-11-02T04:30:00Z')),
    '2026-11-01',
);

// DST begins Sunday 2026-03-08 at 02:00 local (07:00Z). 06:30Z is 01:30 EST.
check(
    'DST start: 2026-03-08T06:30Z is Mar 8 in New York',
    todayInZone(NY, new Date('2026-03-08T06:30:00Z')),
    '2026-03-08',
);

// A rolling window spanning the DST change must still be exactly 7 civil days.
const acrossDst = resolvePeriod('trailing_7_days', {
    timeZone: NY,
    now: new Date('2026-11-05T15:00:00Z'),
});
const spanDays = (Date.parse(`${acrossDst.end}T00:00:00Z`) - Date.parse(`${acrossDst.start}T00:00:00Z`))
    / 86400000 + 1;
check('trailing_7_days spans 7 civil days across the DST change', spanDays, 7);

/* ---------------- 4. month-end and leap-year edges ---------------- */

check(
    'last_month from March 2026 gives a 28-day February',
    resolvePeriod('last_month', { timeZone: NY, now: new Date('2026-03-15T12:00:00Z') }),
    { token: 'last_month', start: '2026-02-01', end: '2026-02-28', label: 'Feb 1 – Feb 28, 2026', description: 'the previous complete calendar month' },
);
check(
    'last_month from March 2028 gives a 29-day February',
    R('last_month', { now: new Date('2028-03-15T12:00:00Z') }),
    ['2028-02-01', '2028-02-29'],
);
check(
    'last_month from January crosses the year boundary',
    R('last_month', { now: new Date('2026-01-10T12:00:00Z') }),
    ['2025-12-01', '2025-12-31'],
);
check(
    'last_week crosses the year boundary',
    R('last_week', { now: new Date('2026-01-02T12:00:00Z') }),
    ['2025-12-22', '2025-12-28'],
);

/* ---------------- 5. custom period validation ---------------- */

check(
    'custom passes through a valid range',
    R('custom', { startDate: '2026-07-01', endDate: '2026-07-31' }),
    ['2026-07-01', '2026-07-31'],
);
checkThrows('custom without dates', () => R('custom'), 'missing_custom_range');
checkThrows('custom with an inverted range', () => R('custom', { startDate: '2026-07-31', endDate: '2026-07-01' }), 'inverted_range');
checkThrows('custom with a malformed date', () => R('custom', { startDate: '07/01/2026', endDate: '2026-07-31' }), 'bad_date_format');
checkThrows('custom with Feb 31', () => R('custom', { startDate: '2026-02-31', endDate: '2026-03-01' }), 'bad_date_value');
checkThrows('an unknown period token', () => R('sometime_recently'), 'unknown_period');
checkThrows('an unknown timezone', () => resolvePeriod('today', { timeZone: 'Mars/Olympus', now }), 'bad_timezone');

/* ---------------- 6. every token resolves ---------------- */

for (const token of PERIOD_TOKENS) {
    if (token === 'custom') continue;
    const r = resolvePeriod(token, { timeZone: NY, now });
    const ok = token === 'all_time'
        ? r.start === null && r.end === null
        : typeof r.start === 'string' && typeof r.end === 'string' && r.start <= r.end;
    check(`token ${token} resolves to a sane range`, ok, true);
}

/* ---------------- 7. the prompt actually contains the table ---------------- */

const prompt = buildSystemPrompt({ timeZone: NY, now, units: 'imperial' });
check('prompt names today in full', prompt.includes('Wednesday, August 26, 2026'), true);
check('prompt contains the resolved last_week range', prompt.includes('2026-08-17 .. 2026-08-23'), true);
check('prompt contains the resolved trailing_7_days range', prompt.includes('2026-08-19 .. 2026-08-25'), true);
check('prompt states the week-start convention', prompt.includes('Weeks start on Monday'), true);
for (const token of PERIOD_TOKENS) {
    if (token === 'custom') continue;
    check(`prompt lists token ${token}`, prompt.includes(token), true);
}

/* ---------------- 8. eval file is consistent with the schemas ---------------- */

const suite = JSON.parse(fs.readFileSync(path.join(__dirname, 'ask-evals.json'), 'utf8'));
check('eval clock matches this self-test clock', suite.meta.clock.now, '2026-08-26T14:00:00Z');

const ids = new Set();
for (const testCase of suite.cases) {
    const { id } = testCase;
    check(`case id ${id} is unique`, ids.has(id), false);
    ids.add(id);
    check(`case ${id} has a question`, typeof testCase.question === 'string' && testCase.question.length > 0, true);

    // Conversation-memory cases: the transcript must be well-formed turns and
    // end on an assistant answer — a follow-up always follows an answer.
    if ('history' in testCase) {
        const h = testCase.history;
        check(`case ${id} history is a non-empty array`, Array.isArray(h) && h.length > 0, true);
        check(`case ${id} history turns are well-formed`,
            (h || []).every((m) => (m?.role === 'user' || m?.role === 'assistant')
                && typeof m?.content === 'string' && m.content.trim().length > 0),
            true);
        check(`case ${id} history ends on an assistant turn`, h?.[h.length - 1]?.role, 'assistant');
    }

    for (const expectation of [testCase.expect, ...(testCase.accept || [])]) {
        if (expectation.tool === null) continue;

        const tool = TOOL_BY_NAME.get(expectation.tool);
        check(`case ${id} names a real tool (${expectation.tool})`, Boolean(tool), true);
        if (!tool) continue;

        // The decisive check: would the server accept these exact arguments?
        const validated = validateToolCall(expectation.tool, expectation.args);
        check(
            `case ${id} expectation passes schema validation${validated.ok ? '' : ` — ${validated.message}`}`,
            validated.ok,
            true,
        );

        // And would every period token in it actually resolve? The exclusion
        // window is a period too, with its own custom-date argument names.
        const PERIOD_ARG_FIELDS = [
            ['period', 'start_date', 'end_date'],
            ['period_a', 'start_date', 'end_date'],
            ['period_b', 'start_date', 'end_date'],
            ['compared_to', 'start_date', 'end_date'],
            ['exclude', 'exclude_start_date', 'exclude_end_date'],
        ];
        for (const [field, startArg, endArg] of PERIOD_ARG_FIELDS) {
            const token = expectation.args?.[field];
            if (!token) continue;
            check(`case ${id}.${field} is a known period token (${token})`, PERIOD_TOKENS.includes(token), true);
            if (token === 'custom') {
                check(
                    `case ${id} supplies custom dates for ${field}`,
                    Boolean(expectation.args[startArg] && expectation.args[endArg]),
                    true,
                );
                if (expectation.args[startArg]) {
                    check(
                        `case ${id} custom range resolves for ${field}`,
                        resolvePeriod('custom', {
                            timeZone: NY,
                            now,
                            startDate: expectation.args[startArg],
                            endDate: expectation.args[endArg],
                        }).start,
                        expectation.args[startArg],
                    );
                }
            }
        }
    }
}

// The named-month case must line up with the pinned clock's year.
const july = suite.cases.find((t) => t.id === 'explicit-month-custom');
check('July case matches the pinned clock year', [july.expect.args.start_date, july.expect.args.end_date], ['2026-07-01', '2026-07-31']);

/* ---------------- 9. schema hygiene ---------------- */

for (const [name, tool] of TOOL_BY_NAME) {
    const p = tool.function.parameters;
    check(`${name} forbids extra properties`, p.additionalProperties, false);
    check(`${name} declares required args`, Array.isArray(p.required) && p.required.length > 0, true);
    for (const key of p.required) {
        check(`${name}.${key} is required and defined`, Boolean(p.properties[key]), true);
    }
    for (const [key, prop] of Object.entries(p.properties)) {
        check(`${name}.${key} has a description`, typeof prop.description === 'string' && prop.description.length > 10, true);
    }
}

// Rejection paths the runtime depends on.
check('unknown tool is rejected', validateToolCall('drop_tables', {}).code, 'unknown_tool');
check('bad enum value is rejected', validateToolCall('stats_summary', { period: 'last_fortnight', travel_mode: 'any' }).code, 'bad_enum_value');
check('invented argument is rejected', validateToolCall('stats_summary', { period: 'today', travel_mode: 'any', sql: 'SELECT 1' }).code, 'unknown_argument');
check('missing required argument is rejected', validateToolCall('stats_summary', { period: 'today' }).code, 'missing_argument');
check('limit above maximum is rejected', validateToolCall('list_journeys', { period: 'today', travel_mode: 'any', sort: 'distance_desc', limit: 500 }).code, 'out_of_range');
check('string-encoded arguments are parsed', validateToolCall('stats_summary', '{"period":"today","travel_mode":"any"}').ok, true);
check('stray dates on a non-custom period are dropped', validateToolCall('stats_summary', { period: 'today', travel_mode: 'any', start_date: '2026-01-01', end_date: '2026-01-02' }).args.start_date, undefined);
check('custom without dates is rejected', validateToolCall('stats_summary', { period: 'custom', travel_mode: 'any' }).code, 'missing_custom_range');

// The nested-object shape gemma emits live (verbatim from the server log):
// the flattener must turn it into the flat token + date fields, deterministically.
{
    const v = validateToolCall('stats_summary', {
        period: 'custom', start_date: '2026-07-06', end_date: '2026-08-27',
        travel_mode: 'drive', average_per: 'week',
        exclude: { custom: true, exclude_end_date: '2026-08-23', exclude_start_date: '2026-08-17' },
    });
    check('nested exclude object is accepted', v.ok, true);
    check('nested exclude object flattens to the token', v.args.exclude, 'custom');
    check('nested exclude dates are hoisted', [v.args.exclude_start_date, v.args.exclude_end_date], ['2026-08-17', '2026-08-23']);
}
check('nested token-flag object flattens ({last_week:true})',
    validateToolCall('stats_summary', { period: 'this_year', travel_mode: 'drive', exclude: { last_week: true } }).args.exclude,
    'last_week');
check('nested period object flattens too',
    validateToolCall('stats_summary', { period: { custom: true, start_date: '2026-07-01', end_date: '2026-07-31' }, travel_mode: 'any' }).args.period,
    'custom');
check('nested dates alone mean custom',
    validateToolCall('stats_summary', { period: 'this_year', travel_mode: 'any', exclude: { exclude_start_date: '2026-03-01', exclude_end_date: '2026-03-31' } }).args.exclude,
    'custom');
check('unreadable exclude object is still rejected honestly',
    validateToolCall('stats_summary', { period: 'today', travel_mode: 'any', exclude: { nonsense: 1 } }).code,
    'bad_enum_value');
check('nested object never overwrites explicit top-level dates',
    validateToolCall('stats_summary', {
        period: 'this_year', travel_mode: 'any',
        exclude: { custom: true, exclude_start_date: '2026-01-01', exclude_end_date: '2026-01-31' },
        exclude_start_date: '2026-02-01', exclude_end_date: '2026-02-28',
    }).args.exclude_start_date,
    '2026-02-01');

/* ---------------- report ---------------- */

const total = passed + failures.length;
if (failures.length) {
    console.log(`\n\x1b[31m${failures.length} of ${total} checks failed\x1b[0m\n`);
    for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}\n`);
    process.exit(1);
}
console.log(`\n\x1b[32mall ${total} checks passed\x1b[0m`);
console.log(`\x1b[2m${suite.cases.length} eval cases validated against the tool schemas\x1b[0m\n`);
