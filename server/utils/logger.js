/**
 * Journey console logger.
 *
 * Zero-dependency, TTY-aware pretty printing for the server's terminal output:
 * a startup banner, an aligned boot checklist, a Vite-style "ready" panel, and
 * timestamped/level-tagged runtime lines.
 *
 * Environment overrides
 *   NO_COLOR / FORCE_COLOR      standard color opt-out / opt-in
 *   JOURNEY_LOG_LEVEL           debug | info | warn | error | silent   (default: info)
 *   JOURNEY_LOG_HTTP            0 to silence per-request lines         (default: on)
 *   JOURNEY_LOG_STACK           1 to always print stack traces         (default: non-production)
 *   JOURNEY_LOG_PLAIN           1 to drop the banner + box drawing (good for pm2/systemd)
 */

'use strict';

const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

const STYLE = (process.env.JOURNEY_LOG_STYLE || '').toLowerCase();

/**
 * Should we draw the full banner / boxes / colors?
 *
 * A bare `isTTY` check is not enough: `npm run dev` runs the server through
 * `concurrently`, which hands the child a pipe rather than a terminal, and the
 * output still ends up on a real console. So a pipe counts as rich too, and we
 * only fall back to plain text when stdout is a regular file — i.e. genuinely
 * redirected to a log (`> server.log`, pm2, systemd), where ANSI escapes and
 * box drawing would be noise.
 */
function detectRich() {
    if (STYLE === 'rich') return true;
    if (STYLE === 'plain' || process.env.JOURNEY_LOG_PLAIN === '1') return false;
    if (process.env.TERM === 'dumb') return false;
    if (process.stdout.isTTY) return true;
    try {
        return !fs.fstatSync(1).isFile();
    } catch {
        return false;
    }
}

const RICH = detectRich();

const COLOR =
    process.env.FORCE_COLOR === '1' ? true :
    process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0' ? false :
    RICH;

// Node writes UTF-8 to Windows consoles via WriteConsoleW regardless of the
// active code page, so box drawing is safe by default everywhere. Terminals
// with a font that lacks the glyphs can opt out with JOURNEY_LOG_ASCII=1.
const UNICODE = RICH && process.env.JOURNEY_LOG_ASCII !== '1';

const PLAIN = !RICH;

// 24-bit color, so gradients can be authored as hex instead of snapping to the
// xterm-256 cube. Falls back to the nearest 256-color index when unsupported.
const TRUECOLOR = COLOR && (
    /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '') ||
    Boolean(process.env.WT_SESSION) ||
    ['vscode', 'Windows_Terminal', 'iTerm.app', 'ghostty', 'WezTerm'].includes(process.env.TERM_PROGRAM) ||
    process.platform === 'win32'
);

// ---------------------------------------------------------------------------
// Color primitives (256-color, degrades to no-op)
// ---------------------------------------------------------------------------

const esc = (open, close) => (s) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

const bold = esc(1, 22);
const dim = esc(2, 22);
const italic = esc(3, 23);
const fg = (n) => (s) => (COLOR ? `\x1b[38;5;${n}m${s}\x1b[39m` : String(s));

const CUBE = [0, 95, 135, 175, 215, 255];

/** Closest xterm-256 index to an RGB triple (6x6x6 cube + grayscale ramp). */
function nearest256(r, g, b) {
    let best = Infinity;
    let index = 0;
    for (let i = 0; i < 216; i++) {
        const d =
            (CUBE[Math.floor(i / 36)] - r) ** 2 +
            (CUBE[Math.floor(i / 6) % 6] - g) ** 2 +
            (CUBE[i % 6] - b) ** 2;
        if (d < best) { best = d; index = i + 16; }
    }
    for (let i = 0; i < 24; i++) {
        const v = 8 + i * 10;
        const d = (v - r) ** 2 + (v - g) ** 2 + (v - b) ** 2;
        if (d < best) { best = d; index = 232 + i; }
    }
    return index;
}

/** Painter for a '#rrggbb' string, 24-bit where available. */
function hex(value) {
    const n = parseInt(value.replace('#', ''), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    if (!COLOR) return String;
    if (TRUECOLOR) return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
    return fg(nearest256(r, g, b));
}

// Journey's brand green. Everything accent-colored derives from this.
const BRAND = '#02d87f';

const C = {
    brand: hex(BRAND),
    mint: hex('#74fbb8'),
    cyan: fg(44),
    blue: fg(75),
    violet: fg(141),
    green: hex(BRAND),   // success reads in the brand green
    yellow: fg(179),
    orange: fg(215),
    red: fg(203),
    pink: fg(211),
    grey: fg(245),
    faint: fg(240),
    white: fg(255),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const width = (s) => String(s).replace(ANSI_RE, '').length;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const padStart = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + s;

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const G = UNICODE
    ? { ok: '✔', warn: '▲', err: '✖', skip: '○', dot: '·', arrow: '→', turn: '↳', bar: '│',
        tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { ok: 'v', warn: '!', err: 'x', skip: 'o', dot: '-', arrow: '>', turn: '->', bar: '|',
        tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const THRESHOLD = LEVELS[(process.env.JOURNEY_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const SHOW_HTTP = process.env.JOURNEY_LOG_HTTP !== '0';
const SHOW_STACK = process.env.JOURNEY_LOG_STACK === '1' ||
    (process.env.JOURNEY_LOG_STACK !== '0' && process.env.NODE_ENV !== 'production');

// 'ok' is an info-level line with its own styling, so it ranks alongside info.
const RANK = { debug: LEVELS.debug, info: LEVELS.info, ok: LEVELS.info, warn: LEVELS.warn, error: LEVELS.error };

const TAGS = {
    debug: { label: 'debug', paint: C.faint, stream: 'out' },
    info: { label: 'info', paint: C.blue, stream: 'out' },
    ok: { label: 'ok', paint: C.green, stream: 'out' },
    warn: { label: 'warn', paint: C.yellow, stream: 'err' },
    error: { label: 'error', paint: C.red, stream: 'err' },
};

// Scopes get a stable color so `weather` is always the same hue run to run.
const SCOPE_HUES = [44, 75, 141, 78, 179, 215, 211, 111, 108, 175];
const scopeColorCache = new Map();
function scopePaint(name) {
    if (!scopeColorCache.has(name)) {
        let h = 0;
        for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
        scopeColorCache.set(name, fg(SCOPE_HUES[h % SCOPE_HUES.length]));
    }
    return scopeColorCache.get(name);
}

// ---------------------------------------------------------------------------
// Layout constants — every runtime line aligns to these columns
// ---------------------------------------------------------------------------

const GUTTER = '  ';
const LEVEL_W = 6;   // fits 'DELETE' so request lines share the level column
const SCOPE_W = 10;
const URL_W = 40;
const CONT_INDENT = ' '.repeat(GUTTER.length + 8 + 2 + LEVEL_W + 2 + SCOPE_W + 1);

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(stream, line) {
    (stream === 'err' ? process.stderr : process.stdout).write(line + '\n');
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

// Existing call sites prefix messages like "[Weather] Failed to fetch".
// Lift that prefix out into the scope column instead of leaving it inline.
const INLINE_TAG = /^\[([^\]]{1,24})\]\s*/;

function normalizeScope(raw) {
    return String(raw).trim().toLowerCase().replace(/\s+/g, '-').slice(0, SCOPE_W);
}

function stringify(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message || String(value);
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function emit(level, scope, args) {
    const tag = TAGS[level];
    if (RANK[level] < THRESHOLD) return;

    let parts = args.slice();
    let head = typeof parts[0] === 'string' ? parts[0] : '';
    let resolvedScope = scope;

    const match = head.match(INLINE_TAG);
    if (match) {
        // An explicit "[Tag]" in the message wins over the module's own scope.
        resolvedScope = normalizeScope(match[1]);
        head = head.slice(match[0].length);
        parts[0] = head;
    }

    const errors = parts.filter((p) => p instanceof Error);
    const text = parts
        .filter((p) => !(p instanceof Error))
        .map(stringify)
        .filter((s) => s.length > 0)
        .join(' ');

    // "GET /api/routes error:" reads better as a heading without the colon,
    // since the actual error follows on its own continuation line.
    const heading = errors.length ? text.replace(/\s*:\s*$/, '') : text;

    const scopeCell = resolvedScope
        ? padEnd(scopePaint(resolvedScope)(resolvedScope), SCOPE_W)
        : ' '.repeat(SCOPE_W);

    const line =
        GUTTER +
        dim(stamp()) + '  ' +
        tag.paint(padEnd(tag.label, LEVEL_W)) + '  ' +
        scopeCell + ' ' +
        (level === 'error' ? C.red(heading) : heading);

    write(tag.stream, line.trimEnd());

    for (const err of errors) {
        const detail = err.message || String(err);
        if (heading) write(tag.stream, CONT_INDENT + dim(G.turn + ' ') + C.orange(detail));
        else write(tag.stream, CONT_INDENT + C.orange(detail));

        if (SHOW_STACK && err.stack) {
            err.stack
                .split('\n')
                .slice(1, 5)
                .forEach((frame) => write(tag.stream, CONT_INDENT + '  ' + dim(frame.trim())));
        }
    }
}

// ---------------------------------------------------------------------------
// Banner + boot sequence
// ---------------------------------------------------------------------------

const WORDMARK = [
    '     ██╗ ██████╗ ██╗   ██╗██████╗ ███╗   ██╗███████╗██╗   ██╗',
    '     ██║██╔═══██╗██║   ██║██╔══██╗████╗  ██║██╔════╝╚██╗ ██╔╝',
    '     ██║██║   ██║██║   ██║██████╔╝██╔██╗ ██║█████╗   ╚████╔╝',
    '██   ██║██║   ██║██║   ██║██╔══██╗██║╚██╗██║██╔══╝    ╚██╔╝',
    '╚█████╔╝╚██████╔╝╚██████╔╝██║  ██║██║ ╚████║███████╗   ██║',
    ' ╚════╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝',
];

// One color per wordmark row, top to bottom. Pick with JOURNEY_LOG_THEME,
// or add your own row of six hex values.
//
// 'journey' is the brand ramp: a light mint highlight falling through
// #02d87f (row 3, the brand green itself) into deep emerald.
const GRADIENTS = {
    journey: ['#74fbb8', '#36fca0', BRAND, '#03b571', '#048b5e', '#04674d'],
    aurora:  ['#5fd7ff', '#00d7ff', '#00afff', '#5f5fff', '#875fff', '#af5fff'],
    ember:   ['#ffdfaf', '#ffd787', '#ffaf5f', '#ff875f', '#ff5f5f', '#d75f87'],
    ice:     ['#afffff', '#87d7ff', '#5fafff', '#5f87ff', '#5f5fd7', '#5f5faf'],
    mono:    ['#ffffff', '#e4e4e4', '#dadada', '#d0d0d0', '#c6c6c6', '#bcbcbc'],
};
const WORDMARK_PAINT = (
    GRADIENTS[(process.env.JOURNEY_LOG_THEME || '').toLowerCase()] || GRADIENTS.journey
).map(hex);

const steps = [];

function banner(subtitle) {
    if (PLAIN || !UNICODE) {
        write('out', '');
        write('out', GUTTER + bold('Journey') + (subtitle ? dim('  ' + G.dot + '  ' + subtitle) : ''));
        write('out', '');
        return;
    }
    write('out', '');
    WORDMARK.forEach((row, i) => write('out', GUTTER + WORDMARK_PAINT[i](row)));
    write('out', '');
    if (subtitle) write('out', GUTTER + '     ' + dim(italic(subtitle)));
    write('out', '');
}

/**
 * Record a boot step. `state` is 'ok' | 'skip' | 'warn' | 'fail'.
 * Steps are buffered and flushed as an aligned checklist by `ready()`, so the
 * startup output stays a single tidy block instead of a scroll of log lines.
 */
function step(name, detail, state = 'ok') {
    steps.push({ name, detail, state });
}

const STEP_STYLE = {
    ok: { glyph: G.ok, paint: C.green },
    skip: { glyph: G.skip, paint: C.faint },
    warn: { glyph: G.warn, paint: C.yellow },
    fail: { glyph: G.err, paint: C.red },
};

function flushSteps() {
    if (!steps.length) return;
    const nameW = Math.max(...steps.map((s) => s.name.length));
    for (const s of steps) {
        const style = STEP_STYLE[s.state] || STEP_STYLE.ok;
        write(
            'out',
            GUTTER + '  ' +
            style.paint(style.glyph) + '  ' +
            padEnd(s.state === 'skip' ? dim(s.name) : C.white(s.name), nameW) + '   ' +
            dim(s.detail || '')
        );
    }
    steps.length = 0;
    write('out', '');
}

function box(title, rows) {
    if (PLAIN || !UNICODE) {
        if (title) write('out', GUTTER + bold(title));
        rows.forEach((r) => write('out', GUTTER + '  ' + r));
        write('out', '');
        return;
    }
    const inner = Math.max(width(title) + 4, ...rows.map((r) => width(r) + 4), 44);
    const head = title
        ? G.tl + G.h + ' ' + bold(C.white(title)) + ' ' + G.h.repeat(Math.max(0, inner - width(title) - 3)) + G.tr
        : G.tl + G.h.repeat(inner) + G.tr;
    write('out', GUTTER + C.faint(head));
    for (const r of rows) {
        write('out', GUTTER + C.faint(G.v) + '  ' + padEnd(r, inner - 2) + C.faint(G.v));
    }
    write('out', GUTTER + C.faint(G.bl + G.h.repeat(inner) + G.br));
    write('out', '');
}

function localAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const net of list || []) {
            if (net.family === 'IPv4' && !net.internal) out.push(net.address);
        }
    }
    return out;
}

function ready({ port, startedAt, publicUrl }) {
    flushSteps();
    const rows = [];
    const label = (t) => C.brand(G.arrow) + '  ' + padEnd(dim(t), 9);
    rows.push(label('local') + C.brand(`http://localhost:${port}`));
    for (const ip of localAddresses().slice(0, 2)) {
        rows.push(label('network') + C.brand(`http://${ip}:${port}`));
    }
    if (publicUrl) rows.push(label('public') + C.mint(publicUrl));

    const ms = startedAt ? Date.now() - startedAt : null;
    box(ms !== null ? `ready in ${ms}ms` : 'ready', rows);
}

// ---------------------------------------------------------------------------
// HTTP request line
// ---------------------------------------------------------------------------

const METHOD_PAINT = {
    GET: C.cyan, POST: C.green, PUT: C.yellow, PATCH: C.yellow,
    DELETE: C.red, OPTIONS: C.faint, HEAD: C.faint,
};

function statusPaint(code) {
    if (code >= 500) return C.red;
    if (code >= 400) return C.orange;
    if (code >= 300) return C.violet;
    return C.green;
}

function http({ method, url, status, ms }) {
    if (!SHOW_HTTP || THRESHOLD > LEVELS.info) return;
    const paintMethod = METHOD_PAINT[method] || C.grey;
    const duration = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
    const trimmed = url.length > URL_W ? url.slice(0, URL_W - 1) + '…' : url;
    // The status cell occupies the scope column so paths line up with messages.
    const line =
        GUTTER +
        dim(stamp()) + '  ' +
        paintMethod(padEnd(method, LEVEL_W)) + '  ' +
        padEnd(statusPaint(status)(String(status)), SCOPE_W) + ' ' +
        padEnd(status >= 400 ? url : dim(trimmed), URL_W) + ' ' +
        padStart(ms >= 500 ? C.orange(duration) : dim(duration), 7);
    write('out', line.trimEnd());
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function makeLogger(scope) {
    return {
        debug: (...a) => emit('debug', scope, a),
        info: (...a) => emit('info', scope, a),
        log: (...a) => emit('info', scope, a),
        success: (...a) => emit('ok', scope, a),
        warn: (...a) => emit('warn', scope, a),
        error: (...a) => emit('error', scope, a),
        scope: (name) => makeLogger(normalizeScope(name)),
    };
}

const logger = makeLogger(null);

module.exports = Object.assign(logger, {
    banner,
    step,
    flushSteps,
    box,
    ready,
    http,
    colors: C,
    dim,
    bold,
    glyphs: G,
    supportsColor: COLOR,
});
