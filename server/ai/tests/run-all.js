#!/usr/bin/env node
'use strict';

/**
 * Run the entire offline Marco test suite, in order:
 *
 *   evals/selftest.js    period resolver + schemas + eval-file consistency
 *   handlers.test.js     every SQL statement and summary, fake database
 *   history.test.js      the sanitizer for client-sent conversation memory
 *   ollama.test.js       wire client against a real in-process mock server
 *   pipeline.test.js     full ask flow, every degradation branch
 *
 * None of these need Ollama, Postgres, or the network. The live-model eval
 * (evals/run-evals.js) is separate and intentionally not included — run it
 * whenever the model or the prompt changes:
 *
 *   node server/ai/evals/run-evals.js --model gemma4:e4b --runs 3
 *
 * Usage:  npm run test:ai      (or: node server/ai/tests/run-all.js)
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
    ['selftest', path.join(__dirname, '..', 'evals', 'selftest.js')],
    ['handlers', path.join(__dirname, 'handlers.test.js')],
    ['history', path.join(__dirname, 'history.test.js')],
    ['ollama', path.join(__dirname, 'ollama.test.js')],
    ['pipeline', path.join(__dirname, 'pipeline.test.js')],
];

let failed = 0;
const startedAt = Date.now();

console.log('\x1b[1mMarco test suite\x1b[0m (offline — no Ollama, no database)\n');

for (const [name, file] of SUITES) {
    const t0 = Date.now();
    const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
    const ms = Date.now() - t0;
    if (result.status !== 0) {
        failed++;
        console.log(`\x1b[31m  ↳ ${name} FAILED (${ms}ms)\x1b[0m\n`);
    } else {
        console.log(`\x1b[2m  ↳ ${name} ok (${ms}ms)\x1b[0m\n`);
    }
}

const total = Date.now() - startedAt;
if (failed > 0) {
    console.log(`\x1b[31m${failed} of ${SUITES.length} suites failed (${total}ms)\x1b[0m`);
    process.exit(1);
}
console.log(`\x1b[32mAll ${SUITES.length} suites passed (${total}ms)\x1b[0m`);
