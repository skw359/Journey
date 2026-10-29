#!/usr/bin/env node
'use strict';

/**
 * Pipeline tests: the full question -> tool -> SQL -> answer flow with a fake
 * Ollama and a fake database. This is where the wiring is proven — every
 * branch of the state machine, including the degradation paths that keep the
 * feature honest when the model or the box misbehaves.
 *
 *   node server/ai/tests/pipeline.test.js
 */

const { check, checkMatch, checkRejects, fakeQuery, aggRow, report } = require('./testkit');
const { ask, MarcoError, trimPassthrough, resolveArgPeriods } = require('../pipeline');
const { capabilityMessage } = require('../tools');

const NOW = new Date('2026-08-26T14:00:00Z');
const TZ = 'America/New_York';

function fakeOllama({ selection, answer }) {
    const calls = { select: [], answer: [] };
    return {
        calls,
        chatToolSelect: async (opts) => {
            calls.select.push(opts);
            if (selection instanceof Error) throw selection;
            return typeof selection === 'function' ? selection(opts) : selection;
        },
        chatAnswer: async (opts) => {
            calls.answer.push(opts);
            if (answer instanceof Error) throw answer;
            return typeof answer === 'function' ? answer(opts) : answer;
        },
    };
}

function input(question, queryScript) {
    return {
        question,
        timeZone: TZ,
        units: 'imperial',
        now: NOW,
        ctx: { query: fakeQuery(queryScript), tz: TZ, units: 'imperial', minMiles: 0.25 },
    };
}

const DEPS_BASE = { url: 'http://box:11434', model: 'gemma4:e4b' };

async function main() {
    /* ---- happy path: compare tool, model phrasing ---- */
    {
        const ollama = fakeOllama({
            selection: {
                name: 'compare_periods',
                args: { metric: 'distance', period_a: 'this_week', period_b: 'last_week', travel_mode: 'any' },
                callCount: 1,
                content: '',
            },
            answer: { content: "You covered 120 miles this week — up 20% on last week's 100. Nice stretch of road!" },
        });
        const inp = input('how much more did i travel vs last week?', [
            [aggRow({ journey_count: 6, distance_mi: 120 })],
            [aggRow({ journey_count: 5, distance_mi: 100 })],
            [{ n: 0 }],
            [],
            [],
        ]);
        const out = await ask(inp, { ...DEPS_BASE, ollama });

        check('happy: phrasing came from the model', out.phrasing, 'model');
        check('happy: tool recorded', out.tool, 'compare_periods');
        checkMatch('happy: answer is the model text', out.answer, /Nice stretch of road/);
        checkMatch('happy: summary kept alongside', out.summary, /up 20% \(\+20 miles\)/);
        check('happy: periods resolved and labeled', out.periods.map((p) => [p.field, p.start, p.end]), [
            ['period_a', '2026-08-24', '2026-08-26'],
            ['period_b', '2026-08-17', '2026-08-23'],
        ]);
        check('happy: model echoed in meta', out.model, 'gemma4:e4b');

        // The answer prompt must carry the finished numbers, not raw rows.
        const answerCall = ollama.calls.answer[0];
        checkMatch('happy: phrasing round receives the summary JSON', answerCall.user, /up 20% \(\+20 miles\)/);
        checkMatch('happy: phrasing system prompt is the nameless answer prompt', answerCall.system, /never a name/);
        checkMatch('happy: selection system prompt carries the period table', ollama.calls.select[0].system, /2026-08-17 \.\. 2026-08-23/);
        check('happy: timing fields present', Object.keys(out.timing), ['select_ms', 'sql_ms', 'answer_ms', 'total_ms']);
    }

    /* ---- exclusion window: its own custom dates, end to end ---- */
    {
        // resolveArgPeriods must read exclude's dates from exclude_* fields so
        // a custom period and a custom exclusion coexist in one call.
        const periods = resolveArgPeriods({
            period: 'custom', start_date: '2026-07-06', end_date: '2026-08-27',
            exclude: 'custom', exclude_start_date: '2026-08-17', exclude_end_date: '2026-08-23',
        }, { timeZone: TZ, now: NOW });
        check('exclude: period keeps its own dates', [periods.period.start, periods.period.end], ['2026-07-06', '2026-08-27']);
        check('exclude: exclusion resolved from exclude_* fields', [periods.exclude.start, periods.exclude.end], ['2026-08-17', '2026-08-23']);
    }
    {
        // The full flow for the question that used to die as an invalid call:
        // "exclduing August 17-23, how much do I usually drive per week,
        //  starting from July 6 to August 27?"
        const ollama = fakeOllama({
            selection: {
                name: 'stats_summary',
                args: {
                    period: 'custom', start_date: '2026-07-06', end_date: '2026-08-27',
                    travel_mode: 'drive', average_per: 'week',
                    exclude: 'custom', exclude_start_date: '2026-08-17', exclude_end_date: '2026-08-23',
                },
                callCount: 1,
                content: '',
            },
            answer: { content: 'Outside that week, you typically drive about 62.7 miles a week.' },
        });
        const inp = input('exclduing August 17-23, how much do I usually drive per week, starting from July 6 to August 27?', [
            [aggRow({ journey_count: 9, distance_mi: 412.1, duration_s: 65520, avg_speed_mph: 31.2 })],
            [{ n: 0 }],
        ]);
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('exclude flow: phrasing came from the model', out.phrasing, 'model');
        checkMatch('exclude flow: summary carries the computed rate', out.summary,
            /averaging 62\.7 miles and 1\.4 journeys per week, from 412\.1 miles across 9 journeys over 46 counted days/);
        check('exclude flow: both ranges surfaced in periods', out.periods.map((p) => [p.field, p.start, p.end]), [
            ['period', '2026-07-06', '2026-08-27'],
            ['exclude', '2026-08-17', '2026-08-23'],
        ]);
    }

    /* ---- conversation history reaches both rounds ---- */
    {
        const HISTORY = [
            { role: 'user', content: 'how far did I drive last week?' },
            { role: 'assistant', content: 'You drove 88.4 miles, Aug 17 – Aug 23.' },
        ];
        const ollama = fakeOllama({
            selection: {
                name: 'stats_summary',
                args: { period: 'week_before_last', travel_mode: 'drive' },
                callCount: 1,
                content: '',
            },
            answer: { content: 'The week before, Aug 10 – Aug 16, you drove 41.2 miles.' },
        });
        const inp = {
            ...input('what about the week before?', [
                [aggRow({ journey_count: 2, distance_mi: 41.2, duration_s: 3600, avg_speed_mph: 25 })],
                [{ n: 0 }],
            ]),
            history: HISTORY,
        };
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('history: tool round received the transcript', ollama.calls.select[0].history, HISTORY);
        check('history: answer round received the transcript', ollama.calls.answer[0].history, HISTORY);
        check('history: follow-up answered normally', [out.phrasing, out.tool], ['model', 'stats_summary']);
    }
    {
        // Omitted history still reaches the client as [], so a first question
        // sends the exact request shape the feature always sent.
        const ollama = fakeOllama({
            selection: { name: null, args: {}, callCount: 0, content: 'hello!' },
        });
        await ask(input('hi', []), { ...DEPS_BASE, ollama });
        check('history: defaults to empty', ollama.calls.select[0].history, []);
    }

    /* ---- phrasing failure degrades to the summary, never breaks ---- */
    {
        const { OllamaError } = require('../ollama');
        const ollama = fakeOllama({
            selection: {
                name: 'stats_summary',
                args: { period: 'last_week', travel_mode: 'drive' },
                callCount: 1,
                content: '',
            },
            answer: new OllamaError('timeout', 'answer round timed out'),
        });
        const inp = input('how far did i drive last week?', [
            [aggRow({ journey_count: 4, distance_mi: 88.4, duration_s: 7200, avg_speed_mph: 30 })],
            [{ n: 0 }],
        ]);
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('fallback: phrasing flag', out.phrasing, 'fallback');
        checkMatch('fallback: answer IS the server summary', out.answer, /^Aug 17 – Aug 23, 2026, driving only: 4 journeys, 88\.4 miles/);
    }

    /* ---- no tool + content: identity/out-of-scope passthrough ---- */
    {
        const ollama = fakeOllama({
            selection: { name: null, args: {}, callCount: 0, content: "I'm the travel assistant in Journey! Ask me how far you drove last week." },
            answer: { content: 'should never be called' },
        });
        const inp = input("what's your name?", []);
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('passthrough: phrasing flag', out.phrasing, 'passthrough');
        checkMatch('passthrough: generic self-introduction passes through', out.answer, /travel assistant in Journey/);
        check('passthrough: no SQL ran', inp.ctx.query.calls.length, 0);
        check('passthrough: no answer round', ollama.calls.answer.length, 0);
    }

    /* ---- no tool + no content: capability message ---- */
    {
        const ollama = fakeOllama({
            selection: { name: null, args: {}, callCount: 0, content: '' },
        });
        const out = await ask(input('…', []), { ...DEPS_BASE, ollama });
        check('capability: phrasing flag', out.phrasing, 'capability');
        check('capability: canned message verbatim', out.answer, capabilityMessage());
    }

    /* ---- invalid tool call: no retry, no SQL, capability answer ---- */
    {
        const ollama = fakeOllama({
            selection: {
                name: 'stats_summary',
                args: { period: 'last_fortnight', travel_mode: 'any' }, // bad enum
                callCount: 1,
                content: '',
            },
        });
        const inp = input('how far in the last fortnight?', []);
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('invalid: phrasing flag', out.phrasing, 'capability');
        check('invalid: zero SQL executed', inp.ctx.query.calls.length, 0);
        check('invalid: tool name still reported for logging', out.tool, 'stats_summary');
        checkMatch('invalid: answer explains and lists capabilities', out.answer, /couldn't map that question[\s\S]*how far you travelled/);
    }

    /* ---- invented argument is rejected the same way ---- */
    {
        const ollama = fakeOllama({
            selection: {
                name: 'stats_summary',
                args: { period: 'last_week', travel_mode: 'any', sql: 'DROP TABLE routes' },
                callCount: 1,
                content: '',
            },
        });
        const inp = input('how far last week?', []);
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('injection-shaped arg: no SQL executed', inp.ctx.query.calls.length, 0);
        check('injection-shaped arg: capability response', out.phrasing, 'capability');
    }

    /* ---- custom period flows dates through to the handler ---- */
    {
        const ollama = fakeOllama({
            selection: {
                name: 'stats_summary',
                args: { period: 'custom', travel_mode: 'any', start_date: '2026-07-01', end_date: '2026-07-31' },
                callCount: 1,
                content: '',
            },
            answer: { content: 'July: 300 miles.' },
        });
        const inp = input('how much did i travel in July?', [
            (text, params) => {
                check('custom: SQL gets the literal July bounds', params, [0.25, TZ, '2026-07-01', '2026-07-31']);
                return [aggRow({ journey_count: 10, distance_mi: 300 })];
            },
            [{ n: 0 }],
        ]);
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('custom: resolved period surfaces in meta', out.periods[0], {
            field: 'period', token: 'custom', start: '2026-07-01', end: '2026-07-31', label: 'Jul 1 – Jul 31, 2026',
        });
    }

    /* ---- bad custom range degrades to capability, not a crash ---- */
    {
        const ollama = fakeOllama({
            selection: {
                name: 'stats_summary',
                args: { period: 'custom', travel_mode: 'any', start_date: '2026-07-31', end_date: '2026-07-01' },
                callCount: 1,
                content: '',
            },
        });
        const inp = input('backwards range', []);
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('bad custom: capability response, no SQL', [out.phrasing, inp.ctx.query.calls.length], ['capability', 0]);
        checkMatch('bad custom: message mentions dates', out.answer, /pin down the dates/);
    }

    /* ---- selection round failure surfaces as MarcoError ---- */
    {
        const { OllamaError } = require('../ollama');
        const ollama = fakeOllama({ selection: new OllamaError('unreachable', 'ECONNREFUSED') });
        await checkRejects('down box: MarcoError ollama_unreachable',
            () => ask(input('hi', []), { ...DEPS_BASE, ollama }), 'ollama_unreachable');
    }
    {
        const { OllamaError } = require('../ollama');
        const ollama = fakeOllama({ selection: new OllamaError('timeout', 'took too long') });
        await checkRejects('slow box: MarcoError ollama_timeout',
            () => ask(input('hi', []), { ...DEPS_BASE, ollama }), 'ollama_timeout');
    }

    /* ---- multiple tool calls: first wins ---- */
    {
        const ollama = fakeOllama({
            selection: {
                name: 'stats_summary',
                args: { period: 'today', travel_mode: 'any' },
                callCount: 3,
                content: '',
            },
            answer: { content: 'Today: nothing yet.' },
        });
        const inp = input('today?', [[aggRow()], [{ n: 0 }]]);
        const out = await ask(inp, { ...DEPS_BASE, ollama });
        check('multi-call: first call used', out.tool, 'stats_summary');
    }

    /* ---- streaming: event order, tokens, and the replace fallback ---- */

    {
        // Full streaming happy path: stages fire in order around real work,
        // tokens arrive between 'answering' and the return.
        const events = [];
        const ollama = {
            chatToolSelect: async () => ({
                name: 'stats_summary',
                args: { period: 'last_week', travel_mode: 'any' },
                callCount: 1,
                content: '',
            }),
            chatAnswer: async () => { throw new Error('non-stream path must not be used'); },
            chatAnswerStream: async ({ onToken }) => {
                for (const t of ['You ', 'went ', 'far.']) onToken(t);
                return { content: 'You went far.' };
            },
        };
        const inp = input('how far last week?', [
            [aggRow({ journey_count: 2, distance_mi: 30 })],
            [{ n: 0 }],
        ]);
        const out = await ask(inp, {
            ...DEPS_BASE, ollama,
            onEvent: (evt) => events.push(evt),
        });
        check('streamed: phrasing is model', out.phrasing, 'model');
        check('streamed: answer is assembled stream', out.answer, 'You went far.');
        check('streamed: event sequence', events.map((e) => (e.type === 'token' ? `token:${e.text}` : `${e.type}:${e.stage ?? ''}`)), [
            'stage:selecting',
            'stage:querying',
            'stage:answering',
            'token:You ',
            'token:went ',
            'token:far.',
        ]);
        check('streamed: querying event names the tool', events.find((e) => e.stage === 'querying').tool, 'stats_summary');
    }
    {
        // Without onEvent the stream client must NOT be used even if present.
        let streamUsed = false;
        const ollama = {
            chatToolSelect: async () => ({
                name: 'stats_summary', args: { period: 'today', travel_mode: 'any' }, callCount: 1, content: '',
            }),
            chatAnswer: async () => ({ content: 'plain path' }),
            chatAnswerStream: async () => { streamUsed = true; return { content: 'wrong path' }; },
        };
        const out = await ask(input('today?', [[aggRow()], [{ n: 0 }]]), { ...DEPS_BASE, ollama });
        check('no onEvent: non-streaming client used', [out.answer, streamUsed], ['plain path', false]);
    }
    {
        // Stream dies mid-answer: a replace event delivers the summary whole,
        // and the returned answer is the summary.
        const { OllamaError } = require('../ollama');
        const events = [];
        const ollama = {
            chatToolSelect: async () => ({
                name: 'stats_summary', args: { period: 'last_week', travel_mode: 'any' }, callCount: 1, content: '',
            }),
            chatAnswer: async () => { throw new Error('must not be called'); },
            chatAnswerStream: async ({ onToken }) => {
                onToken('You went f');
                throw new OllamaError('timeout', 'stream died');
            },
        };
        const inp = input('how far last week?', [
            [aggRow({ journey_count: 4, distance_mi: 88.4, duration_s: 3600 })],
            [{ n: 0 }],
        ]);
        const out = await ask(inp, { ...DEPS_BASE, ollama, onEvent: (evt) => events.push(evt) });
        check('stream-fail: phrasing flag', out.phrasing, 'fallback');
        checkMatch('stream-fail: answer is the summary', out.answer, /^Aug 17 – Aug 23, 2026: 4 journeys/);
        const replace = events.find((e) => e.type === 'replace');
        checkMatch('stream-fail: replace event carries the whole summary', replace?.text ?? '', /^Aug 17 – Aug 23, 2026: 4 journeys/);
    }
    {
        // User abort mid-stream surfaces as MarcoError('aborted') for the route.
        const { OllamaError } = require('../ollama');
        const ollama = {
            chatToolSelect: async () => ({
                name: 'stats_summary', args: { period: 'today', travel_mode: 'any' }, callCount: 1, content: '',
            }),
            chatAnswer: async () => { throw new Error('must not be called'); },
            chatAnswerStream: async () => { throw new OllamaError('aborted', 'user hit stop'); },
        };
        await checkRejects('stream-abort: MarcoError aborted',
            () => ask(input('today?', [[aggRow()], [{ n: 0 }]]), { ...DEPS_BASE, ollama, onEvent: () => {} }),
            'aborted');
    }
    {
        // A listener that throws must never damage the answer.
        const ollama = {
            chatToolSelect: async () => ({
                name: 'stats_summary', args: { period: 'today', travel_mode: 'any' }, callCount: 1, content: '',
            }),
            chatAnswer: async () => { throw new Error('must not be called'); },
            chatAnswerStream: async ({ onToken }) => { onToken('fine.'); return { content: 'fine.' }; },
        };
        const out = await ask(input('today?', [[aggRow()], [{ n: 0 }]]), {
            ...DEPS_BASE, ollama,
            onEvent: () => { throw new Error('bad listener'); },
        });
        check('bad listener: answer survives', out.answer, 'fine.');
    }

    /* ---- passthrough trimming ---- */
    check('trim: short text unchanged', trimPassthrough('hello'), 'hello');
    {
        const long = 'x'.repeat(900);
        const trimmed = trimPassthrough(long);
        check('trim: long text capped with ellipsis', [trimmed.length <= 701, trimmed.endsWith('…')], [true, true]);
    }

    /* ---- MarcoError shape ---- */
    {
        const err = new MarcoError('ollama_timeout', 'msg');
        check('MarcoError carries code', [err.name, err.code], ['MarcoError', 'ollama_timeout']);
    }

    report('pipeline.test');
}

main().catch((err) => { console.error(err); process.exit(1); });
