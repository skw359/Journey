#!/usr/bin/env node
'use strict';

/**
 * Tool-selection eval harness for the Journey ask layer.
 *
 *   node server/ai/evals/run-evals.js --model gemma4:e4b-it-qat --runs 3
 *
 * Runs every case in ask-evals.json against an Ollama endpoint and scores the
 * tool call the model produces. A case may carry a `history` transcript
 * ({role, content} turns, ending on an assistant answer); those cases score
 * the conversation-memory rules — follow-ups resolving against earlier turns
 * exactly as the live pipeline sends them. Nothing here touches Postgres — this measures
 * only whether the model picks the right function with the right arguments,
 * which is the part that decides whether the feature is viable.
 *
 * Flags:
 *   --model <tag>     model to test        (default $OLLAMA_MODEL)
 *   --url <base>      Ollama base URL      (default $OLLAMA_URL or localhost)
 *   --runs <n>        repeats per case, to measure variance   (default 1)
 *   --filter <substr> only cases whose id or tests contain this substring
 *   --temp <n>        sampling temperature (default 0)
 *   --out <path>      write full JSON results here
 *   --show-prompt     print the built system prompt and exit
 *   --verbose         print every failure's full received call
 *
 * Exit code is 0 when exact_accuracy meets the production bar, 1 otherwise, so
 * this can gate a deploy.
 */

const fs = require('fs');
const path = require('path');

const { buildSystemPrompt } = require('../prompt');
const { TOOLS, validateToolCall } = require('../tools');

/* ----------------------------- args ----------------------------- */

function parseArgs(argv) {
    const out = {
        model: process.env.OLLAMA_MODEL || 'gemma4:e4b-it-qat',
        url: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
        runs: 1,
        filter: null,
        temp: 0,
        out: null,
        showPrompt: false,
        verbose: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--model') out.model = next();
        else if (a === '--url') out.url = next().replace(/\/+$/, '');
        else if (a === '--runs') out.runs = Math.max(1, parseInt(next(), 10) || 1);
        else if (a === '--filter') out.filter = next();
        else if (a === '--temp') out.temp = Number(next());
        else if (a === '--out') out.out = next();
        else if (a === '--show-prompt') out.showPrompt = true;
        else if (a === '--verbose') out.verbose = true;
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
        else { console.error(`Unknown flag: ${a}`); process.exit(2); }
    }
    return out;
}

function printHelp() {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, ''));
}

/* --------------------------- terminal --------------------------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
    dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
    red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
    green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
    yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
    bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

/* ---------------------------- ollama ---------------------------- */

async function askModel({ url, model, system, question, history = [], temp, seed }) {
    const started = Date.now();
    const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            stream: false,
            // Reasoning tokens add latency without helping a six-way choice.
            think: false,
            messages: [
                { role: 'system', content: system },
                ...history,
                { role: 'user', content: question },
            ],
            tools: TOOLS,
            options: { temperature: temp, seed },
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    }

    const data = await res.json();
    const calls = data?.message?.tool_calls || [];
    const first = calls[0];

    return {
        latencyMs: Date.now() - started,
        callCount: calls.length,
        name: first?.function?.name ?? null,
        rawArgs: first?.function?.arguments ?? {},
        content: (data?.message?.content || '').trim(),
    };
}

/* ---------------------------- scoring --------------------------- */

/** Compare one received call against one expectation. */
function scoreAgainst(expected, received) {
    // Expecting no tool call at all.
    if (expected.tool === null) {
        const pass = received.name === null;
        return { toolMatch: pass, argsTotal: 0, argsMatched: 0, exact: pass, argDiffs: [] };
    }

    const toolMatch = received.name === expected.tool;
    const expectedArgs = expected.args || {};
    const keys = Object.keys(expectedArgs);

    // A wrong tool means its arguments are not comparable; count them all missed.
    if (!toolMatch) {
        return {
            toolMatch: false,
            argsTotal: keys.length,
            argsMatched: 0,
            exact: false,
            argDiffs: keys.map((k) => ({ key: k, want: expectedArgs[k], got: undefined })),
        };
    }

    const validated = validateToolCall(received.name, received.rawArgs);
    const got = validated.ok ? validated.args : {};
    const argDiffs = [];
    let argsMatched = 0;

    for (const k of keys) {
        const want = expectedArgs[k];
        const actual = got[k];
        const same = typeof want === 'string' && typeof actual === 'string'
            ? want.trim().toLowerCase() === actual.trim().toLowerCase()
            : want === actual;
        if (same) argsMatched++;
        else argDiffs.push({ key: k, want, got: actual });
    }

    return {
        toolMatch: true,
        argsTotal: keys.length,
        argsMatched,
        exact: argDiffs.length === 0 && validated.ok,
        argDiffs,
        schemaError: validated.ok ? null : validated.message,
    };
}

/** Score against the primary expectation plus any accepted alternates; best wins. */
function scoreCase(testCase, received) {
    const candidates = [testCase.expect, ...(testCase.accept || [])];
    let best = null;
    for (const candidate of candidates) {
        const s = scoreAgainst(candidate, received);
        if (!best) { best = s; continue; }
        const better = (s.exact && !best.exact)
            || (s.exact === best.exact && s.toolMatch && !best.toolMatch)
            || (s.exact === best.exact && s.toolMatch === best.toolMatch && s.argsMatched > best.argsMatched);
        if (better) best = s;
    }
    return best;
}

/* ----------------------------- main ----------------------------- */

async function main() {
    const opts = parseArgs(process.argv);
    const evalPath = path.join(__dirname, 'ask-evals.json');
    const suite = JSON.parse(fs.readFileSync(evalPath, 'utf8'));

    const clock = suite.meta.clock;
    const now = new Date(clock.now);
    const system = buildSystemPrompt({
        timeZone: clock.timeZone,
        now,
        units: clock.units,
    });

    if (opts.showPrompt) {
        console.log(system);
        return 0;
    }

    let cases = suite.cases;
    if (opts.filter) {
        const f = opts.filter.toLowerCase();
        cases = cases.filter(
            (t) => t.id.toLowerCase().includes(f)
                || (t.tests || []).some((x) => x.toLowerCase().includes(f)),
        );
    }
    if (cases.length === 0) {
        console.error('No cases matched the filter.');
        return 2;
    }

    console.log(c.bold(`\nJourney ask-layer evals`));
    console.log(`model    ${opts.model}`);
    console.log(`endpoint ${opts.url}`);
    console.log(`clock    ${clock.now} (${clock.timeZone})`);
    console.log(`cases    ${cases.length} × ${opts.runs} run${opts.runs > 1 ? 's' : ''}\n`);

    const results = [];
    let toolHits = 0;
    let exactHits = 0;
    let argsMatched = 0;
    let argsTotal = 0;
    let attempts = 0;
    const latencies = [];
    const failuresByTest = new Map();

    for (const testCase of cases) {
        const runs = [];

        for (let r = 0; r < opts.runs; r++) {
            let received;
            try {
                received = await askModel({
                    url: opts.url,
                    model: opts.model,
                    system,
                    question: testCase.question,
                    history: testCase.history || [],
                    temp: opts.temp,
                    seed: r,
                });
            } catch (err) {
                console.error(c.red(`\n  request failed: ${err.message}`));
                if (/ECONNREFUSED|fetch failed/i.test(err.message)) {
                    console.error(c.dim(`  Is Ollama reachable at ${opts.url}? Try: curl ${opts.url}/api/tags`));
                    return 2;
                }
                received = { name: null, rawArgs: {}, latencyMs: 0, callCount: 0, content: '', error: err.message };
            }

            const score = scoreCase(testCase, received);
            runs.push({ received, score });

            attempts++;
            if (score.toolMatch) toolHits++;
            if (score.exact) exactHits++;
            argsMatched += score.argsMatched;
            argsTotal += score.argsTotal;
            if (received.latencyMs) latencies.push(received.latencyMs);

            if (!score.exact) {
                for (const t of testCase.tests || []) {
                    failuresByTest.set(t, (failuresByTest.get(t) || 0) + 1);
                }
            }
        }

        const passes = runs.filter((r) => r.score.exact).length;
        const stable = passes === opts.runs || passes === 0;
        const mark = passes === opts.runs ? c.green('PASS')
            : passes === 0 ? c.red('FAIL')
                : c.yellow('FLAKY');

        const rate = opts.runs > 1 ? c.dim(` ${passes}/${opts.runs}`) : '';
        console.log(`${mark}${rate}  ${testCase.id}`);
        console.log(c.dim(`      "${testCase.question}"`));

        if (passes < opts.runs) {
            const worst = runs.find((r) => !r.score.exact);
            const got = worst.received;
            const exp = testCase.expect;
            console.log(
                c.dim('      want  ')
                + `${exp.tool ?? '(no tool)'}${exp.tool ? ` ${JSON.stringify(exp.args)}` : ''}`,
            );
            console.log(
                c.dim('      got   ')
                + `${got.name ?? '(no tool)'}${got.name ? ` ${JSON.stringify(got.rawArgs)}` : ''}`
                + (got.callCount > 1 ? c.red(`  [${got.callCount} calls]`) : ''),
            );
            if (worst.score.schemaError) console.log(c.red(`      schema  ${worst.score.schemaError}`));
            if (opts.verbose && got.content) console.log(c.dim(`      text    ${got.content.slice(0, 200)}`));
            if (!stable) console.log(c.yellow('      unstable across runs — treat as a fail'));
        }

        results.push({
            id: testCase.id,
            question: testCase.question,
            tests: testCase.tests || [],
            passes,
            runs: opts.runs,
            stable,
            observed: runs.map((r) => ({
                tool: r.received.name,
                args: r.received.rawArgs,
                exact: r.score.exact,
                toolMatch: r.score.toolMatch,
                argDiffs: r.score.argDiffs,
                latencyMs: r.received.latencyMs,
            })),
        });
    }

    const toolAcc = toolHits / attempts;
    const exactAcc = exactHits / attempts;
    const argAcc = argsTotal ? argsMatched / argsTotal : 1;
    const bar = 0.95;

    latencies.sort((a, b) => a - b);
    const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

    console.log(c.bold('\n─── summary ───'));
    console.log(`tool accuracy   ${(toolAcc * 100).toFixed(1)}%   (picked the right function)`);
    console.log(`arg accuracy    ${(argAcc * 100).toFixed(1)}%   (right value, per expected argument)`);
    console.log(
        `exact accuracy  ${(exactAcc * 100).toFixed(1)}%   (everything right — the number that matters)`,
    );
    console.log(c.dim(`latency         p50 ${p50}ms · p95 ${p95}ms`));

    const flaky = results.filter((r) => !r.stable);
    if (flaky.length) {
        console.log(c.yellow(`\n${flaky.length} case${flaky.length > 1 ? 's' : ''} unstable across runs:`));
        for (const f of flaky) console.log(c.yellow(`  ${f.id} (${f.passes}/${f.runs})`));
    }

    if (failuresByTest.size) {
        console.log(c.dim('\nfailures by category:'));
        for (const [t, n] of [...failuresByTest].sort((a, b) => b[1] - a[1])) {
            console.log(c.dim(`  ${String(n).padStart(3)}  ${t}`));
        }
    }

    const verdict = exactAcc >= bar;
    console.log(
        verdict
            ? c.green(`\nMeets the ${(bar * 100).toFixed(0)}% production bar.\n`)
            : c.red(`\nBelow the ${(bar * 100).toFixed(0)}% production bar — fix the schema or change model before building UI.\n`),
    );

    if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify({
            model: opts.model,
            endpoint: opts.url,
            clock,
            runs: opts.runs,
            temperature: opts.temp,
            summary: { toolAccuracy: toolAcc, argAccuracy: argAcc, exactAccuracy: exactAcc, p50, p95 },
            results,
        }, null, 2));
        console.log(c.dim(`results written to ${opts.out}\n`));
    }

    return verdict ? 0 : 1;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => { console.error(err); process.exit(2); });
