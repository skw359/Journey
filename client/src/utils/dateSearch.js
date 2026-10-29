/**
 * dateSearch.js — interprets the header search box as a date query.
 *
 * The search field stays a single free-text input. When what the user typed
 * looks like a date, `parseDateQuery` returns a half-open [start, end) window
 * in LOCAL time; otherwise it returns null and callers fall back to plain
 * name matching.
 *
 * Recognized shapes (case-insensitive, commas/periods/ordinals ignored):
 *   Day    "Oct 13 2025"  "October 13th, 2025"  "13 Oct 2025"
 *          "10/13/2025"   "10-13-25"   "2025-10-13"   "10/13" (current year)
 *   Month  "Oct 2025"     "October 2025"  "10/2025"  "2025-10"  "October"
 *   Year   "2025"
 *   Range  "Oct 13 2025 - Oct 20 2025"   "Oct 2025 to Dec 2025"
 *          "2025-10-13..2025-10-20"      (also –, —, "through", "until")
 *
 * Windows are built from local date components so a journey recorded at
 * 11pm local on Oct 13 lands on Oct 13, and DST transitions stay correct.
 */

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

// Only separators with surrounding whitespace (or "..") count, so the hyphens
// inside "10-13-2025" are never mistaken for a range separator.
const RANGE_SEPARATOR = /\s+(?:-|–|—|to|through|thru|until)\s+|\s*\.\.+\s*/;

// A separator the user has typed but not yet followed with a second date, so
// "Oct 13 2025 - " keeps showing Oct 13 instead of blanking the list mid-type.
const DANGLING_SEPARATOR = /(?:\s+(?:-|–|—|to|through|thru|until)|\s*\.\.+)\s*$/i;

const currentYear = () => new Date().getFullYear();

function normalizeYear(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  if (String(raw).length <= 2) return n <= 68 ? 2000 + n : 1900 + n;
  return n;
}

const isValidYear = (y) => Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;

/** Local midnight, or null if the calendar date does not exist (e.g. Feb 30). */
function localMidnight(y, m, d) {
  if (!isValidYear(y) || !Number.isInteger(m) || m < 0 || m > 11) return null;
  if (!Number.isInteger(d) || d < 1 || d > 31) return null;
  const dt = new Date(y, m, d, 0, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) return null;
  return dt;
}

function dayTerm(y, m, d) {
  const start = localMidnight(y, m, d);
  if (!start) return null;
  return { precision: 'day', y, m, d, start, end: new Date(y, m, d + 1, 0, 0, 0, 0) };
}

function monthTerm(y, m) {
  if (!isValidYear(y) || !Number.isInteger(m) || m < 0 || m > 11) return null;
  return { precision: 'month', y, m, d: null, start: new Date(y, m, 1, 0, 0, 0, 0), end: new Date(y, m + 1, 1, 0, 0, 0, 0) };
}

function yearTerm(y) {
  if (!isValidYear(y)) return null;
  return { precision: 'year', y, m: null, d: null, start: new Date(y, 0, 1, 0, 0, 0, 0), end: new Date(y + 1, 0, 1, 0, 0, 0, 0) };
}

/** Parse one side of a query (or the whole query when there is no range). */
function parseTerm(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/(\d)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  let m;

  // 2025-10-13 / 2025/10/13
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) {
    return dayTerm(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  // 2025-10
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})$/))) {
    return monthTerm(Number(m[1]), Number(m[2]) - 1);
  }
  // 10/13/2025, 10-13-25
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/))) {
    return dayTerm(normalizeYear(m[3]), Number(m[1]) - 1, Number(m[2]));
  }
  // 10/2025
  if ((m = s.match(/^(\d{1,2})[-/](\d{4})$/))) {
    return monthTerm(Number(m[2]), Number(m[1]) - 1);
  }
  // 10/13 — current year
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})$/))) {
    return dayTerm(currentYear(), Number(m[1]) - 1, Number(m[2]));
  }
  // oct 13 2025 / october 13 25
  if ((m = s.match(/^([a-z]+) (\d{1,2}) (\d{2,4})$/)) && MONTHS[m[1]] != null) {
    return dayTerm(normalizeYear(m[3]), MONTHS[m[1]], Number(m[2]));
  }
  // 13 oct 2025
  if ((m = s.match(/^(\d{1,2}) ([a-z]+) (\d{2,4})$/)) && MONTHS[m[2]] != null) {
    return dayTerm(normalizeYear(m[3]), MONTHS[m[2]], Number(m[1]));
  }
  // oct 2025
  if ((m = s.match(/^([a-z]+) (\d{4})$/)) && MONTHS[m[1]] != null) {
    return monthTerm(Number(m[2]), MONTHS[m[1]]);
  }
  // oct 13 — current year
  if ((m = s.match(/^([a-z]+) (\d{1,2})$/)) && MONTHS[m[1]] != null) {
    return dayTerm(currentYear(), MONTHS[m[1]], Number(m[2]));
  }
  // 13 oct — current year
  if ((m = s.match(/^(\d{1,2}) ([a-z]+)$/)) && MONTHS[m[2]] != null) {
    return dayTerm(currentYear(), MONTHS[m[2]], Number(m[1]));
  }
  // october — that month of the current year
  if ((m = s.match(/^([a-z]+)$/)) && MONTHS[m[1]] != null) {
    return monthTerm(currentYear(), MONTHS[m[1]]);
  }
  // 2025
  if ((m = s.match(/^(\d{4})$/))) {
    return yearTerm(Number(m[1]));
  }

  return null;
}

function formatTermLabel(term) {
  if (term.precision === 'day') return `${MONTH_SHORT[term.m]} ${term.d}, ${term.y}`;
  if (term.precision === 'month') return `${MONTH_LONG[term.m]} ${term.y}`;
  return String(term.y);
}

function formatRangeLabel(a, b) {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  if (first.precision === 'day' && second.precision === 'day' && first.y === second.y) {
    return `${MONTH_SHORT[first.m]} ${first.d} – ${MONTH_SHORT[second.m]} ${second.d}, ${first.y}`;
  }
  return `${formatTermLabel(first)} – ${formatTermLabel(second)}`;
}

/**
 * Parse a search string into { start, end, precision, label }, or null when it
 * is not a date. `end` is exclusive.
 */
export function parseDateQuery(query) {
  const raw = String(query || '').trim().replace(DANGLING_SEPARATOR, '').trim();
  if (!raw) return null;

  const parts = raw.split(RANGE_SEPARATOR).map(p => p.trim()).filter(Boolean);

  if (parts.length === 2) {
    const a = parseTerm(parts[0]);
    const b = parseTerm(parts[1]);
    if (!a || !b) return null;
    return {
      start: a.start <= b.start ? a.start : b.start,
      end: a.end >= b.end ? a.end : b.end,
      precision: 'range',
      label: formatRangeLabel(a, b),
    };
  }

  if (parts.length === 1) {
    const term = parseTerm(parts[0]);
    if (!term) return null;
    return { start: term.start, end: term.end, precision: term.precision, label: formatTermLabel(term) };
  }

  return null;
}

function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * True when a journey overlaps the window. A journey that runs past midnight
 * matches both days it touches.
 */
export function matchesDateWindow(window, startISO, endISO) {
  if (!window) return false;
  const start = toTime(startISO);
  if (start == null) return false;
  const end = toTime(endISO);
  const spanEnd = end != null && end >= start ? end : start;
  return start < window.end.getTime() && spanEnd >= window.start.getTime();
}

/**
 * Shared predicate for the journey list and the Recently Deleted list: a date
 * query matches on date OR name, so typing something like "2025" never hides a
 * journey whose name contains it.
 */
export function matchesSearch(item, searchValue, dateWindow) {
  const needle = String(searchValue || '').trim().toLowerCase();
  if (!needle) return true;
  const nameMatch = String(item?.name || '').toLowerCase().includes(needle);
  if (!dateWindow) return nameMatch;
  return nameMatch || matchesDateWindow(dateWindow, item?.startTime, item?.endTime);
}
