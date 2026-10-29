'use strict';

/**
 * Period resolution for the Journey ask layer.
 *
 * Design rule: the model NEVER computes or emits a date. It emits one token
 * from PERIOD_TOKENS and this module turns that token into a concrete,
 * inclusive civil date range in the user's timezone.
 *
 * Ranges are 'YYYY-MM-DD' civil dates because that is what the SQL layer
 * compares against:
 *
 *     WHERE (start_time AT TIME ZONE $tz)::date BETWEEN $start AND $end
 *
 * Postgres owns the timezone conversion, so DST transitions are handled by the
 * database rather than by hand-rolled offset math.
 *
 * All calendar arithmetic below runs on UTC-midnight anchors used purely as a
 * counting device. No instant is ever converted across a timezone here, so a
 * DST shift cannot move a boundary. The single timezone-aware step is deriving
 * "today" from the wall clock in todayInZone().
 */

// Weeks start Monday (ISO 8601). Set to 0 for Sunday-start weeks; the prompt
// builder reads WEEK_START_LABEL so the model is told which convention is live.
const WEEK_START = 1;
const WEEK_START_LABEL = WEEK_START === 1 ? 'Monday' : 'Sunday';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The closed set of period tokens the model may emit.
 *
 * Naming is deliberate. "last_week" vs "trailing_7_days" is the single biggest
 * ambiguity in this whole feature, so the tokens are named so that the
 * distinction is legible to a small model reading the enum: anything starting
 * with "trailing_"/"prior_" is a rolling window, anything starting with
 * "this_"/"last_" is a calendar block.
 */
const PERIOD_DEFS = [
    { token: 'today', desc: 'the current day so far' },
    { token: 'yesterday', desc: 'the single day before today' },
    { token: 'this_week', desc: `the current calendar week, ${WEEK_START_LABEL} through today` },
    { token: 'last_week', desc: 'the previous complete calendar week' },
    { token: 'week_before_last', desc: 'the calendar week before last_week — use for "the week before"' },
    { token: 'this_month', desc: 'the 1st of the current month through today' },
    { token: 'last_month', desc: 'the previous complete calendar month' },
    { token: 'month_before_last', desc: 'the calendar month before last_month — use for "the month before"' },
    { token: 'this_year', desc: 'January 1 of the current year through today' },
    { token: 'last_year', desc: 'the previous complete calendar year' },
    { token: 'trailing_7_days', desc: 'the 7 complete days ending yesterday' },
    { token: 'prior_7_days', desc: 'the 7 complete days immediately before trailing_7_days' },
    { token: 'trailing_30_days', desc: 'the 30 complete days ending yesterday' },
    { token: 'prior_30_days', desc: 'the 30 complete days immediately before trailing_30_days' },
    { token: 'trailing_90_days', desc: 'the 90 complete days ending yesterday' },
    { token: 'all_time', desc: 'every journey on record, with no date filter' },
    { token: 'custom', desc: 'an explicit range; requires start_date and end_date as YYYY-MM-DD' },
];

const PERIOD_TOKENS = PERIOD_DEFS.map((d) => d.token);
const PERIOD_TOKEN_SET = new Set(PERIOD_TOKENS);

/**
 * The natural comparison partner for each period. Used to fill in a missing
 * period_b rather than letting the model invent one — if a question says
 * "compared to last week" and omits the current side, we default deterministically.
 */
const COMPARISON_PARTNER = {
    today: 'yesterday',
    yesterday: 'today',
    this_week: 'last_week',
    last_week: 'week_before_last',
    week_before_last: 'last_week',
    this_month: 'last_month',
    last_month: 'month_before_last',
    month_before_last: 'last_month',
    this_year: 'last_year',
    last_year: 'this_year',
    trailing_7_days: 'prior_7_days',
    prior_7_days: 'trailing_7_days',
    trailing_30_days: 'prior_30_days',
    prior_30_days: 'trailing_30_days',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class PeriodError extends Error {
    constructor(message, code = 'invalid_period') {
        super(message);
        this.name = 'PeriodError';
        this.code = code;
    }
}

/* ------------------------------------------------------------------ *
 * Civil date helpers. A "civil" value is the string 'YYYY-MM-DD' with
 * no instant and no zone attached.
 * ------------------------------------------------------------------ */

function civilToParts(civil) {
    if (typeof civil !== 'string' || !ISO_DATE.test(civil)) {
        throw new PeriodError(`Expected a YYYY-MM-DD date, received: ${JSON.stringify(civil)}`, 'bad_date_format');
    }
    const [y, m, d] = civil.split('-').map(Number);
    const anchor = new Date(Date.UTC(y, m - 1, d));
    // Reject values that silently rolled over, e.g. 2026-02-31 -> Mar 3.
    if (
        anchor.getUTCFullYear() !== y ||
        anchor.getUTCMonth() !== m - 1 ||
        anchor.getUTCDate() !== d
    ) {
        throw new PeriodError(`Not a real calendar date: ${civil}`, 'bad_date_value');
    }
    return { y, m, d, anchor };
}

function anchorToCivil(anchor) {
    return anchor.toISOString().slice(0, 10);
}

function addDays(civil, days) {
    const { anchor } = civilToParts(civil);
    return anchorToCivil(new Date(anchor.getTime() + days * 86400000));
}

/** Day of week, 0 = Sunday .. 6 = Saturday. */
function dayOfWeek(civil) {
    return civilToParts(civil).anchor.getUTCDay();
}

function startOfWeek(civil) {
    const offset = (dayOfWeek(civil) - WEEK_START + 7) % 7;
    return addDays(civil, -offset);
}

function startOfMonth(civil) {
    const { y, m } = civilToParts(civil);
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

function endOfMonth(civil) {
    const { y, m } = civilToParts(civil);
    // Day 0 of the following month is the last day of this one.
    return anchorToCivil(new Date(Date.UTC(y, m, 0)));
}

function addMonths(civil, months) {
    const { y, m, d } = civilToParts(civil);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return anchorToCivil(new Date(Date.UTC(
        target.getUTCFullYear(),
        target.getUTCMonth(),
        Math.min(d, lastDay),
    )));
}

/**
 * The user's current civil date, derived from the wall clock in their zone.
 * This is the one place a real instant meets a timezone.
 */
function todayInZone(timeZone, now = new Date()) {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(now);
    } catch {
        throw new PeriodError(`Unknown timezone: ${timeZone}`, 'bad_timezone');
    }
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "Monday, August 24, 2026" — for the prompt header only, never for parsing. */
function humanDate(civil) {
    const { y, m, d } = civilToParts(civil);
    return `${DAY_NAMES[dayOfWeek(civil)]}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/**
 * Resolve one period token into an inclusive civil date range.
 *
 * @param {string} token          one of PERIOD_TOKENS
 * @param {object} opts
 * @param {string} opts.timeZone  IANA zone, e.g. 'America/New_York'
 * @param {Date}   [opts.now]     injectable clock, so evals are deterministic
 * @param {string} [opts.startDate] required when token === 'custom'
 * @param {string} [opts.endDate]   required when token === 'custom'
 * @returns {{token:string,start:string|null,end:string|null,label:string,description:string}}
 *          start/end are null only for 'all_time', which applies no date filter.
 */
function resolvePeriod(token, opts = {}) {
    const { timeZone, now = new Date(), startDate = null, endDate = null } = opts;
    if (!timeZone) throw new PeriodError('A timeZone is required to resolve a period', 'missing_timezone');
    if (!PERIOD_TOKEN_SET.has(token)) {
        throw new PeriodError(
            `Unknown period "${token}". Valid periods: ${PERIOD_TOKENS.join(', ')}`,
            'unknown_period',
        );
    }

    const today = todayInZone(timeZone, now);
    const yesterday = addDays(today, -1);

    let start;
    let end;

    switch (token) {
        case 'today':
            start = today; end = today; break;

        case 'yesterday':
            start = yesterday; end = yesterday; break;

        case 'this_week':
            start = startOfWeek(today); end = today; break;

        case 'last_week': {
            const thisWeekStart = startOfWeek(today);
            start = addDays(thisWeekStart, -7);
            end = addDays(thisWeekStart, -1);
            break;
        }

        case 'week_before_last': {
            const thisWeekStart = startOfWeek(today);
            start = addDays(thisWeekStart, -14);
            end = addDays(thisWeekStart, -8);
            break;
        }

        case 'this_month':
            start = startOfMonth(today); end = today; break;

        case 'last_month': {
            const prev = addMonths(startOfMonth(today), -1);
            start = startOfMonth(prev);
            end = endOfMonth(prev);
            break;
        }

        case 'month_before_last': {
            const prev = addMonths(startOfMonth(today), -2);
            start = startOfMonth(prev);
            end = endOfMonth(prev);
            break;
        }

        case 'this_year':
            start = `${civilToParts(today).y}-01-01`; end = today; break;

        case 'last_year': {
            const y = civilToParts(today).y - 1;
            start = `${y}-01-01`; end = `${y}-12-31`;
            break;
        }

        // Rolling windows deliberately end YESTERDAY, not today.
        //
        // Today is a partial day. Including it makes every comparison unfair in
        // a direction that changes with the hour the question is asked — the
        // same question gives a different answer at 9am and 9pm. Excluding it
        // makes trailing_7_days and prior_7_days exactly comparable. The
        // resolved range is always shown to the user, and 'this_week' /
        // 'today' remain available when they do want the partial day.
        case 'trailing_7_days':
            start = addDays(yesterday, -6); end = yesterday; break;
        case 'prior_7_days':
            start = addDays(yesterday, -13); end = addDays(yesterday, -7); break;
        case 'trailing_30_days':
            start = addDays(yesterday, -29); end = yesterday; break;
        case 'prior_30_days':
            start = addDays(yesterday, -59); end = addDays(yesterday, -30); break;
        case 'trailing_90_days':
            start = addDays(yesterday, -89); end = yesterday; break;

        case 'all_time':
            start = null; end = null; break;

        case 'custom': {
            if (!startDate || !endDate) {
                throw new PeriodError(
                    'period "custom" requires both start_date and end_date as YYYY-MM-DD',
                    'missing_custom_range',
                );
            }
            civilToParts(startDate);
            civilToParts(endDate);
            if (startDate > endDate) {
                throw new PeriodError(`start_date ${startDate} is after end_date ${endDate}`, 'inverted_range');
            }
            start = startDate; end = endDate;
            break;
        }

        default:
            throw new PeriodError(`Unhandled period token: ${token}`, 'unknown_period');
    }

    return {
        token,
        start,
        end,
        label: rangeLabel(start, end),
        description: PERIOD_DEFS.find((d) => d.token === token).desc,
    };
}

/** "Aug 17 – Aug 23, 2026", or "Aug 24, 2026" for a single day. */
function rangeLabel(start, end) {
    if (start === null && end === null) return 'all recorded journeys';
    const s = civilToParts(start);
    const e = civilToParts(end);
    const sShort = `${MONTH_NAMES[s.m - 1].slice(0, 3)} ${s.d}`;
    const eShort = `${MONTH_NAMES[e.m - 1].slice(0, 3)} ${e.d}`;
    if (start === end) return `${sShort}, ${s.y}`;
    if (s.y !== e.y) return `${sShort}, ${s.y} – ${eShort}, ${e.y}`;
    return `${sShort} – ${eShort}, ${e.y}`;
}

/**
 * Resolve every non-custom token at once. This is what the prompt builder
 * renders into the system prompt so the model can quote a date range in prose
 * without ever calculating one.
 */
function resolveAll(opts) {
    const out = [];
    for (const { token } of PERIOD_DEFS) {
        if (token === 'custom') continue;
        out.push(resolvePeriod(token, opts));
    }
    return out;
}

/** Deterministic fallback for a missing comparison side. Null if none fits. */
function comparisonPartner(token) {
    return COMPARISON_PARTNER[token] || null;
}

module.exports = {
    PERIOD_DEFS,
    PERIOD_TOKENS,
    PeriodError,
    WEEK_START,
    WEEK_START_LABEL,
    resolvePeriod,
    resolveAll,
    comparisonPartner,
    todayInZone,
    humanDate,
    rangeLabel,
    addDays,
    dayOfWeek,
    startOfWeek,
    startOfMonth,
    endOfMonth,
};
