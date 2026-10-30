const express = require('express');
const router = express.Router();
const { withTenantClient } = require('../db');
const { haversine } = require('../utils/geo');
const { MIN_ROUTE_MILES } = require('../config');
const { visibleSql } = require('../utils/visibility');
const { ensureDerived, FINE_LEVEL, COARSE_LEVEL } = require('../utils/journeyDerived');
const funStatsCache = require('../utils/funStatsCache');
const log = require('../utils/logger').scope('funstats');

const EARTH_RADIUS_MILES = 3958.8;

// DBSCAN clustering on [lat, lon] pairs using haversine distance. Neighbor searches only
// scan the 27 surrounding cells of a grid over unit-sphere positions; the haversine test
// and visiting order are unchanged, so the clusters are identical to a full scan.
function dbscan(points, epsilonMiles, minPoints) {
    const n = points.length;
    const labels = new Int32Array(n).fill(-1);
    let clusterId = 0;

    const cellSize = 2 * Math.sin(Math.min(Math.PI, epsilonMiles / EARTH_RADIUS_MILES) / 2) * 1.000001 + 1e-12;
    const cells = points.map(([lat, lon]) => {
        const phi = lat * Math.PI / 180;
        const lambda = lon * Math.PI / 180;
        return [
            Math.floor((Math.cos(phi) * Math.cos(lambda)) / cellSize),
            Math.floor((Math.cos(phi) * Math.sin(lambda)) / cellSize),
            Math.floor(Math.sin(phi) / cellSize),
        ];
    });
    const grid = new Map();
    cells.forEach((c, i) => {
        const key = c.join(',');
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
    });

    function regionQuery(idx) {
        const neighbors = [];
        const [lat1, lon1] = points[idx];
        const [cx, cy, cz] = cells[idx];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                    if (!bucket) continue;
                    for (const i of bucket) {
                        if (haversine(lat1, lon1, points[i][0], points[i][1]) <= epsilonMiles) {
                            neighbors.push(i);
                        }
                    }
                }
            }
        }
        return neighbors.sort((a, b) => a - b);
    }

    for (let i = 0; i < n; i++) {
        if (labels[i] !== -1) continue;
        const neighbors = regionQuery(i);
        if (neighbors.length < minPoints) {
            labels[i] = -2;
            continue;
        }
        labels[i] = clusterId;
        const seed = new Set(neighbors);
        seed.delete(i);
        const queue = [...seed];
        while (queue.length > 0) {
            const q = queue.pop();
            if (labels[q] === -2) labels[q] = clusterId;
            if (labels[q] !== -1) continue;
            labels[q] = clusterId;
            const qNeighbors = regionQuery(q);
            if (qNeighbors.length >= minPoints) {
                for (const nb of qNeighbors) {
                    if (labels[nb] === -1 || labels[nb] === -2) {
                        if (!seed.has(nb)) { seed.add(nb); queue.push(nb); }
                    }
                }
            }
        }
        clusterId++;
    }
    return labels;
}

// The largest haversine distance from `home` to any point in a lat/lon box. For a fixed
// latitude the farthest longitude is an edge (or the antimeridian of home); for a fixed
// longitude the farthest latitude is an edge or the one critical latitude.
function maxDistanceToBox(home, box) {
    const [homeLat, homeLon] = home;
    const lons = [box.min_lon, box.max_lon];
    const anti = ((homeLon + 360) % 360) - 180;
    if (anti >= box.min_lon && anti <= box.max_lon) lons.push(anti);
    let best = 0;
    const phiH = homeLat * Math.PI / 180;
    for (const lon of lons) {
        const lats = [box.min_lat, box.max_lat];
        const a = Math.sin(phiH);
        const b = Math.cos(phiH) * Math.cos((lon - homeLon) * Math.PI / 180);
        for (const critical of [Math.atan2(a, b) + Math.PI, Math.atan2(a, b) - Math.PI]) {
            const deg = critical * 180 / Math.PI;
            if (deg >= box.min_lat && deg <= box.max_lat) lats.push(deg);
        }
        for (const lat of lats) best = Math.max(best, haversine(homeLat, homeLon, lat, lon));
    }
    return best + 1e-9;
}

// Furthest recorded point from home, exactly as a scan of every point (earliest point wins
// ties), but only reading journeys whose bounding box could hold a farther point.
async function findFurthestPoint(db, home, routes) {
    const candidates = routes
        .map((route, t) => ({ route, t, bound: route.min_lat == null ? -1 : maxDistanceToBox(home, route) }))
        .filter((c) => c.bound >= 0)
        .sort((x, y) => (y.bound - x.bound) || (x.t - y.t));
    let best = { miles: 0, coord: null, t: Infinity, i: Infinity };
    const BATCH = 8;
    for (let start = 0; start < candidates.length; start += BATCH) {
        const batch = candidates.slice(start, start + BATCH).filter((c) => c.bound >= best.miles);
        if (batch.length === 0) break;
        const { rows } = await db.query('SELECT id, coordinates FROM routes WHERE id = ANY($1)', [batch.map((c) => c.route.id)]);
        const coordsById = new Map(rows.map((row) => [row.id, row.coordinates || []]));
        for (const { route, t } of batch) {
            const coords = coordsById.get(route.id) || [];
            for (let i = 0; i < coords.length; i++) {
                const coord = coords[i];
                if (!Array.isArray(coord) || coord.length < 2) continue;
                const [lat, lon] = coord;
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                const miles = haversine(home[0], home[1], lat, lon);
                if (miles > best.miles || (miles === best.miles && miles > 0 && (t < best.t || (t === best.t && i < best.i)))) {
                    best = { miles, coord: [lat, lon], t, i };
                }
            }
        }
    }
    return best;
}

// Level system
const LEVELS = [
    { name: 'Wanderer', xp: 0 },
    { name: 'Explorer', xp: 1000 },
    { name: 'Pathfinder', xp: 5000 },
    { name: 'Navigator', xp: 15000 },
    { name: 'Cartographer', xp: 35000 },
    { name: 'Globe Trotter', xp: 75000 },
    { name: 'World Traveler', xp: 150000 },
    { name: 'Legend', xp: 300000 },
];

// Bingo challenges — deterministic set, checked against data
const BINGO_CHALLENGES = [
    { id: 'night_journey', label: 'Night Journey', desc: 'Travel between 9 PM - 4 AM' },
    { id: 'early_bird', label: 'Early Bird', desc: 'Journey starting before 6 AM' },
    { id: 'long_50', label: '50+ Mile Trip', desc: 'Single journey over 50 miles' },
    { id: 'long_100', label: '100+ Mile Trip', desc: 'Single journey over 100 miles' },
    { id: 'speed_70', label: 'Highway Speed', desc: 'Top speed 70+ mph' },
    { id: 'speed_90', label: 'Speed Demon', desc: 'Top speed 90+ mph' },
    { id: 'streak_3', label: '3-Day Streak', desc: '3 consecutive days traveling' },
    { id: 'streak_7', label: 'Week Streak', desc: '7 consecutive days traveling' },
    { id: 'round_trip', label: 'Round Trip', desc: 'End within 0.3 mi of start' },
    { id: 'five_in_day', label: '5 in a Day', desc: '5+ journeys in one day' },
    { id: 'weekend_warrior', label: 'Weekend Trip', desc: 'Journey on a weekend' },
    { id: 'micro_trip', label: 'Micro Trip', desc: 'Journey under 1 mile' },
    { id: 'hour_plus', label: 'Hour+ Journey', desc: 'Single journey over 1 hour' },
    { id: 'three_hour', label: '3-Hour Journey', desc: 'Single journey over 3 hours' },
    { id: 'ten_locations', label: '10 Locations', desc: 'Visit 10+ unique locations' },
    { id: 'fifty_journeys', label: '50 Journeys', desc: 'Record 50 total journeys' },
    { id: 'hundred_miles', label: '100 Total Miles', desc: 'Travel 100+ miles total' },
    { id: 'five_hundred_miles', label: '500 Total Miles', desc: 'Travel 500+ miles total' },
    { id: 'walk_journey', label: 'Walking Trip', desc: 'Journey on foot' },
    { id: 'scooter_journey', label: 'Scooter Trip', desc: 'Journey by scooter' },
    { id: 'noon_start', label: 'High Noon', desc: 'Journey starting 12:00-12:59' },
    { id: 'friday_journey', label: 'Friday Vibes', desc: 'Journey on a Friday' },
    { id: 'far_from_home_10', label: '10 mi From Home', desc: 'Reach 10+ miles from home' },
    { id: 'far_from_home_50', label: '50 mi From Home', desc: 'Reach 50+ miles from home' },
    { id: 'diversity_20', label: '20 Unique Routes', desc: '20+ unique route pairs' },
];

// Spirit animal classification
function classifySpiritAnimal(stats) {
    const { avgSpeedMph, routeDiversityPct, avgDistMi, nightPct, weekendPct,
            roundTripPct, elevGain, totalRoutes, streakDays, explorationPct } = stats;

    const scores = {};

    // Hawk: fast, direct
    scores.hawk = (avgSpeedMph > 30 ? 3 : avgSpeedMph > 20 ? 2 : 1)
        + (routeDiversityPct < 40 ? 2 : 1) + (avgDistMi > 10 ? 2 : 1);

    // Fox: many short exploratory trips
    scores.fox = (avgDistMi < 5 ? 3 : avgDistMi < 10 ? 2 : 1)
        + (routeDiversityPct > 60 ? 3 : routeDiversityPct > 40 ? 2 : 1)
        + (explorationPct > 50 ? 2 : 1);

    // Bear: long infrequent journeys
    scores.bear = (avgDistMi > 20 ? 3 : avgDistMi > 10 ? 2 : 1)
        + (totalRoutes < 50 ? 2 : totalRoutes < 100 ? 1 : 0);

    // Dolphin: round trips, balanced
    scores.dolphin = (roundTripPct > 40 ? 3 : roundTripPct > 20 ? 2 : 1)
        + (routeDiversityPct > 30 && routeDiversityPct < 70 ? 2 : 1);

    // Wolf: consistent, social (weekend heavy, streaks)
    scores.wolf = (weekendPct > 40 ? 3 : weekendPct > 30 ? 2 : 1)
        + (streakDays > 5 ? 3 : streakDays > 3 ? 2 : 1);

    // Owl: night traveler
    scores.owl = (nightPct > 30 ? 4 : nightPct > 15 ? 3 : nightPct > 5 ? 2 : 1);

    // Eagle: high elevation, long distance
    scores.eagle = (elevGain > 10000 ? 3 : elevGain > 5000 ? 2 : 1)
        + (avgDistMi > 15 ? 2 : 1);

    // Hummingbird: frequent short trips, high diversity
    scores.hummingbird = (totalRoutes > 200 ? 3 : totalRoutes > 100 ? 2 : 1)
        + (avgDistMi < 5 ? 3 : avgDistMi < 8 ? 2 : 1)
        + (routeDiversityPct > 50 ? 2 : 1);

    let best = 'fox';
    let bestScore = 0;
    for (const [animal, score] of Object.entries(scores)) {
        if (score > bestScore) { bestScore = score; best = animal; }
    }
    return best;
}

const SPIRIT_ANIMALS = {
    hawk:        { name: 'Hawk',        trait: 'Fast and direct — you love the open road and highways' },
    fox:         { name: 'Fox',         trait: 'Curious explorer — lots of short adventures to new places' },
    bear:        { name: 'Bear',        trait: 'Deliberate traveler — fewer trips but they are epic' },
    dolphin:     { name: 'Dolphin',     trait: 'Balanced navigator — steady round trips and routines' },
    wolf:        { name: 'Wolf',        trait: 'Consistent pack traveler — weekends and streaks are your thing' },
    owl:         { name: 'Owl',         trait: 'Night rider — the darkness is your domain' },
    eagle:       { name: 'Eagle',       trait: 'High altitude, long distance — you soar above it all' },
    hummingbird: { name: 'Hummingbird', trait: 'Hyper-mobile — constantly buzzing between destinations' },
};

function stdDev(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
    return Math.sqrt(variance);
}

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getRouteTimelineDate(route) {
    if (route.start_time instanceof Date && !Number.isNaN(route.start_time.getTime())) {
        return route.start_time;
    }

    if (typeof route.date === 'string' && route.date.trim()) {
        const rawDate = route.date.trim();
        const parsed = new Date(rawDate.includes('T') ? rawDate : `${rawDate}T00:00:00Z`);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }

    return null;
}

function buildMonthRange(startDate, endDate) {
    if (!startDate || !endDate) return [];

    const months = [];
    const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    const lastMonth = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));

    while (cursor <= lastMonth) {
        months.push(cursor.toISOString().slice(0, 7));
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return months;
}

// GET /api/fun-stats — cached until the account's journeys change (or the date does).
router.get('/fun-stats', async (req, res) => {
    try {
        await ensureDerived(req.userId);
        const stats = await withTenantClient(req.userId, async (db) => {
            // One snapshot, so the cached result matches the version it's stored under.
            await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            try {
                const now = new Date();
                const { rows: [state] } = await db.query('SELECT data_version FROM tenant_state');
                const key = `${state?.data_version}|${now.toISOString().slice(0, 10)}|${now.toDateString()}`;
                const cached = funStatsCache.get(req.userId, key);
                if (cached) return cached;
                const computed = await computeFunStats(db, now);
                funStatsCache.set(req.userId, key, computed);
                return computed;
            } finally {
                await db.query('COMMIT').catch(() => {});
            }
        });
        res.json(stats);
    } catch (err) {
        log.error('GET /api/fun-stats error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

async function computeFunStats(db, now) {
    const { rows: rawRoutes } = await db.query(`
        SELECT r.id, r.name, r.date, r.distance, r.duration, r.top_speed, r.avg_speed,
               r.start_time, r.end_time, r.start_lat, r.start_lon,
               r.end_lat, r.end_lon, r.travel_mode, r.elevation_gain, r.elevation_loss,
               r.top_elevation, r.weather_temp, r.weather_feels_like, r.weather_humidity,
               r.weather_wind_speed, r.weather_condition, r.cities_passed, r.places_passed,
               d.point_count, d.valid_points, d.min_lat, d.min_lon, d.max_lat, d.max_lon,
               d.extremes, d.states,
               d.heat_lat[d.heat_off[$2]:d.heat_off[$2 + 1] - 1] AS coarse_lat,
               d.heat_lon[d.heat_off[$2]:d.heat_off[$2 + 1] - 1] AS coarse_lon
        FROM routes r
        JOIN route_derived d ON d.route_id = r.id
        WHERE ${visibleSql('$1', 'r')}
        ORDER BY r.start_time ASC, r.id ASC
    `, [MIN_ROUTE_MILES, COARSE_LEVEL]);
    const { rows: [fine] } = await db.query('SELECT COUNT(*)::int AS cells FROM heat_cells WHERE level = $1', [FINE_LEVEL]);

    const routes = rawRoutes.slice().sort((a, b) => {
        const aDate = getRouteTimelineDate(a);
        const bDate = getRouteTimelineDate(b);

        if (aDate && bDate) return aDate.getTime() - bDate.getTime();
        if (aDate) return -1;
        if (bDate) return 1;
        return 0;
    });

    if (routes.length === 0) {
        return { empty: true };
    }

    // ── Aggregate trackers ──
    let totalDistance = 0, totalTimeMs = 0, maxSpeed = 0;
    let longestDistRoute = null, longestTimeRoute = null;
    let longestDistVal = 0, longestTimeVal = 0;
    let shortestDistRoute = null, shortestDistVal = Infinity;
    let fastestAvgRoute = null, fastestAvgVal = 0;
    let totalElevGain = 0, totalElevLoss = 0, maxElevation = -Infinity, hasElevation = false;

    const coarseCells = new Set();
    const startCoords = [];
    const routePairs = new Set();
    const dayDistances = {};
    const monthDistances = {};
    const dayRouteCounts = {};
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOfWeekCounts = new Array(7).fill(0);
    const hourCounts = new Array(24).fill(0);
    const weekdayStartHourSamples = new Array(7).fill(null).map(() => []);
    const startHourSamples = [];
    let morningCount = 0, afternoonCount = 0, eveningCount = 0, nightCount = 0;
    let weekdayCount = 0, weekendCount = 0;
    let weekdayDistance = 0, weekendDistance = 0;
    let roundTripCount = 0;
    let weekdayRoundTripCount = 0, weekendRoundTripCount = 0;
    let commuteWindowCount = 0;
    const modeCounts = { drive: 0, scooter: 0, foot: 0, train: 0, metro: 0 };
    const modeDistances = { drive: 0, scooter: 0, foot: 0, train: 0, metro: 0 };
    let modeSwitchCount = 0, modeSwitchTransitions = 0;
    let previousMode = null;
    const directionCounts = new Array(8).fill(0);
    const seasonCounts = { spring: 0, summer: 0, fall: 0, winter: 0 };
    const seasonDistances = { spring: 0, summer: 0, fall: 0, winter: 0 };
    let firstJourney = null, lastJourney = null;
    let firstJourneyDate = null;
    let totalPoints = 0;
    const avgSpeeds = [];
    const seenRouteCoarseCells = new Set();
    let newTerritoryJourneyCount = 0;
    const routePairKeys = [];

    // For most repeated route
    const routePairCounts = {};

    // Track extreme points
    let northernmost = null, southernmost = null, easternmost = null, westernmost = null;
    let maxLat = -Infinity, minLat = Infinity, maxLon = -Infinity, minLon = Infinity;

    // For new-territory-this-month
    const thisMonthStr = now.toISOString().slice(0, 7);
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthStr = lastMonthDate.toISOString().slice(0, 7);
    const cellsThisMonth = new Set();
    const cellsLastMonth = new Set();
    const cellsBeforeThisMonth = new Set();

    // Highest avg elevation journey (superlative: "most scenic")
    let mostScenicRoute = null, mostScenicElev = -Infinity;

    // Journey timestamps for gap/break calculation
    const journeyTimestamps = [];

    // Weather trackers
    const weatherTemps = [];       // { date, temp, feelsLike, name }
    const weatherConditions = {};  // condition -> count
    let hottestJourney = null, hottestTemp = -Infinity;
    let coldestJourney = null, coldestTemp = Infinity;
    let windiestJourney = null, windiestSpeed = 0;
    let humidestJourney = null, humidestVal = 0;
    let biggestFeelsLikeDiff = null, biggestFeelsLikeDiffVal = 0;
    let totalTemp = 0, tempCount = 0;
    let totalHumidity = 0, humidityCount = 0;
    let totalWindSpeed = 0, windCount = 0;
    const tempBuckets = {};        // "30-40" -> count
    const seasonTemps = { spring: [], summer: [], fall: [], winter: [] };
    let rainCount = 0, snowCount = 0, stormCount = 0;

    for (const route of routes) {
        const dist = Number(route.distance) || 0;
        const routeDate = getRouteTimelineDate(route);
        const routeDateStr = routeDate ? routeDate.toISOString().slice(0, 10) : null;
        const routeMonthStr = routeDate ? routeDateStr.slice(0, 7) : null;
        totalDistance += dist;

        if (route.top_speed != null && Number(route.top_speed) > maxSpeed) {
            maxSpeed = Number(route.top_speed);
        }

        if (dist > longestDistVal) { longestDistVal = dist; longestDistRoute = route; }
        if (dist < shortestDistVal) { shortestDistVal = dist; shortestDistRoute = route; }

        const avgSpd = Number(route.avg_speed) || 0;
        if (avgSpd > 0) avgSpeeds.push(avgSpd);
        if (avgSpd > fastestAvgVal) { fastestAvgVal = avgSpd; fastestAvgRoute = route; }

        // Elevation
        if (route.elevation_gain != null) { totalElevGain += Number(route.elevation_gain) || 0; hasElevation = true; }
        if (route.elevation_loss != null) { totalElevLoss += Number(route.elevation_loss) || 0; hasElevation = true; }
        if (route.top_elevation != null) {
            const elev = Number(route.top_elevation);
            if (elev > maxElevation) maxElevation = elev;
            if (elev > mostScenicElev) { mostScenicElev = elev; mostScenicRoute = route; }
            hasElevation = true;
        }

        // Weather data
        const wTemp = route.weather_temp != null ? Number(route.weather_temp) : null;
        const wFeelsLike = route.weather_feels_like != null ? Number(route.weather_feels_like) : null;
        const wHumidity = route.weather_humidity != null ? Number(route.weather_humidity) : null;
        const wWind = route.weather_wind_speed != null ? Number(route.weather_wind_speed) : null;
        const wCondition = route.weather_condition || null;

        if (wTemp != null && Number.isFinite(wTemp)) {
            const dateStr = route.start_time ? route.start_time.toISOString().slice(0, 10) : route.date;
            weatherTemps.push({ date: dateStr, temp: wTemp, feelsLike: wFeelsLike, name: route.name || dateStr });
            totalTemp += wTemp;
            tempCount++;

            if (wTemp > hottestTemp) { hottestTemp = wTemp; hottestJourney = { name: route.name, date: dateStr, temp: wTemp }; }
            if (wTemp < coldestTemp) { coldestTemp = wTemp; coldestJourney = { name: route.name, date: dateStr, temp: wTemp }; }

            // Feels-like difference
            if (wFeelsLike != null && Number.isFinite(wFeelsLike)) {
                const diff = Math.abs(wTemp - wFeelsLike);
                if (diff > biggestFeelsLikeDiffVal) {
                    biggestFeelsLikeDiffVal = diff;
                    biggestFeelsLikeDiff = { name: route.name, date: dateStr, temp: wTemp, feelsLike: wFeelsLike, diff };
                }
            }

            // Temperature bucket (10-degree ranges)
            const bucketBase = Math.floor(wTemp / 10) * 10;
            const bucketKey = `${bucketBase}`;
            tempBuckets[bucketKey] = (tempBuckets[bucketKey] || 0) + 1;

            // Season temps
            if (route.start_time) {
                const month = route.start_time.getUTCMonth();
                if (month >= 2 && month <= 4) seasonTemps.spring.push(wTemp);
                else if (month >= 5 && month <= 7) seasonTemps.summer.push(wTemp);
                else if (month >= 8 && month <= 10) seasonTemps.fall.push(wTemp);
                else seasonTemps.winter.push(wTemp);
            }
        }

        if (wHumidity != null && Number.isFinite(wHumidity)) {
            totalHumidity += wHumidity;
            humidityCount++;
            if (wHumidity > humidestVal) {
                humidestVal = wHumidity;
                humidestJourney = { name: route.name, date: route.start_time ? route.start_time.toISOString().slice(0, 10) : route.date, humidity: wHumidity };
            }
        }

        if (wWind != null && Number.isFinite(wWind)) {
            totalWindSpeed += wWind;
            windCount++;
            if (wWind > windiestSpeed) {
                windiestSpeed = wWind;
                windiestJourney = { name: route.name, date: route.start_time ? route.start_time.toISOString().slice(0, 10) : route.date, windSpeed: wWind };
            }
        }

        if (wCondition) {
            weatherConditions[wCondition] = (weatherConditions[wCondition] || 0) + 1;
            const lc = wCondition.toLowerCase();
            if (lc.includes('rain') || lc.includes('drizzle')) rainCount++;
            if (lc.includes('snow') || lc.includes('sleet') || lc.includes('ice')) snowCount++;
            if (lc.includes('thunder') || lc.includes('storm')) stormCount++;
        }

        // Travel mode
        const mode = route.travel_mode || 'drive';
        if (modeCounts.hasOwnProperty(mode)) { modeCounts[mode]++; modeDistances[mode] += dist; }
        if (previousMode != null) {
            modeSwitchTransitions++;
            if (mode !== previousMode) modeSwitchCount++;
        }
        previousMode = mode;

        // Round trip
        if (route.start_lat != null && route.start_lon != null &&
            route.end_lat != null && route.end_lon != null) {
            const roundDist = haversine(route.start_lat, route.start_lon, route.end_lat, route.end_lon);
            if (roundDist <= 0.3) {
                roundTripCount++;
                if (route.start_time) {
                    const rtDow = route.start_time.getUTCDay();
                    if (rtDow === 0 || rtDow === 6) weekendRoundTripCount++;
                    else weekdayRoundTripCount++;
                }
            }
        }

        // Compass direction
        if (route.start_lat != null && route.start_lon != null &&
            route.end_lat != null && route.end_lon != null) {
            const dLon = (route.end_lon - route.start_lon) * Math.PI / 180;
            const lat1r = route.start_lat * Math.PI / 180;
            const lat2r = route.end_lat * Math.PI / 180;
            const y = Math.sin(dLon) * Math.cos(lat2r);
            const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
            let bearing = Math.atan2(y, x) * 180 / Math.PI;
            bearing = (bearing + 360) % 360;
            directionCounts[Math.round(bearing / 45) % 8]++;
        }

        // Route pair tracking (for most repeated)
        let routePairKey = null;
        if (route.start_lat != null && route.start_lon != null &&
            route.end_lat != null && route.end_lon != null) {
            const startKey = `${route.start_lat.toFixed(2)},${route.start_lon.toFixed(2)}`;
            const endKey = `${route.end_lat.toFixed(2)},${route.end_lon.toFixed(2)}`;
            routePairKey = `${startKey}->${endKey}`;
            routePairs.add(routePairKey);
            routePairCounts[routePairKey] = (routePairCounts[routePairKey] || 0) + 1;
        }
        routePairKeys.push(routePairKey);

        // Duration-dependent stats
        let durationMs = 0;
        if (route.start_time && route.end_time) {
            durationMs = route.end_time.getTime() - route.start_time.getTime();
            totalTimeMs += durationMs;
            journeyTimestamps.push({ start: route.start_time.getTime(), end: route.end_time.getTime() });

            if (durationMs > longestTimeVal) { longestTimeVal = durationMs; longestTimeRoute = route; }
        }

        if (routeDateStr) {
            dayDistances[routeDateStr] = (dayDistances[routeDateStr] || 0) + dist;
            dayRouteCounts[routeDateStr] = (dayRouteCounts[routeDateStr] || 0) + 1;
        }
        if (routeMonthStr) {
            monthDistances[routeMonthStr] = (monthDistances[routeMonthStr] || 0) + dist;
        }
        if (routeDate) {
            if (!firstJourney) {
                firstJourney = route;
                firstJourneyDate = routeDate;
            }
            lastJourney = route;
        }

        if (route.start_time) {
            const dow = route.start_time.getUTCDay();
            dayOfWeekCounts[dow]++;
            const hour = route.start_time.getUTCHours();
            hourCounts[hour]++;
            const startHour = hour
                + (route.start_time.getUTCMinutes() / 60)
                + (route.start_time.getUTCSeconds() / 3600);
            startHourSamples.push(startHour);
            if (dow >= 1 && dow <= 5) weekdayStartHourSamples[dow].push(startHour);

            if (dow === 0 || dow === 6) {
                weekendCount++;
                weekendDistance += dist;
            } else {
                weekdayCount++;
                weekdayDistance += dist;
            }

            if (dow >= 1 && dow <= 5 && ((hour >= 6 && hour < 9) || (hour >= 16 && hour < 19))) {
                commuteWindowCount++;
            }

            if (hour >= 5 && hour < 12) morningCount++;
            else if (hour >= 12 && hour < 17) afternoonCount++;
            else if (hour >= 17 && hour < 21) eveningCount++;
            else nightCount++;

            const month = route.start_time.getUTCMonth();
            if (month >= 2 && month <= 4) { seasonCounts.spring++; seasonDistances.spring += dist; }
            else if (month >= 5 && month <= 7) { seasonCounts.summer++; seasonDistances.summer += dist; }
            else if (month >= 8 && month <= 10) { seasonCounts.fall++; seasonDistances.fall += dist; }
            else { seasonCounts.winter++; seasonDistances.winter += dist; }
        }

        if (route.start_lat != null && route.start_lon != null) {
            startCoords.push([route.start_lat, route.start_lon]);
        }

        // Coordinate-derived stats, precomputed per journey (0.01° cells, extremes)
        totalPoints += route.valid_points;
        const routeCoarseCells = new Set();
        let routeAddsNewTerritory = false;
        const coarseLat = route.coarse_lat || [];
        const coarseLon = route.coarse_lon || [];
        for (let c = 0; c < coarseLat.length; c++) {
            const coarseKey = `${coarseLat[c]},${coarseLon[c]}`;
            coarseCells.add(coarseKey);
            routeCoarseCells.add(coarseKey);
            if (!seenRouteCoarseCells.has(coarseKey)) routeAddsNewTerritory = true;

            // New territory tracking
            if (routeMonthStr === thisMonthStr) cellsThisMonth.add(coarseKey);
            else if (routeMonthStr === lastMonthStr) cellsLastMonth.add(coarseKey);
            if (routeMonthStr !== thisMonthStr) cellsBeforeThisMonth.add(coarseKey);
        }

        const ext = route.extremes;
        if (ext) {
            if (ext.n[0] > maxLat) { maxLat = ext.n[0]; northernmost = ext.n; }
            if (ext.s[0] < minLat) { minLat = ext.s[0]; southernmost = ext.s; }
            if (ext.e[1] > maxLon) { maxLon = ext.e[1]; easternmost = ext.e; }
            if (ext.w[1] < minLon) { minLon = ext.w[1]; westernmost = ext.w; }
        }

        for (const cell of routeCoarseCells) seenRouteCoarseCells.add(cell);
        if (routeAddsNewTerritory) newTerritoryJourneyCount++;
    }

    // ── DBSCAN clustering ──
    const EPSILON_MILES = 0.005 * 69;
    const MIN_POINTS = 3;
    let clusters = [];
    let homeCoord = null;

    if (startCoords.length > 0) {
        const labels = dbscan(startCoords, EPSILON_MILES, MIN_POINTS);
        const clusterMap = {};
        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            if (label < 0) continue;
            if (!clusterMap[label]) clusterMap[label] = { sumLat: 0, sumLon: 0, count: 0 };
            clusterMap[label].sumLat += startCoords[i][0];
            clusterMap[label].sumLon += startCoords[i][1];
            clusterMap[label].count++;
        }
        clusters = Object.values(clusterMap)
            .map(c => ({ lat: c.sumLat / c.count, lon: c.sumLon / c.count, visitCount: c.count }))
            .sort((a, b) => b.visitCount - a.visitCount);
        if (clusters.length > 0) homeCoord = [clusters[0].lat, clusters[0].lon];
        clusters = clusters.slice(0, 10);
    }

    if (!homeCoord && startCoords.length > 0) {
        const freq = {};
        for (const [lat, lon] of startCoords) {
            const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
            freq[key] = (freq[key] || 0) + 1;
        }
        let maxFreq = 0, maxKey = null;
        for (const [key, count] of Object.entries(freq)) {
            if (count > maxFreq) { maxFreq = count; maxKey = key; }
        }
        if (maxKey) homeCoord = maxKey.split(',').map(Number);
    }

    // ── Furthest point & coverage radius ──
    let furthestPointMiles = 0, furthestPointCoord = null, coverageRadiusMiles = 0;
    if (homeCoord && totalPoints > 0) {
        const furthest = await findFurthestPoint(db, homeCoord, routes);
        furthestPointMiles = furthest.miles;
        furthestPointCoord = furthest.coord;
        coverageRadiusMiles = furthest.miles;
    }

    // ── Derived stats ──
    const explorationScore = totalPoints > 0 ? Math.min(100, (fine.cells / totalPoints) * 100) : 0;
    const routeDiversity = routes.length > 0 ? (routePairs.size / routes.length) * 100 : 0;
    const avgSpeed = totalTimeMs > 0 ? totalDistance / (totalTimeMs / 3600000) : 0;
    const avgJourneyDistance = routes.length > 0 ? totalDistance / routes.length : 0;
    const timedRouteCount = weekdayCount + weekendCount;
    const startTimeConsistencyHours = startHourSamples.length > 1 ? stdDev(startHourSamples) : null;
    const commuteWindowPercent = timedRouteCount > 0 ? (commuteWindowCount / timedRouteCount) * 100 : 0;

    let repeatedRouteJourneyCount = 0;
    for (const pairKey of routePairKeys) {
        if (pairKey && routePairCounts[pairKey] > 1) repeatedRouteJourneyCount++;
    }
    const repeatedRouteRate = routes.length > 0 ? (repeatedRouteJourneyCount / routes.length) * 100 : 0;
    const newTerritoryJourneyRate = routes.length > 0 ? (newTerritoryJourneyCount / routes.length) * 100 : 0;
    const routineExplorerIndex = repeatedRouteRate - newTerritoryJourneyRate;

    // ── Most productive periods ──
    let mostProductiveDay = null, maxDayDist = 0;
    for (const [day, dist] of Object.entries(dayDistances)) {
        if (dist > maxDayDist) { maxDayDist = dist; mostProductiveDay = { date: day, distanceMiles: dist }; }
    }

    let mostProductiveWeek = null;
    const sortedDays = Object.keys(dayDistances).sort();
    if (sortedDays.length > 0) {
        let maxWeekDist = 0;
        for (let i = 0; i < sortedDays.length; i++) {
            let weekDist = 0;
            const startDate = new Date(sortedDays[i]);
            for (let j = i; j < sortedDays.length; j++) {
                if ((new Date(sortedDays[j]) - startDate) / 86400000 >= 7) break;
                weekDist += dayDistances[sortedDays[j]];
            }
            if (weekDist > maxWeekDist) {
                maxWeekDist = weekDist;
                const endDate = new Date(startDate); endDate.setDate(endDate.getDate() + 6);
                mostProductiveWeek = { startDate: sortedDays[i], endDate: endDate.toISOString().slice(0, 10), distanceMiles: weekDist };
            }
        }
    }

    let mostProductiveMonth = null, maxMonthDist = 0;
    for (const [month, dist] of Object.entries(monthDistances)) {
        if (dist > maxMonthDist) { maxMonthDist = dist; mostProductiveMonth = { month, distanceMiles: dist }; }
    }

    // ── Peak day / hour ──
    let peakDowIdx = 0;
    for (let i = 1; i < 7; i++) { if (dayOfWeekCounts[i] > dayOfWeekCounts[peakDowIdx]) peakDowIdx = i; }
    const peakDayOfWeek = dayOfWeekCounts[peakDowIdx] > 0 ? { day: dayNames[peakDowIdx], count: dayOfWeekCounts[peakDowIdx] } : null;

    let peakHourIdx = 0;
    for (let i = 1; i < 24; i++) { if (hourCounts[i] > hourCounts[peakHourIdx]) peakHourIdx = i; }
    const peakHour = hourCounts[peakHourIdx] > 0 ? { hour: peakHourIdx, count: hourCounts[peakHourIdx] } : null;

    // ── Streaks ──
    let longestStreak = 0, currentStreak = 0, longestStreakStart = null, longestStreakEnd = null;
    const sortedJourneyDays = Object.keys(dayRouteCounts).sort();
    if (sortedJourneyDays.length > 0) {
        let curStreakStart = sortedJourneyDays[0];
        currentStreak = 1;
        let prevDate = new Date(sortedJourneyDays[0] + 'T00:00:00Z');
        for (let i = 1; i < sortedJourneyDays.length; i++) {
            const currDate = new Date(sortedJourneyDays[i] + 'T00:00:00Z');
            if ((currDate - prevDate) / 86400000 === 1) {
                currentStreak++;
            } else {
                if (currentStreak > longestStreak) {
                    longestStreak = currentStreak;
                    longestStreakStart = curStreakStart;
                    longestStreakEnd = sortedJourneyDays[i - 1];
                }
                currentStreak = 1; curStreakStart = sortedJourneyDays[i];
            }
            prevDate = currDate;
        }
        if (currentStreak > longestStreak) {
            longestStreak = currentStreak;
            longestStreakStart = curStreakStart;
            longestStreakEnd = sortedJourneyDays[sortedJourneyDays.length - 1];
        }
        // Active streak from today
        const todayStr = new Date().toISOString().slice(0, 10);
        const yestDate = new Date(); yestDate.setDate(yestDate.getDate() - 1);
        const yesterdayStr = yestDate.toISOString().slice(0, 10);
        const lastDay = sortedJourneyDays[sortedJourneyDays.length - 1];
        if (lastDay === todayStr || lastDay === yesterdayStr) {
            currentStreak = 1;
            for (let i = sortedJourneyDays.length - 2; i >= 0; i--) {
                const d1 = new Date(sortedJourneyDays[i + 1] + 'T00:00:00Z');
                const d0 = new Date(sortedJourneyDays[i] + 'T00:00:00Z');
                if ((d1 - d0) / 86400000 === 1) currentStreak++; else break;
            }
        } else { currentStreak = 0; }
    }

    // ── Habit insights ──
    const MS_PER_DAY = 86400000;
    const dayGapValues = [];
    for (let i = 1; i < sortedJourneyDays.length; i++) {
        const currDayMs = Date.parse(sortedJourneyDays[i] + 'T00:00:00Z');
        const prevDayMs = Date.parse(sortedJourneyDays[i - 1] + 'T00:00:00Z');
        dayGapValues.push((currDayMs - prevDayMs) / MS_PER_DAY);
    }
    const medianGapDays = median(dayGapValues);

    const sortedDayCounts = Object.values(dayRouteCounts).sort((a, b) => b - a);
    const top10JourneyCount = sortedDayCounts.slice(0, 10).reduce((sum, count) => sum + count, 0);
    const burstinessPercent = routes.length > 0 ? (top10JourneyCount / routes.length) * 100 : 0;

    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const current30StartMs = todayUtcMs - (29 * MS_PER_DAY);
    const previous30StartMs = todayUtcMs - (59 * MS_PER_DAY);
    const previous30EndMs = todayUtcMs - (30 * MS_PER_DAY);
    let activeDaysCurrent30 = 0;
    let activeDaysPrevious30 = 0;
    for (const day of Object.keys(dayRouteCounts)) {
        const dayMs = Date.parse(day + 'T00:00:00Z');
        if (dayMs >= current30StartMs && dayMs <= todayUtcMs) activeDaysCurrent30++;
        else if (dayMs >= previous30StartMs && dayMs <= previous30EndMs) activeDaysPrevious30++;
    }

    let mostPredictableWeekday = null;
    for (let dow = 1; dow <= 5; dow++) {
        const samples = weekdayStartHourSamples[dow];
        if (samples.length < 2) continue;
        const spreadHours = stdDev(samples);
        const avgStartHour = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        if (!mostPredictableWeekday || spreadHours < mostPredictableWeekday.stdDevHours) {
            mostPredictableWeekday = {
                day: dayNames[dow],
                stdDevHours: spreadHours,
                avgStartHour,
                sampleCount: samples.length,
            };
        }
    }

    const modeSwitchRate = modeSwitchTransitions > 0 ? (modeSwitchCount / modeSwitchTransitions) * 100 : 0;
    const weekendDistancePercent = totalDistance > 0 ? (weekendDistance / totalDistance) * 100 : 0;
    const weekendTripPercentRaw = routes.length > 0 ? (weekendCount / routes.length) * 100 : 0;
    const weekendDistanceBiasPercent = weekendDistancePercent - weekendTripPercentRaw;
    const weekdayRoundTripPercent = weekdayCount > 0 ? (weekdayRoundTripCount / weekdayCount) * 100 : 0;
    const weekendRoundTripPercent = weekendCount > 0 ? (weekendRoundTripCount / weekendCount) * 100 : 0;

    let streakStarts3Plus = 0;
    const streakStartsByMonth = {};
    if (sortedJourneyDays.length > 0) {
        let streakStartDay = sortedJourneyDays[0];
        let streakLength = 1;
        for (let i = 1; i < sortedJourneyDays.length; i++) {
            const currDayMs = Date.parse(sortedJourneyDays[i] + 'T00:00:00Z');
            const prevDayMs = Date.parse(sortedJourneyDays[i - 1] + 'T00:00:00Z');
            if ((currDayMs - prevDayMs) / MS_PER_DAY === 1) {
                streakLength++;
            } else {
                if (streakLength >= 3) {
                    streakStarts3Plus++;
                    const monthKey = streakStartDay.slice(0, 7);
                    streakStartsByMonth[monthKey] = (streakStartsByMonth[monthKey] || 0) + 1;
                }
                streakStartDay = sortedJourneyDays[i];
                streakLength = 1;
            }
        }
        if (streakLength >= 3) {
            streakStarts3Plus++;
            const monthKey = streakStartDay.slice(0, 7);
            streakStartsByMonth[monthKey] = (streakStartsByMonth[monthKey] || 0) + 1;
        }
    }

    let bestStreakMonth = null;
    let bestStreakMonthCount = 0;
    for (const [month, count] of Object.entries(streakStartsByMonth)) {
        if (count > bestStreakMonthCount) {
            bestStreakMonth = month;
            bestStreakMonthCount = count;
        }
    }
    const monthsWithJourneys = Object.keys(monthDistances).length;
    const streakStartsPerMonth = monthsWithJourneys > 0 ? (streakStarts3Plus / monthsWithJourneys) : 0;

    const habitInsights = {
        startTimeConsistencyHours: startTimeConsistencyHours == null ? null : Number(startTimeConsistencyHours.toFixed(2)),
        commuteWindow: {
            count: commuteWindowCount,
            percent: Number(commuteWindowPercent.toFixed(1)),
        },
        routineExplorer: {
            repeatedRouteRate: Number(repeatedRouteRate.toFixed(1)),
            newTerritoryRate: Number(newTerritoryJourneyRate.toFixed(1)),
            index: Number(routineExplorerIndex.toFixed(1)),
        },
        activeDays30: {
            current: activeDaysCurrent30,
            previous: activeDaysPrevious30,
            delta: activeDaysCurrent30 - activeDaysPrevious30,
        },
        burstiness: {
            percent: Number(burstinessPercent.toFixed(1)),
            top10JourneyCount,
        },
        medianGapDays: medianGapDays == null ? null : Number(medianGapDays.toFixed(1)),
        modeSwitch: {
            percent: Number(modeSwitchRate.toFixed(1)),
            switches: modeSwitchCount,
            transitions: modeSwitchTransitions,
        },
        weekendDistanceBias: {
            distancePercent: Number(weekendDistancePercent.toFixed(1)),
            tripPercent: Number(weekendTripPercentRaw.toFixed(1)),
            biasPercent: Number(weekendDistanceBiasPercent.toFixed(1)),
        },
        mostPredictableWeekday: mostPredictableWeekday ? {
            day: mostPredictableWeekday.day,
            stdDevHours: Number(mostPredictableWeekday.stdDevHours.toFixed(2)),
            avgStartHour: Number(mostPredictableWeekday.avgStartHour.toFixed(2)),
            sampleCount: mostPredictableWeekday.sampleCount,
        } : null,
        roundTripSplit: {
            weekdayPercent: Number(weekdayRoundTripPercent.toFixed(1)),
            weekendPercent: Number(weekendRoundTripPercent.toFixed(1)),
            weekdayCount: weekdayRoundTripCount,
            weekendCount: weekendRoundTripCount,
        },
        streakReliability: {
            streakStarts3Plus,
            startsPerMonth: Number(streakStartsPerMonth.toFixed(2)),
            bestMonth: bestStreakMonth ? { month: bestStreakMonth, count: bestStreakMonthCount } : null,
        },
    };

    // ── Busiest day ──
    let busiestDay = null, busiestDayCount = 0;
    for (const [day, count] of Object.entries(dayRouteCounts)) {
        if (count > busiestDayCount) { busiestDayCount = count; busiestDay = day; }
    }

    // ── Journeys per week ──
    let journeysPerWeek = 0;
    if (firstJourney?.start_time && lastJourney?.start_time) {
        const spanWeeks = Math.max(1, (lastJourney.start_time.getTime() - firstJourney.start_time.getTime()) / (7 * 86400000));
        journeysPerWeek = routes.length / spanWeeks;
    }

    // ── Directions ──
    const directionLabels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let topDirIdx = 0;
    for (let i = 1; i < 8; i++) { if (directionCounts[i] > directionCounts[topDirIdx]) topDirIdx = i; }
    const favoriteDirection = directionCounts[topDirIdx] > 0
        ? { direction: directionLabels[topDirIdx], count: directionCounts[topDirIdx] }
        : null;

    // ── Time of day / season ──
    const todBuckets = [
        { name: 'Morning', count: morningCount },
        { name: 'Afternoon', count: afternoonCount },
        { name: 'Evening', count: eveningCount },
        { name: 'Night', count: nightCount },
    ].sort((a, b) => b.count - a.count);

    const seasonKeys = ['spring', 'summer', 'fall', 'winter'];
    let favSeason = 'spring';
    for (const s of seasonKeys) { if (seasonCounts[s] > seasonCounts[favSeason]) favSeason = s; }

    // ── Fun comparisons ──
    const EARTH_CIRC = 24901, MOON_DIST = 238900;
    const earthLaps = totalDistance / EARTH_CIRC;
    const moonPercent = (totalDistance / MOON_DIST) * 100;

    // ── Longest break ──
    let longestBreakMs = 0, longestBreakStart = null, longestBreakEnd = null;
    journeyTimestamps.sort((a, b) => a.start - b.start);
    for (let i = 1; i < journeyTimestamps.length; i++) {
        const gap = journeyTimestamps[i].start - journeyTimestamps[i - 1].end;
        if (gap > longestBreakMs) {
            longestBreakMs = gap;
            longestBreakStart = new Date(journeyTimestamps[i - 1].end).toISOString();
            longestBreakEnd = new Date(journeyTimestamps[i].start).toISOString();
        }
    }

    // ── Speed percentiles ──
    avgSpeeds.sort((a, b) => a - b);
    function percentile(arr, p) {
        if (arr.length === 0) return 0;
        const idx = (p / 100) * (arr.length - 1);
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
    }
    const speedPercentiles = {
        p25: Number(percentile(avgSpeeds, 25).toFixed(1)),
        p50: Number(percentile(avgSpeeds, 50).toFixed(1)),
        p75: Number(percentile(avgSpeeds, 75).toFixed(1)),
        p95: Number(percentile(avgSpeeds, 95).toFixed(1)),
    };

    // ── Fuel & CO2 estimates ──
    const driveMiles = modeDistances.drive;
    const scooterMiles = modeDistances.scooter;
    const footMiles = modeDistances.foot;
    const fuelGallons = driveMiles / 25; // ~25 mpg average
    const co2DriveKg = driveMiles * 0.404; // ~0.404 kg CO2 per mile
    const co2SavedKg = (scooterMiles + footMiles) * 0.404; // vs driving

    // ── State detection ── (point-in-polygon per journey, precomputed)
    const statesVisited = [...new Set(routes.flatMap((r) => r.states || []))].sort();

    // ── Cities passed through (aggregate) ──
    const allCities = new Set();
    for (const r of routes) {
        if (Array.isArray(r.cities_passed)) {
            r.cities_passed.forEach(c => allCities.add(c));
        }
    }

    // ── Unique places (aggregate) ──
    const allPlaces = new Set();
    for (const r of routes) {
        if (Array.isArray(r.places_passed)) {
            r.places_passed.forEach(p => allPlaces.add(p));
        }
    }

    // ── New territory this month ──
    let newCellsThisMonth = 0;
    for (const cell of cellsThisMonth) {
        if (!cellsBeforeThisMonth.has(cell)) newCellsThisMonth++;
    }

    // ── Monthly distance chart data ──
    const sortedMonths = firstJourneyDate
        ? buildMonthRange(firstJourneyDate, now)
        : Object.keys(monthDistances).sort();
    const monthlyChart = sortedMonths.map(m => ({
        month: m,
        distanceMiles: Number((monthDistances[m] || 0).toFixed(1)),
    }));

    // ── Year-over-year comparison ──
    let yoyComparison = null;
    if (sortedMonths.length > 0) {
        const currentYear = now.getFullYear();
        const lastYear = currentYear - 1;
        let thisYearDist = 0, lastYearDist = 0;
        for (const [m, dist] of Object.entries(monthDistances)) {
            const y = parseInt(m.slice(0, 4));
            if (y === currentYear) thisYearDist += dist;
            else if (y === lastYear) lastYearDist += dist;
        }
        if (lastYearDist > 0) {
            yoyComparison = {
                thisYear: Number(thisYearDist.toFixed(1)),
                lastYear: Number(lastYearDist.toFixed(1)),
                changePercent: Number((((thisYearDist - lastYearDist) / lastYearDist) * 100).toFixed(1)),
            };
        }
    }

    // ── Activity heatmap (GitHub-style: 52 weeks x 7 days) ──
    const heatmapData = {};
    for (const [day, count] of Object.entries(dayRouteCounts)) {
        heatmapData[day] = count;
    }

    // ── Most repeated route (superlative: "the commute") ──
    let mostRepeatedPair = null, mostRepeatedCount = 0;
    for (const [pair, count] of Object.entries(routePairCounts)) {
        if (count > mostRepeatedCount) { mostRepeatedCount = count; mostRepeatedPair = pair; }
    }

    // ── Level system ──
    const xp = Math.round(
        totalDistance * 10
        + coarseCells.size * 50
        + longestStreak * 20
        + routes.length * 5
    );
    let currentLevel = LEVELS[0], nextLevel = LEVELS[1];
    for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (xp >= LEVELS[i].xp) {
            currentLevel = LEVELS[i];
            nextLevel = LEVELS[i + 1] || null;
            break;
        }
    }

    // ── Spirit animal ──
    const totalTimed = morningCount + afternoonCount + eveningCount + nightCount;
    const spiritAnimalKey = classifySpiritAnimal({
        avgSpeedMph: avgSpeed,
        routeDiversityPct: routeDiversity,
        avgDistMi: avgJourneyDistance,
        nightPct: totalTimed > 0 ? (nightCount / totalTimed) * 100 : 0,
        weekendPct: routes.length > 0 ? (weekendCount / routes.length) * 100 : 0,
        roundTripPct: routes.length > 0 ? (roundTripCount / routes.length) * 100 : 0,
        elevGain: totalElevGain,
        totalRoutes: routes.length,
        streakDays: longestStreak,
        explorationPct: explorationScore,
    });
    const spiritAnimal = { key: spiritAnimalKey, ...SPIRIT_ANIMALS[spiritAnimalKey] };

    // ── Achievement progress (for locked ones) ──
    const achievementProgress = [
        { key: 'centurion', title: 'Centurion', target: 100, current: totalDistance, unit: 'miles', unlocked: totalDistance >= 100 },
        { key: 'roadwarrior', title: 'Road Warrior', target: 500, current: totalDistance, unit: 'miles', unlocked: totalDistance >= 500 },
        { key: 'explorer1k', title: 'Explorer 1K', target: 1000, current: totalDistance, unit: 'miles', unlocked: totalDistance >= 1000 },
        { key: 'explorer5k', title: 'Explorer 5K', target: 5000, current: totalDistance, unit: 'miles', unlocked: totalDistance >= 5000 },
        { key: 'tenner', title: 'Getting Started', target: 10, current: routes.length, unit: 'journeys', unlocked: routes.length >= 10 },
        { key: 'fifty', title: 'Half Century', target: 50, current: routes.length, unit: 'journeys', unlocked: routes.length >= 50 },
        { key: 'hundred', title: 'Century Club', target: 100, current: routes.length, unit: 'journeys', unlocked: routes.length >= 100 },
        { key: 'fivehundred', title: 'Dedicated Traveler', target: 500, current: routes.length, unit: 'journeys', unlocked: routes.length >= 500 },
        { key: 'longhaul', title: 'Long Haul', target: 50, current: longestDistVal, unit: 'miles', unlocked: longestDistVal >= 50 },
        { key: 'marathon', title: 'Marathon Drive', target: 100, current: longestDistVal, unit: 'miles', unlocked: longestDistVal >= 100 },
        { key: 'speedster', title: 'Speedster', target: 80, current: maxSpeed, unit: 'mph', unlocked: maxSpeed >= 80 },
        { key: 'farfromhome', title: 'Far From Home', target: 100, current: furthestPointMiles, unit: 'miles', unlocked: furthestPointMiles >= 100 },
        { key: 'wanderer', title: 'Wanderer', target: 500, current: furthestPointMiles, unit: 'miles', unlocked: furthestPointMiles >= 500 },
        { key: 'cartographer', title: 'Cartographer', target: 50, current: coarseCells.size, unit: 'locations', unlocked: coarseCells.size >= 50 },
        { key: 'worldmapper', title: 'World Mapper', target: 200, current: coarseCells.size, unit: 'locations', unlocked: coarseCells.size >= 200 },
        { key: 'weekstreak', title: 'Week Warrior', target: 7, current: longestStreak, unit: 'days', unlocked: longestStreak >= 7 },
        { key: 'monthstreak', title: 'Iron Will', target: 30, current: longestStreak, unit: 'days', unlocked: longestStreak >= 30 },
        { key: 'aroundworld', title: 'Around the World', target: EARTH_CIRC, current: totalDistance, unit: 'miles', unlocked: earthLaps >= 1 },
    ];

    // ── Monthly challenge ──
    const currentMonthDist = monthDistances[thisMonthStr] || 0;
    const prevMonthDist = monthDistances[lastMonthStr] || 0;
    const monthlyChallenge = prevMonthDist > 0 ? {
        targetMiles: Number(prevMonthDist.toFixed(1)),
        currentMiles: Number(currentMonthDist.toFixed(1)),
        percent: Number(Math.min(100, (currentMonthDist / prevMonthDist) * 100).toFixed(1)),
        beatLastMonth: currentMonthDist >= prevMonthDist,
    } : null;

    // ── Bingo card (deterministic via first journey date seed) ──
    const seed = firstJourney?.start_time ? firstJourney.start_time.getTime() : 42;
    function seededShuffle(arr, s) {
        const a = [...arr];
        let rng = s;
        for (let i = a.length - 1; i > 0; i--) {
            rng = (rng * 1664525 + 1013904223) & 0x7fffffff;
            const j = rng % (i + 1);
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // Check which bingo challenges are completed
    const bingoCompleted = new Set();
    if (nightCount > 0) bingoCompleted.add('night_journey');
    for (const route of routes) {
        if (route.start_time) {
            const h = route.start_time.getUTCHours();
            if (h < 6) bingoCompleted.add('early_bird');
            if (h === 12) bingoCompleted.add('noon_start');
            if (route.start_time.getUTCDay() === 5) bingoCompleted.add('friday_journey');
        }
    }
    if (longestDistVal >= 50) bingoCompleted.add('long_50');
    if (longestDistVal >= 100) bingoCompleted.add('long_100');
    if (maxSpeed >= 70) bingoCompleted.add('speed_70');
    if (maxSpeed >= 90) bingoCompleted.add('speed_90');
    if (longestStreak >= 3) bingoCompleted.add('streak_3');
    if (longestStreak >= 7) bingoCompleted.add('streak_7');
    if (roundTripCount > 0) bingoCompleted.add('round_trip');
    if (busiestDayCount >= 5) bingoCompleted.add('five_in_day');
    if (weekendCount > 0) bingoCompleted.add('weekend_warrior');
    if (shortestDistVal < 1) bingoCompleted.add('micro_trip');
    if (longestTimeVal >= 3600000) bingoCompleted.add('hour_plus');
    if (longestTimeVal >= 10800000) bingoCompleted.add('three_hour');
    if (coarseCells.size >= 10) bingoCompleted.add('ten_locations');
    if (routes.length >= 50) bingoCompleted.add('fifty_journeys');
    if (totalDistance >= 100) bingoCompleted.add('hundred_miles');
    if (totalDistance >= 500) bingoCompleted.add('five_hundred_miles');
    if (modeCounts.foot > 0) bingoCompleted.add('walk_journey');
    if (modeCounts.scooter > 0) bingoCompleted.add('scooter_journey');
    if (furthestPointMiles >= 10) bingoCompleted.add('far_from_home_10');
    if (furthestPointMiles >= 50) bingoCompleted.add('far_from_home_50');
    if (routePairs.size >= 20) bingoCompleted.add('diversity_20');

    const shuffled = seededShuffle(BINGO_CHALLENGES, seed);
    const bingoCard = shuffled.slice(0, 25).map(ch => ({
        ...ch,
        completed: bingoCompleted.has(ch.id),
    }));

    // ── Superlatives ──
    const superlatives = [];
    if (mostRepeatedPair && mostRepeatedCount > 1) {
        const [startPart] = mostRepeatedPair.split('->');
        superlatives.push({
            title: 'The Commute',
            desc: `Most repeated route (${mostRepeatedCount}x)`,
            detail: startPart,
        });
    }
    if (mostScenicRoute && mostScenicElev > -Infinity) {
        superlatives.push({
            title: 'Most Scenic',
            desc: 'Highest peak elevation',
            detail: mostScenicRoute.name || mostScenicRoute.date,
            value: mostScenicElev,
        });
    }
    // Most zigzaggy: highest ratio of coordinate count to distance
    let mostZigzagRoute = null, mostZigzagRatio = 0;
    for (const route of routes) {
        const pointCount = route.point_count || 0;
        const dist = Number(route.distance) || 0;
        if (dist > 0.5 && pointCount > 10) {
            const ratio = pointCount / dist;
            if (ratio > mostZigzagRatio) { mostZigzagRatio = ratio; mostZigzagRoute = route; }
        }
    }
    if (mostZigzagRoute) {
        superlatives.push({
            title: 'The Wander',
            desc: 'Most winding route (points per mile)',
            detail: mostZigzagRoute.name || mostZigzagRoute.date,
        });
    }

    // ── Build unlocked achievements ──
    const achievements = achievementProgress.filter(a => a.unlocked).map(a => ({
        key: a.key, title: a.title, desc: `${a.target}+ ${a.unit}`,
    }));
    // Add non-progress-tracked achievements
    if (roundTripCount >= 10) achievements.push({ key: 'boomerang', title: 'Boomerang', desc: '10+ round trips' });
    if (nightCount >= 20) achievements.push({ key: 'nightowl', title: 'Night Owl', desc: '20+ night journeys' });
    if (weekendCount >= 50) achievements.push({ key: 'weekender', title: 'Weekend Warrior', desc: '50+ weekend journeys' });
    if (totalElevGain >= 50000) achievements.push({ key: 'mountaineer', title: 'Mountaineer', desc: '50,000+ ft elevation gain' });
    if (modeCounts.foot >= 50) achievements.push({ key: 'walker', title: 'Walker', desc: '50+ journeys on foot' });

    const formatRoute = (r) => r ? {
        id: r.id, name: r.name, date: r.date,
        distanceMiles: Number(r.distance) || 0,
        durationMs: (r.start_time && r.end_time) ? r.end_time.getTime() - r.start_time.getTime() : 0,
    } : null;

    return {
        empty: false,
        totalRoutes: routes.length,
        totalDistance: Number(totalDistance.toFixed(1)),
        totalTimeMs,
        avgSpeed: Number(avgSpeed.toFixed(1)),
        explorationScore: Number(explorationScore.toFixed(1)),
        uniqueLocations: coarseCells.size,
        coverageRadiusMiles: Number(coverageRadiusMiles.toFixed(1)),
        furthestPointMiles: Number(furthestPointMiles.toFixed(1)),
        furthestPointCoord,
        routeDiversity: Number(routeDiversity.toFixed(1)),
        longestByDistance: formatRoute(longestDistRoute),
        longestByTime: formatRoute(longestTimeRoute),
        shortestByDistance: formatRoute(shortestDistRoute),
        fastestByAvgSpeed: fastestAvgRoute ? { ...formatRoute(fastestAvgRoute), avgSpeedMph: fastestAvgVal } : null,
        topSpeed: Number(maxSpeed.toFixed(1)),
        mostProductiveDay, mostProductiveWeek, mostProductiveMonth,
        peakDayOfWeek, peakHour,
        clusters, homeCoord, achievements,
        longestStreak, longestStreakStart, longestStreakEnd, currentStreak,
        busiestDay: busiestDay ? { date: busiestDay, count: busiestDayCount } : null,
        avgJourneyDistanceMiles: Number(avgJourneyDistance.toFixed(2)),
        journeysPerWeek: Number(journeysPerWeek.toFixed(1)),
        roundTripCount,
        roundTripPercent: routes.length > 0 ? Number(((roundTripCount / routes.length) * 100).toFixed(1)) : 0,
        weekdayCount, weekendCount,
        weekendPercent: routes.length > 0 ? Number(((weekendCount / routes.length) * 100).toFixed(1)) : 0,
        habitInsights,
        timeOfDay: todBuckets,
        favoriteDirection,
        favoriteSeason: { season: favSeason, count: seasonCounts[favSeason], distanceMiles: Number(seasonDistances[favSeason].toFixed(1)) },
        seasonCounts,
        seasonDistances: { spring: Number(seasonDistances.spring.toFixed(1)), summer: Number(seasonDistances.summer.toFixed(1)), fall: Number(seasonDistances.fall.toFixed(1)), winter: Number(seasonDistances.winter.toFixed(1)) },
        modeCounts,
        modeDistances: { drive: Number(modeDistances.drive.toFixed(1)), scooter: Number(modeDistances.scooter.toFixed(1)), foot: Number(modeDistances.foot.toFixed(1)), train: Number(modeDistances.train.toFixed(1)), metro: Number(modeDistances.metro.toFixed(1)) },
        elevation: hasElevation ? {
            totalGainFt: Number(totalElevGain.toFixed(0)),
            totalLossFt: Number(totalElevLoss.toFixed(0)),
            peakElevationFt: maxElevation > -Infinity ? Number(maxElevation.toFixed(0)) : null,
        } : null,
        funComparisons: { earthLaps: Number(earthLaps.toFixed(2)), moonPercent: Number(moonPercent.toFixed(2)) },
        firstJourney: firstJourney ? { date: firstJourney.date, name: firstJourney.name, startTime: firstJourney.start_time?.toISOString() || null } : null,
        lastJourney: lastJourney ? { date: lastJourney.date, name: lastJourney.name, startTime: lastJourney.start_time?.toISOString() || null } : null,
        totalDataPoints: totalPoints,
        // New stats
        statesVisited,
        citiesPassed: [...allCities].sort(),
        uniquePlaces: [...allPlaces].sort(),
        extremePoints: {
            north: northernmost, south: southernmost,
            east: easternmost, west: westernmost,
        },
        newTerritory: {
            newCellsThisMonth,
            totalCellsThisMonth: cellsThisMonth.size,
            totalCellsLastMonth: cellsLastMonth.size,
        },
        monthlyChart,
        yoyComparison,
        longestBreak: longestBreakMs > 0 ? {
            durationMs: longestBreakMs,
            start: longestBreakStart,
            end: longestBreakEnd,
        } : null,
        activityHeatmap: heatmapData,
        speedPercentiles,
        fuelEstimate: {
            gallons: Number(fuelGallons.toFixed(1)),
            co2Kg: Number(co2DriveKg.toFixed(0)),
            co2SavedKg: Number(co2SavedKg.toFixed(0)),
        },
        level: {
            xp,
            name: currentLevel.name,
            currentLevelXp: currentLevel.xp,
            nextLevelName: nextLevel?.name || null,
            nextLevelXp: nextLevel?.xp || null,
        },
        spiritAnimal,
        achievementProgress,
        monthlyChallenge,
        bingoCard,
        superlatives,
        // Weather stats
        weather: tempCount > 0 ? {
            tempTimeline: weatherTemps,
            avgTemp: Number((totalTemp / tempCount).toFixed(1)),
            hottestJourney,
            coldestJourney,
            tempRange: { min: Number(coldestTemp.toFixed(1)), max: Number(hottestTemp.toFixed(1)) },
            tempBuckets: Object.entries(tempBuckets)
                .map(([base, count]) => ({ rangeStart: Number(base), count }))
                .sort((a, b) => a.rangeStart - b.rangeStart),
            journeysWithWeather: tempCount,
            conditions: Object.entries(weatherConditions)
                .map(([condition, count]) => ({ condition, count }))
                .sort((a, b) => b.count - a.count),
            avgHumidity: humidityCount > 0 ? Number((totalHumidity / humidityCount).toFixed(0)) : null,
            avgWindSpeed: windCount > 0 ? Number((totalWindSpeed / windCount).toFixed(1)) : null,
            windiestJourney,
            humidestJourney,
            biggestFeelsLikeDiff,
            rainCount,
            snowCount,
            stormCount,
            seasonAvgTemps: {
                spring: seasonTemps.spring.length > 0 ? Number((seasonTemps.spring.reduce((a, b) => a + b, 0) / seasonTemps.spring.length).toFixed(1)) : null,
                summer: seasonTemps.summer.length > 0 ? Number((seasonTemps.summer.reduce((a, b) => a + b, 0) / seasonTemps.summer.length).toFixed(1)) : null,
                fall: seasonTemps.fall.length > 0 ? Number((seasonTemps.fall.reduce((a, b) => a + b, 0) / seasonTemps.fall.length).toFixed(1)) : null,
                winter: seasonTemps.winter.length > 0 ? Number((seasonTemps.winter.reduce((a, b) => a + b, 0) / seasonTemps.winter.length).toFixed(1)) : null,
            },
        } : null,
    };
}

module.exports = router;
module.exports.dbscan = dbscan;
module.exports.maxDistanceToBox = maxDistanceToBox;
