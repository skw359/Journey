const crypto = require('crypto');
const path = require('path');
const unzipper = require('unzipper');
const csv = require('csv-parser');
const { statsFromSamples } = require('./journeyStats');

// Journey upload: a zip with exactly one CSV (ts_ms, lat, lon, ele_m, speed_ms, waypoint, note).

class IngestError extends Error {
    constructor(message, { status = 400, code = 'invalid_upload' } = {}) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function isZipClutter(entryPath) {
    const name = path.posix.basename(entryPath);
    return entryPath.startsWith('__MACOSX/') || name.startsWith('._') || name === '.DS_Store';
}

async function readJourneyCsv(filePath, { maxCsvBytes, maxRows, timeoutMs }) {
    let directory;
    try {
        directory = await unzipper.Open.file(filePath);
    } catch {
        throw new IngestError('The upload is not a valid zip file', { code: 'not_zip' });
    }

    const csvEntries = directory.files.filter((entry) =>
        entry.type === 'File' && /\.csv$/i.test(entry.path) && !isZipClutter(entry.path));
    if (csvEntries.length === 0) {
        throw new IngestError('The zip does not contain a CSV file', { code: 'no_csv' });
    }
    if (csvEntries.length > 1) {
        throw new IngestError(`The zip must contain exactly one CSV file (found ${csvEntries.length})`, { code: 'multiple_csv' });
    }
    const entry = csvEntries[0];
    if (entry.uncompressedSize > maxCsvBytes) {
        throw new IngestError('The journey CSV is too large', { status: 413, code: 'csv_too_large' });
    }

    return new Promise((resolve, reject) => {
        const rows = [];
        let bytes = 0;
        let settled = false;
        let source = null;
        let parser = null;

        const settle = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) {
                source?.destroy();
                parser?.destroy();
                reject(err);
            } else {
                resolve(rows);
            }
        };
        const timer = setTimeout(() => {
            settle(new IngestError('Reading the journey took too long', { status: 408, code: 'timeout' }));
        }, timeoutMs);

        try {
            source = entry.stream();
        } catch {
            settle(new IngestError('The zip file is corrupt', { code: 'corrupt_zip' }));
            return;
        }
        parser = csv();
        source.on('data', (chunk) => {
            bytes += chunk.length;
            // The zip header's size can lie.
            if (bytes > maxCsvBytes) settle(new IngestError('The journey CSV is too large', { status: 413, code: 'csv_too_large' }));
        });
        source.on('error', () => settle(new IngestError('The zip file is corrupt', { code: 'corrupt_zip' })));
        parser.on('data', (row) => {
            if (rows.length >= maxRows) {
                settle(new IngestError(`The journey has more than ${maxRows} rows`, { status: 413, code: 'too_many_rows' }));
                return;
            }
            rows.push(row);
        });
        parser.on('error', (err) => settle(new IngestError(`CSV parse error: ${err.message}`, { code: 'csv_error' })));
        parser.on('end', () => settle(null));
        source.pipe(parser);
    });
}

// Skips unusable rows, sorts by time if needed, drops exact repeats.
function samplesFromRows(rows) {
    let samples = [];
    for (const row of rows) {
        const ts = Number(row.ts_ms);
        const lat = parseFloat(row.lat);
        const lon = parseFloat(row.lon);
        if (!Number.isFinite(ts) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        samples.push({
            ts,
            lat,
            lon,
            ele: parseFloat(row.ele_m),
            speedMps: parseFloat(row.speed_ms),
            waypoint: row.waypoint === '1',
            note: typeof row.note === 'string' ? row.note.slice(0, 2000) : '',
        });
    }

    let ordered = true;
    for (let i = 1; i < samples.length; i++) {
        if (samples[i].ts < samples[i - 1].ts) { ordered = false; break; }
    }
    if (!ordered) {
        samples = samples.map((sample, i) => ({ sample, i }))
            .sort((a, b) => (a.sample.ts - b.sample.ts) || (a.i - b.i))
            .map(({ sample }) => sample);
    }
    samples = samples.filter((s, i) => {
        if (i === 0) return true;
        const p = samples[i - 1];
        return !(s.ts === p.ts && s.lat === p.lat && s.lon === p.lon
            && Object.is(s.ele, p.ele) && Object.is(s.speedMps, p.speedMps) && s.waypoint === p.waypoint);
    });

    const waypoints = samples.filter((s) => s.waypoint).map((s) => ({
        id: `wp-${crypto.randomBytes(8).toString('hex')}`,
        lat: s.lat,
        lon: s.lon,
        timestamp: s.ts,
        note: s.note,
        elevation: Number.isFinite(s.ele) ? s.ele : null,
    }));
    return { samples, waypoints };
}

// Recognizes a re-upload from clients that don't send a recording id.
function contentFingerprint(stats) {
    if (!stats.count) return null;
    const first = stats.coordinates[0];
    const last = stats.coordinates[stats.count - 1];
    const basis = [stats.count, stats.firstTs, stats.lastTs, first[0], first[1], last[0], last[1], stats.totalMiles.toFixed(6)].join('|');
    return `v1:${crypto.createHash('sha256').update(basis).digest('hex')}`;
}

function journeyName(start) {
    return `Journey - ${start.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })} - ${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function journeyDate(start) {
    return start.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

async function parseJourneyUpload(filePath, limits) {
    const rows = await readJourneyCsv(filePath, limits);
    const { samples, waypoints } = samplesFromRows(rows);
    const stats = statsFromSamples(samples);
    return { stats, waypoints, fingerprint: contentFingerprint(stats) };
}

module.exports = {
    IngestError,
    readJourneyCsv,
    samplesFromRows,
    contentFingerprint,
    journeyName,
    journeyDate,
    parseJourneyUpload,
};
