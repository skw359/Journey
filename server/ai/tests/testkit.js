'use strict';

/**
 * Tiny shared test kit for the Marco suite. Zero dependencies, same
 * check()/report pattern as evals/selftest.js so every test file in this
 * project reads the same way.
 */

let passed = 0;
const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}

function checkMatch(label, actual, regex) {
    if (typeof actual === 'string' && regex.test(actual)) { passed++; return; }
    failures.push(`${label}\n      expected match ${regex}\n      actual   ${JSON.stringify(actual)}`);
}

function checkNoMatch(label, actual, regex) {
    if (typeof actual === 'string' && !regex.test(actual)) { passed++; return; }
    failures.push(`${label}\n      expected NO match ${regex}\n      actual   ${JSON.stringify(actual)}`);
}

async function checkRejects(label, promiseFn, codeOrRegex) {
    try {
        await promiseFn();
        failures.push(`${label}\n      expected a rejection, promise resolved`);
    } catch (err) {
        const matches = codeOrRegex instanceof RegExp
            ? codeOrRegex.test(err.message)
            : err.code === codeOrRegex;
        if (matches) { passed++; return; }
        failures.push(`${label}\n      expected error ${codeOrRegex}\n      actual   ${err.name}(${err.code || '?'}): ${err.message}`);
    }
}

/**
 * A scripted fake for ctx.query. Construct with an array of responders; each
 * call shifts the next one. A responder is either an array of rows, or a
 * function (text, params) => rows for assertions inline. Every call is
 * recorded in .calls for post-hoc inspection.
 */
function fakeQuery(script) {
    const queue = [...script];
    const fn = async (text, params) => {
        fn.calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
        if (queue.length === 0) {
            throw new Error(`fakeQuery: unexpected query #${fn.calls.length}: ${text.slice(0, 120)}`);
        }
        const next = queue.shift();
        const rows = typeof next === 'function' ? next(text, params) : next;
        return { rows };
    };
    fn.calls = [];
    fn.remaining = () => queue.length;
    return fn;
}

/** An aggregate row in the shape handlers.aggregate() returns. */
function aggRow(over = {}) {
    return {
        journey_count: 0,
        distance_mi: 0,
        duration_s: 0,
        avg_speed_mph: null,
        top_speed_mph: null,
        elevation_gain_m: 0,
        ...over,
    };
}

function report(suiteName, extra = '') {
    const total = passed + failures.length;
    if (failures.length) {
        console.log(`\n\x1b[31m${suiteName}: ${failures.length} of ${total} checks failed\x1b[0m\n`);
        for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}\n`);
        process.exit(1);
    }
    console.log(`\x1b[32m${suiteName}: all ${total} checks passed\x1b[0m${extra ? ` \x1b[2m${extra}\x1b[0m` : ''}`);
}

module.exports = { check, checkMatch, checkNoMatch, checkRejects, fakeQuery, aggRow, report };
