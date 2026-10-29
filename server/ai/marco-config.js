'use strict';

const { pool } = require('../db');

/**
 * Marco (Journey AI) configuration, persisted in the global app_config table —
 * the same store the database and weather settings use. The Ollama endpoint is
 * infrastructure, so like those settings it is app-wide, not per-user; journey
 * data itself stays tenant-scoped per request regardless of this config.
 *
 * Keys:
 *   marco_enabled     '1' | '0'
 *   marco_ollama_url  e.g. 'http://192.168.1.50:11434'
 *   marco_model       e.g. 'gemma4:e4b'
 *   marco_timeout_s   how long to wait for Ollama, in seconds (e.g. '120')
 */

const DEFAULT_MODEL = 'gemma4:e4b';
const DEFAULT_TIMEOUT_S = 120;
const MIN_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 600;
const CACHE_TTL_MS = 15000;

let cache = null;
let cacheAt = 0;

class MarcoConfigError extends Error {
    constructor(message, code = 'invalid_config') {
        super(message);
        this.name = 'MarcoConfigError';
        this.code = code;
    }
}

/**
 * Validate and normalize an Ollama base URL: require http(s), strip any
 * trailing slashes and whitespace. Returns the normalized URL string.
 */
function normalizeOllamaUrl(raw) {
    const value = String(raw || '').trim().replace(/\/+$/, '');
    if (!value) {
        throw new MarcoConfigError('An Ollama URL is required', 'missing_url');
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new MarcoConfigError(`Not a valid URL: ${value}`, 'bad_url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new MarcoConfigError('The Ollama URL must start with http:// or https://', 'bad_url');
    }
    return value;
}

function normalizeModel(raw) {
    const value = String(raw || '').trim();
    if (!value) return DEFAULT_MODEL;
    if (value.length > 128 || /\s/.test(value)) {
        throw new MarcoConfigError(`Not a valid model tag: ${value}`, 'bad_model');
    }
    return value;
}

/**
 * Validate a timeout in seconds. Blank/absent falls back to the default;
 * anything present must be a number within [MIN_TIMEOUT_S, MAX_TIMEOUT_S] so a
 * typo can never make Marco hang forever or give up instantly.
 */
function normalizeTimeoutS(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') {
        return DEFAULT_TIMEOUT_S;
    }
    const value = Number(String(raw).trim());
    if (!Number.isFinite(value)) {
        throw new MarcoConfigError(`Not a valid timeout: ${raw}`, 'bad_timeout');
    }
    const seconds = Math.round(value);
    if (seconds < MIN_TIMEOUT_S || seconds > MAX_TIMEOUT_S) {
        throw new MarcoConfigError(
            `The AI timeout must be between ${MIN_TIMEOUT_S} and ${MAX_TIMEOUT_S} seconds`,
            'bad_timeout'
        );
    }
    return seconds;
}

/** Lenient read for stored values: garbage in the table degrades to the default. */
function timeoutFromStore(raw) {
    try {
        return normalizeTimeoutS(raw);
    } catch {
        return DEFAULT_TIMEOUT_S;
    }
}

/** Read config from app_config. Cached briefly; pass force=true to bypass. */
async function getMarcoConfig(force = false) {
    const nowMs = Date.now();
    if (!force && cache && nowMs - cacheAt < CACHE_TTL_MS) {
        return cache;
    }
    const { rows } = await pool.query(
        "SELECT key, value FROM app_config WHERE key IN ('marco_enabled', 'marco_ollama_url', 'marco_model', 'marco_timeout_s')"
    );
    const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cache = {
        enabled: raw.marco_enabled === '1',
        url: raw.marco_ollama_url || '',
        model: raw.marco_model || DEFAULT_MODEL,
        timeoutS: timeoutFromStore(raw.marco_timeout_s),
    };
    cacheAt = nowMs;
    return cache;
}

/**
 * Persist config. Enabling requires a valid URL; disabling keeps the stored
 * URL/model so re-enabling later is one click.
 */
async function saveMarcoConfig({ enabled, url, model, timeoutS }) {
    const nextEnabled = enabled === true;
    const nextModel = normalizeModel(model);
    const nextTimeoutS = normalizeTimeoutS(timeoutS);
    let nextUrl = String(url || '').trim().replace(/\/+$/, '');
    if (nextEnabled) {
        nextUrl = normalizeOllamaUrl(nextUrl);
    } else if (nextUrl) {
        nextUrl = normalizeOllamaUrl(nextUrl);
    }

    const entries = [
        ['marco_enabled', nextEnabled ? '1' : '0'],
        ['marco_ollama_url', nextUrl],
        ['marco_model', nextModel],
        ['marco_timeout_s', String(nextTimeoutS)],
    ];
    for (const [key, value] of entries) {
        await pool.query(
            `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [key, value]
        );
    }

    cache = { enabled: nextEnabled, url: nextUrl, model: nextModel, timeoutS: nextTimeoutS };
    cacheAt = Date.now();
    return cache;
}

/** Test hook: drop the cache so the next read hits the database. */
function clearMarcoConfigCache() {
    cache = null;
    cacheAt = 0;
}

module.exports = {
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_S,
    MIN_TIMEOUT_S,
    MAX_TIMEOUT_S,
    MarcoConfigError,
    normalizeOllamaUrl,
    normalizeModel,
    normalizeTimeoutS,
    getMarcoConfig,
    saveMarcoConfig,
    clearMarcoConfigCache,
};
