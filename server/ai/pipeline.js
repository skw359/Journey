'use strict';

/**
 * The Marco ask pipeline: question in, answer out.
 *
 *   1. Build the tool-selection system prompt (period table pre-resolved).
 *   2. Round 1 to Ollama: model picks ONE tool, or none (out-of-scope/identity).
 *   3. validateToolCall() — an invalid call becomes the capability message,
 *      never a retry and never an executed query.
 *   4. Resolve period tokens server-side; run the matching handler's SQL.
 *   5. Round 2 to Ollama: rephrase the handler's finished summary as Marco.
 *      If that round fails, the summary itself IS the answer — the feature
 *      degrades to less-charming, never to wrong or broken.
 *
 * Every dependency arrives via `deps`, so the whole pipeline runs in tests
 * with a fake Ollama and a fake database:
 *
 *   deps = {
 *     ollama: { chatToolSelect, chatAnswer, chatAnswerStream? },
 *     query(text, params),                      tenant-scoped executor
 *     url, model,                               Ollama endpoint config
 *     timeoutMs?                                per-round Ollama deadline (from
 *                                               settings; ollama.js defaults
 *                                               apply when omitted)
 *     log?                                      logger scope (optional)
 *     onEvent?(evt)                             live progress for streaming UIs
 *     signal?                                   AbortSignal — user hit stop
 *   }
 *
 * When onEvent is provided AND the ollama client has chatAnswerStream, the
 * phrasing round streams and these events fire, in order:
 *
 *   { type: 'stage', stage: 'selecting' }             round 1 in flight
 *   { type: 'stage', stage: 'querying', tool }        SQL running
 *   { type: 'stage', stage: 'answering' }             phrasing round started
 *   { type: 'token', text }                           one streamed fragment (×N)
 *   { type: 'replace', text }                         stream failed mid-way —
 *                                                     discard shown text, this
 *                                                     is the whole answer
 *
 * The return value is identical either way; a listener that throws is ignored.
 */

const { TOOLS, validateToolCall, capabilityMessage } = require('./tools');
const { resolvePeriod, PeriodError } = require('./periods');
const { buildSystemPrompt, buildAnswerPrompt } = require('./prompt');
const { runTool } = require('./handlers');

// Every argument that resolves to a date range, with the argument names its
// custom dates arrive under. `exclude` has its OWN date fields so a custom
// period and a custom exclusion can coexist in one call.
const PERIOD_FIELDS = [
    { field: 'period', startArg: 'start_date', endArg: 'end_date' },
    { field: 'period_a', startArg: 'start_date', endArg: 'end_date' },
    { field: 'period_b', startArg: 'start_date', endArg: 'end_date' },
    { field: 'compared_to', startArg: 'start_date', endArg: 'end_date' },
    { field: 'exclude', startArg: 'exclude_start_date', endArg: 'exclude_end_date' },
];
const MAX_PASSTHROUGH_CHARS = 700;

class MarcoError extends Error {
    constructor(code, message, detail = null) {
        super(message);
        this.name = 'MarcoError';
        this.code = code;
        this.detail = detail;
    }
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Resolve every period argument of a validated tool call.
 * Throws PeriodError on a bad custom range (caught by ask()).
 */
function resolveArgPeriods(args, { timeZone, now }) {
    const periods = {};
    for (const { field, startArg, endArg } of PERIOD_FIELDS) {
        if (!(field in args)) continue;
        periods[field] = resolvePeriod(args[field], {
            timeZone,
            now,
            startDate: args[startArg] || null,
            endDate: args[endArg] || null,
        });
    }
    return periods;
}

function trimPassthrough(text) {
    const cleaned = String(text || '').trim();
    if (cleaned.length <= MAX_PASSTHROUGH_CHARS) return cleaned;
    return `${cleaned.slice(0, MAX_PASSTHROUGH_CHARS).trimEnd()}…`;
}

/**
 * Ask Marco a question.
 *
 * @param {object} input
 * @param {string} input.question   the user's question, already length-checked
 * @param {Array}  [input.history]  prior turns, oldest first, already sanitized
 *                                  by the route: { role:'user'|'assistant', content }.
 *                                  Both Ollama rounds see them, so follow-ups
 *                                  resolve; empty/omitted = today's behaviour.
 * @param {string} input.timeZone   IANA zone for period resolution
 * @param {string} input.units      'imperial' | 'metric'
 * @param {object} input.ctx        { query, minMiles } — tenant-scoped executor
 * @param {Date}   [input.now]      injectable clock for tests
 * @param {object} deps             { ollama, url, model, log? }
 *
 * @returns {{
 *   answer: string,
 *   summary: string|null,
 *   phrasing: 'model'|'fallback'|'passthrough'|'capability',
 *   tool: string|null, args: object|null,
 *   periods: Array<{field,token,start,end,label}>,
 *   timing: { select_ms, sql_ms, answer_ms, total_ms },
 *   model: string,
 * }}
 */
async function ask(input, deps) {
    const { question, timeZone, units, ctx, now = new Date(), history = [] } = input;
    const { ollama, url, model, signal = null, timeoutMs = null } = deps;
    // One knob covers every wait on the Ollama box: tool selection, the
    // non-streaming answer, the stream's first byte, and mid-stream silence.
    // When unset, each call keeps its own default from ollama.js.
    const timeouts = timeoutMs > 0 ? { timeoutMs } : {};
    const streamTimeouts = timeoutMs > 0 ? { timeoutMs, idleTimeoutMs: timeoutMs } : {};
    const log = deps.log || noopLog;
    const startedAt = Date.now();
    const timing = { select_ms: 0, sql_ms: 0, answer_ms: 0, total_ms: 0 };

    const emit = (evt) => {
        if (typeof deps.onEvent !== 'function') return;
        try { deps.onEvent(evt); } catch { /* a broken listener never breaks the answer */ }
    };
    const streaming = typeof deps.onEvent === 'function' && typeof ollama.chatAnswerStream === 'function';

    const finish = (result) => {
        timing.total_ms = Date.now() - startedAt;
        return { ...result, timing, model };
    };

    // ---- Round 1: tool selection --------------------------------------
    emit({ type: 'stage', stage: 'selecting' });
    const system = buildSystemPrompt({ timeZone, now, units });
    const t0 = Date.now();
    let selection;
    try {
        selection = await ollama.chatToolSelect({ url, model, system, question, tools: TOOLS, history, ...timeouts });
    } catch (err) {
        throw new MarcoError(
            err.code === 'timeout' ? 'ollama_timeout' : 'ollama_unreachable',
            err.message,
            err.detail
        );
    }
    timing.select_ms = Date.now() - t0;

    // ---- No tool: identity, greeting, or out-of-scope ------------------
    if (!selection.name) {
        const text = trimPassthrough(selection.content);
        if (text) {
            log.debug(`no tool · passthrough (${timing.select_ms}ms)`);
            return finish({
                answer: text, summary: null, phrasing: 'passthrough',
                tool: null, args: null, periods: [],
            });
        }
        log.debug(`no tool · empty content → capability message`);
        return finish({
            answer: capabilityMessage(), summary: null, phrasing: 'capability',
            tool: null, args: null, periods: [],
        });
    }

    if (selection.callCount > 1) {
        log.warn(`model emitted ${selection.callCount} tool calls · using the first`);
    }

    // ---- Validate — no retry, no repair --------------------------------
    const validated = validateToolCall(selection.name, selection.args);
    if (!validated.ok) {
        log.warn(`invalid tool call · ${validated.code} · ${validated.message}`);
        return finish({
            answer: `I couldn't map that question onto your journey data.\n\n${capabilityMessage()}`,
            summary: null, phrasing: 'capability',
            tool: selection.name, args: null, periods: [],
        });
    }

    // ---- Resolve periods + run the handler -----------------------------
    let periods;
    try {
        periods = resolveArgPeriods(validated.args, { timeZone, now });
    } catch (err) {
        if (err instanceof PeriodError) {
            log.warn(`period resolution failed · ${err.code} · ${err.message}`);
            return finish({
                answer: `I couldn't pin down the dates in that question.\n\n${capabilityMessage()}`,
                summary: null, phrasing: 'capability',
                tool: validated.name, args: validated.args, periods: [],
            });
        }
        throw err;
    }

    emit({ type: 'stage', stage: 'querying', tool: validated.name });
    const t1 = Date.now();
    // ctx.now lets handlers that need "today" (unbounded averages) share the
    // pipeline's injectable clock instead of reading the wall clock twice.
    const result = await runTool(validated.name, validated.args, periods, { ...ctx, now });
    timing.sql_ms = Date.now() - t1;

    const periodList = Object.entries(periods).map(([field, p]) => ({
        field, token: p.token, start: p.start, end: p.end, label: p.label,
    }));

    // ---- Round 2: phrase it as Marco -----------------------------------
    const answerSystem = buildAnswerPrompt({ units });
    const answerUser = [
        `The user asked: "${question}"`,
        '',
        'Query result (all numbers are final and already in the correct units):',
        JSON.stringify({ summary: result.summary, data: result.data }, null, 2),
        '',
        'Write the reply.',
    ].join('\n');

    emit({ type: 'stage', stage: 'answering' });
    const t2 = Date.now();
    let answer;
    let phrasing = 'model';
    try {
        const phrased = streaming
            ? await ollama.chatAnswerStream({
                url, model, system: answerSystem, user: answerUser, history, signal,
                ...streamTimeouts,
                onToken: (text) => emit({ type: 'token', text }),
            })
            : await ollama.chatAnswer({ url, model, system: answerSystem, user: answerUser, history, ...timeouts });
        answer = phrased.content;
    } catch (err) {
        // The user cancelling is not a failure — surface it so the route can
        // just close the response; the client keeps whatever already streamed.
        if (err.code === 'aborted') {
            throw new MarcoError('aborted', 'Answer cancelled by the user');
        }
        // Any real failure: the summary is already a complete, correct answer.
        // In streaming mode some partial text may be on screen, so tell the
        // client to replace it wholesale rather than appending.
        log.warn(`answer phrasing failed (${err.code || err.message}) · falling back to summary`);
        answer = result.summary;
        phrasing = 'fallback';
        if (streaming) emit({ type: 'replace', text: result.summary });
    }
    timing.answer_ms = Date.now() - t2;

    log.info(`${validated.name} · ${phrasing} · select ${timing.select_ms}ms · sql ${timing.sql_ms}ms · answer ${timing.answer_ms}ms`);

    return finish({
        answer,
        summary: result.summary,
        phrasing,
        tool: validated.name,
        args: validated.args,
        periods: periodList,
        data: result.data,
    });
}

module.exports = { ask, MarcoError, resolveArgPeriods, trimPassthrough };
