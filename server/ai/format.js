'use strict';

/**
 * Unit-aware formatting for the Marco ask layer.
 *
 * Storage units are fixed by the rest of Journey and mirrored here exactly:
 * distance in MILES, speed in MPH, elevation in METERS (the client's
 * UnitsContext converts from those same bases). Every number that reaches the
 * model is formatted by this module first, in the requesting user's units, so
 * the model never converts and never guesses a unit.
 */

const MI_TO_KM = 1.60934;
const M_TO_FT = 3.28084;

function isMetric(units) {
    return units === 'metric';
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

/** 84.23 mi -> "84.2 miles" | "135.5 km". Sub-0.1 non-zero shows as "0.1". */
function fmtDistance(miles, units) {
    const n = Number(miles) || 0;
    if (isMetric(units)) {
        const km = round1(n * MI_TO_KM);
        return `${km.toLocaleString('en-US')} km`;
    }
    const mi = round1(n);
    return `${mi.toLocaleString('en-US')} ${mi === 1 ? 'mile' : 'miles'}`;
}

/** 21.34 mph -> "21.3 mph" | "34.3 km/h" */
function fmtSpeed(mph, units) {
    if (mph == null || Number.isNaN(Number(mph))) return null;
    const n = Number(mph);
    return isMetric(units)
        ? `${round1(n * MI_TO_KM).toLocaleString('en-US')} km/h`
        : `${round1(n).toLocaleString('en-US')} mph`;
}

/** 378.2 m -> "1,241 ft" | "378 m" */
function fmtElevation(meters, units) {
    const n = Number(meters) || 0;
    return isMetric(units)
        ? `${Math.round(n).toLocaleString('en-US')} m`
        : `${Math.round(n * M_TO_FT).toLocaleString('en-US')} ft`;
}

/** 24732s -> "6h 52m"; 312s -> "5m"; 20s -> "under a minute"; 0 -> "0m" */
function fmtDuration(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    if (s === 0) return '0m';
    if (s < 60) return 'under a minute';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
}

/** +36.2 -> "up 36%"; -8.4 -> "down 8%"; ±0.5 -> "about the same" */
function fmtPctChange(pct) {
    if (pct == null || !Number.isFinite(pct)) return null;
    const rounded = Math.round(pct);
    if (Math.abs(pct) < 0.5) return 'about the same';
    return rounded > 0 ? `up ${rounded}%` : `down ${Math.abs(rounded)}%`;
}

/** 3 -> "3 journeys", 1 -> "1 journey" */
function fmtJourneys(n) {
    const c = Number(n) || 0;
    return `${c.toLocaleString('en-US')} ${c === 1 ? 'journey' : 'journeys'}`;
}

/**
 * Format one metric value by kind, in the user's units. `kind` is one of
 * distance|duration|speed|elevation|count.
 */
function fmtMetric(kind, value, units) {
    switch (kind) {
        case 'distance': return fmtDistance(value, units);
        case 'duration': return fmtDuration(value);
        case 'speed': return fmtSpeed(value, units);
        case 'elevation': return fmtElevation(value, units);
        case 'count': return fmtJourneys(value);
        default: throw new Error(`Unknown metric kind: ${kind}`);
    }
}

/** Signed difference in the same unit language: "+11.2 miles", "-3 journeys". */
function fmtMetricDiff(kind, diff, units) {
    if (diff == null || !Number.isFinite(diff)) return null;
    const sign = diff >= 0 ? '+' : '-';
    const abs = Math.abs(diff);
    switch (kind) {
        case 'distance': return `${sign}${fmtDistance(abs, units)}`;
        case 'duration': return `${sign}${fmtDuration(abs)}`;
        case 'speed': return `${sign}${fmtSpeed(abs, units)}`;
        case 'elevation': return `${sign}${fmtElevation(abs, units)}`;
        case 'count': return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
        default: throw new Error(`Unknown metric kind: ${kind}`);
    }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-08-23' -> "Aug 23, 2026" */
function prettyCivil(civil) {
    if (typeof civil !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(civil)) return civil ?? null;
    const [y, m, d] = civil.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Civil date of an instant in a zone: (Date, 'America/New_York') -> '2026-08-23'. */
function civilInZone(date, timeZone) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    try {
        // en-CA formats as YYYY-MM-DD.
        return new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(date);
    } catch {
        return date.toISOString().slice(0, 10);
    }
}

/** Human name for a travel mode, for prose. */
function modeLabel(mode) {
    const labels = {
        foot: 'on foot',
        scooter: 'by scooter or bike',
        drive: 'driving',
        train: 'by train',
        metro: 'by metro',
        flight: 'flying',
        unknown: 'unclassified',
    };
    return labels[mode] || mode;
}

module.exports = {
    MI_TO_KM,
    M_TO_FT,
    fmtDistance,
    fmtSpeed,
    fmtElevation,
    fmtDuration,
    fmtPctChange,
    fmtJourneys,
    fmtMetric,
    fmtMetricDiff,
    prettyCivil,
    civilInZone,
    modeLabel,
};
