'use strict';

/**
 * Tiny scoped logger: console in dev, plus a rotating file in userData/logs.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;
let stream = null;
let filePath = null;
let verbose = false;

function init({ dir, dev }) {
    verbose = !!dev;
    try {
        fs.mkdirSync(dir, { recursive: true });
        filePath = path.join(dir, 'journey-desktop.log');
        try {
            if (fs.statSync(filePath).size > MAX_BYTES) {
                fs.renameSync(filePath, filePath.replace(/\.log$/, '.1.log'));
            }
        } catch { /* first run */ }
        stream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch (err) {
        console.error('[log] could not open log file', err);
    }
}

function fmt(level, scope, args) {
    const time = new Date().toISOString();
    const text = args.map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    return `${time} ${level.padEnd(5)} [${scope}] ${text}`;
}

function write(level, scope, args) {
    const line = fmt(level, scope, args);
    if (stream) stream.write(line + '\n');
    if (verbose || level === 'error' || level === 'warn') {
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(line);
    }
}

function scope(name) {
    return {
        debug: (...a) => { if (verbose) write('debug', name, a); },
        info: (...a) => write('info', name, a),
        warn: (...a) => write('warn', name, a),
        error: (...a) => write('error', name, a),
    };
}

module.exports = { init, scope, get filePath() { return filePath; } };
