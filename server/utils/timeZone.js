// Calendar fields of an instant in a named IANA zone. Journeys are stored as instants; which
// day, weekday or hour one falls in depends on who is looking.

const formatters = new Map();

function formatterFor(timeZone) {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            weekday: 'short',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        formatters.set(timeZone, formatter);
    }
    return formatter;
}

/** A valid IANA zone name, or null. */
function parseTimeZone(raw) {
    if (typeof raw !== 'string') return null;
    const timeZone = raw.trim();
    if (!timeZone || timeZone.length > 64) return null;
    try {
        formatterFor(timeZone);
        return timeZone;
    } catch {
        return null;
    }
}

function serverTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** { dateKey: 'YYYY-MM-DD', monthKey: 'YYYY-MM', year, month: 0-11, dow: 0-6 (Sunday 0), hour, minute, second } */
function zoneParts(date, timeZone) {
    const parts = {};
    for (const { type, value } of formatterFor(timeZone).formatToParts(date)) parts[type] = value;
    const monthKey = `${parts.year}-${parts.month}`;
    return {
        dateKey: `${monthKey}-${parts.day}`,
        monthKey,
        year: Number(parts.year),
        month: Number(parts.month) - 1,
        dow: WEEKDAYS[parts.weekday],
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

/** 'YYYY-MM-DD' shifted by whole days. */
function shiftDateKey(dateKey, days) {
    return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** 'YYYY-MM' shifted by whole months. */
function shiftMonthKey(monthKey, months) {
    const [year, month] = monthKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 7);
}

module.exports = { parseTimeZone, serverTimeZone, zoneParts, shiftDateKey, shiftMonthKey };
