const { haversine } = require('./geo');
const { formatDuration } = require('./format');

// Journey statistics for upload, point deletion, combine and flight import. A track is
// parallel arrays: times (ms), coords [lat, lon], elevations (m|null), speeds (mph).

const MPS_TO_MPH = 2.23694;
const METERS_PER_MILE = 1609.344;
const ELEVATION_STEP_M = 0.5;

// Math.max(...array) throws past ~130k elements.
function maxOf(values, fallback = 0) {
    let best = -Infinity;
    for (const value of values) {
        if (Number.isFinite(value) && value > best) best = value;
    }
    return best === -Infinity ? fallback : best;
}

function minOf(values, fallback = 0) {
    let best = Infinity;
    for (const value of values) {
        if (Number.isFinite(value) && value < best) best = value;
    }
    return best === Infinity ? fallback : best;
}

function round2(value) {
    return Number(Number(value).toFixed(2));
}

function trackSpeedMph(fromCoord, fromTs, toCoord, toTs) {
    const dt = (toTs - fromTs) / 1000;
    if (!(dt > 0)) return null;
    const miles = haversine(fromCoord[0], fromCoord[1], toCoord[0], toCoord[1]);
    return ((miles * METERS_PER_MILE) / dt) * MPS_TO_MPH;
}

/** Upload path. @param {Array<{ts, lat, lon, ele?, speedMps?}>} samples in recording order */
function statsFromSamples(samples) {
    const times = [];
    const coords = [];
    const elevations = [];
    const speedsMph = [];
    let totalMiles = 0;
    let topSpeedMps = 0;
    let sumSpeedMps = 0;
    let speedSamples = 0;
    let topElevation = -Infinity;
    let lowestElevation = Infinity;
    let sumElevation = 0;
    let elevGainM = 0;
    let elevLossM = 0;
    let lastEle = null;
    const distances = [];

    for (let i = 0; i < samples.length; i++) {
        const { ts, lat, lon, ele } = samples[i];
        let sp = samples[i].speedMps;
        if (i > 0) {
            const prev = samples[i - 1];
            const miles = haversine(prev.lat, prev.lon, lat, lon);
            const dt = (ts - prev.ts) / 1000;
            if (dt > 0) {
                totalMiles += miles;
                if (!Number.isFinite(sp) || sp <= 0) sp = (miles * METERS_PER_MILE) / dt;
            }
        }
        if (Number.isFinite(ele)) {
            if (ele > topElevation) topElevation = ele;
            if (ele < lowestElevation) lowestElevation = ele;
            sumElevation += ele;
            if (Number.isFinite(lastEle)) {
                const dEle = ele - lastEle;
                if (dEle > ELEVATION_STEP_M) elevGainM += dEle;
                else if (dEle < -ELEVATION_STEP_M) elevLossM += Math.abs(dEle);
            }
            lastEle = ele;
        }
        if (Number.isFinite(sp) && sp >= 0) {
            if (sp > topSpeedMps) topSpeedMps = sp;
            sumSpeedMps += sp;
            speedSamples += 1;
        }
        times.push(ts);
        coords.push([lat, lon]);
        elevations.push(Number.isFinite(ele) ? ele : null);
        speedsMph.push(Number.isFinite(sp) ? sp * MPS_TO_MPH : 0);
        distances.push(totalMiles);
    }

    const count = samples.length;
    const avgSpeedMph = (speedSamples ? sumSpeedMps / speedSamples : 0) * MPS_TO_MPH;
    return finish({
        times, coords, elevations, speedsMph, distances, totalMiles,
        topSpeedMph: topSpeedMps * MPS_TO_MPH,
        avgSpeedMph,
        topElevation, lowestElevation, sumElevation, elevGainM, elevLossM, count,
    });
}

// Stored track, optionally without `removed` indices. Stored speeds are kept, except ones
// derived from a predecessor that was removed, which are re-derived.
function statsFromTrack(track, { removed = new Set() } = {}) {
    const { times, coords } = track;
    const elevationsIn = track.elevations || [];
    const speedsIn = track.speedsMph || [];

    const out = { times: [], coords: [], elevations: [], speedsMph: [], distances: [] };
    let totalMiles = 0;
    let topElevation = -Infinity;
    let lowestElevation = Infinity;
    let sumElevation = 0;
    let elevGainM = 0;
    let elevLossM = 0;
    let lastEle = null;
    let prev = -1;

    for (let i = 0; i < coords.length; i++) {
        if (removed.has(i)) continue;
        const coord = coords[i];
        const ts = times[i];
        let mph = Number.isFinite(speedsIn[i]) ? speedsIn[i] : 0;

        if (prev !== i - 1 && i > 0) {
            const derivedBefore = trackSpeedMph(coords[i - 1], times[i - 1], coord, ts);
            if (derivedBefore != null && Math.abs(mph - derivedBefore) <= 1e-9 * Math.max(1, derivedBefore)) {
                mph = prev >= 0 ? (trackSpeedMph(coords[prev], times[prev], coord, ts) ?? 0) : 0;
            }
        }
        if (prev >= 0) {
            const dt = (ts - times[prev]) / 1000;
            if (dt > 0) totalMiles += haversine(coords[prev][0], coords[prev][1], coord[0], coord[1]);
        }

        const ele = elevationsIn[i];
        if (Number.isFinite(ele)) {
            if (ele > topElevation) topElevation = ele;
            if (ele < lowestElevation) lowestElevation = ele;
            sumElevation += ele;
            if (Number.isFinite(lastEle)) {
                const dEle = ele - lastEle;
                if (dEle > ELEVATION_STEP_M) elevGainM += dEle;
                else if (dEle < -ELEVATION_STEP_M) elevLossM += Math.abs(dEle);
            }
            lastEle = ele;
        }

        out.times.push(ts);
        out.coords.push(coord);
        out.elevations.push(Number.isFinite(ele) ? ele : null);
        out.speedsMph.push(mph);
        out.distances.push(totalMiles);
        prev = i;
    }

    let sumMph = 0;
    for (const mph of out.speedsMph) sumMph += mph;
    return finish({
        ...out,
        totalMiles,
        topSpeedMph: maxOf(out.speedsMph, 0),
        avgSpeedMph: out.speedsMph.length ? sumMph / out.speedsMph.length : 0,
        topElevation, lowestElevation, sumElevation, elevGainM, elevLossM,
        count: out.coords.length,
    });
}

function finish(s) {
    const count = s.count;
    const firstTs = count ? s.times[0] : null;
    const lastTs = count ? s.times[count - 1] : null;
    const first = count ? s.coords[0] : null;
    const last = count ? s.coords[count - 1] : null;
    return {
        count,
        firstTs,
        lastTs,
        totalMiles: s.totalMiles,
        avgSpeedMph: s.avgSpeedMph,
        distance: round2(s.totalMiles),
        duration: formatDuration(firstTs != null ? (lastTs - firstTs) / 1000 : 0),
        top_speed: round2(s.topSpeedMph),
        avg_speed: round2(s.avgSpeedMph),
        top_elevation: round2(s.topElevation === -Infinity ? 0 : s.topElevation),
        lowest_elevation: round2(s.lowestElevation === Infinity ? 0 : s.lowestElevation),
        avg_elevation: round2(count ? s.sumElevation / count : 0),
        elevation_gain: round2(s.elevGainM),
        elevation_loss: round2(s.elevLossM),
        start_time: firstTs != null ? new Date(firstTs).toISOString() : null,
        end_time: lastTs != null ? new Date(lastTs).toISOString() : null,
        start_lat: first ? first[0] : null,
        start_lon: first ? first[1] : null,
        end_lat: last ? last[0] : null,
        end_lon: last ? last[1] : null,
        coordinates: s.coords,
        profile_time_ms: s.times,
        profile_dist_mi: s.distances,
        profile_elev_m: s.elevations,
        profile_speed_mph: s.speedsMph,
    };
}

// Stable merge by time, so overlapping journeys never run backwards.
function mergeTracksByTime(tracks) {
    const points = [];
    tracks.forEach((track, t) => {
        for (let i = 0; i < track.coords.length; i++) {
            points.push({ t, i, ts: track.times[i] });
        }
    });
    points.sort((a, b) => (a.ts - b.ts) || (a.t - b.t) || (a.i - b.i));
    const merged = { times: [], coords: [], elevations: [], speedsMph: [] };
    for (const { t, i } of points) {
        const track = tracks[t];
        merged.times.push(track.times[i]);
        merged.coords.push(track.coords[i]);
        merged.elevations.push(track.elevations?.[i] ?? null);
        merged.speedsMph.push(Number.isFinite(track.speedsMph?.[i]) ? track.speedsMph[i] : 0);
    }
    return merged;
}

// Route row -> { track } or { error }. Missing times are spread over start..end.
function trackFromRow(row) {
    const coords = Array.isArray(row.coordinates) ? row.coordinates : [];
    const n = coords.length;
    const series = {
        times: row.profile_time_ms,
        elevations: row.profile_elev_m,
        speedsMph: row.profile_speed_mph,
    };
    for (const [name, values] of Object.entries(series)) {
        if (values != null && !Array.isArray(values)) return { error: `${name} is not a list` };
        if (Array.isArray(values) && values.length > 0 && values.length !== n) {
            return { error: `the journey's ${name} (${values.length}) and coordinates (${n}) don't line up` };
        }
    }
    for (const coord of coords) {
        if (!Array.isArray(coord) || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) {
            return { error: 'the journey has malformed coordinates' };
        }
    }

    let times = Array.isArray(series.times) && series.times.length === n ? series.times.map(Number) : null;
    if (!times) {
        const start = row.start_time ? new Date(row.start_time).getTime() : 0;
        const end = row.end_time ? new Date(row.end_time).getTime() : start;
        const denom = Math.max(n - 1, 1);
        times = coords.map((_, i) => start + Math.floor((end - start) * (i / denom)));
    }
    return {
        track: {
            times,
            coords,
            elevations: Array.isArray(series.elevations) && series.elevations.length === n
                ? series.elevations.map((v) => (v == null ? null : Number(v)))
                : new Array(n).fill(null),
            speedsMph: Array.isArray(series.speedsMph) && series.speedsMph.length === n
                ? series.speedsMph.map(Number)
                : new Array(n).fill(0),
        },
    };
}

module.exports = {
    MPS_TO_MPH,
    maxOf,
    minOf,
    statsFromSamples,
    statsFromTrack,
    mergeTracksByTime,
    trackFromRow,
};
