const express = require('express');
const router = express.Router();
const { queryTenant } = require('../db');
const { haversine } = require('../utils/geo');
const { MIN_ROUTE_MILES } = require('../config');

// DBSCAN clustering on [lat, lon] pairs using haversine distance
function dbscan(points, epsilonMiles, minPoints) {
    const n = points.length;
    const labels = new Int32Array(n).fill(-1);
    let clusterId = 0;

    function regionQuery(idx) {
        const neighbors = [];
        const [lat1, lon1] = points[idx];
        for (let i = 0; i < n; i++) {
            if (haversine(lat1, lon1, points[i][0], points[i][1]) <= epsilonMiles) {
                neighbors.push(i);
            }
        }
        return neighbors;
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

// US state bounding boxes [south, west, north, east]
const US_STATES = {
    AL:[30.22,-88.47,35.01,-84.89],AK:[51.21,-179.15,71.39,-129.98],AZ:[31.33,-114.81,37.00,-109.04],
    AR:[33.00,-94.62,36.50,-89.64],CA:[32.53,-124.48,42.01,-114.13],CO:[36.99,-109.06,41.00,-102.04],
    CT:[40.95,-73.73,42.05,-71.79],DE:[38.45,-75.79,39.84,-75.05],FL:[24.40,-87.63,31.00,-80.03],
    GA:[30.36,-85.61,35.00,-80.84],HI:[18.91,-160.25,22.24,-154.81],ID:[42.00,-117.24,49.00,-111.04],
    IL:[36.97,-91.51,42.51,-87.02],IN:[37.77,-88.10,41.76,-84.78],IA:[40.38,-96.64,43.50,-90.14],
    KS:[36.99,-102.05,40.00,-94.59],KY:[36.50,-89.57,39.15,-81.96],LA:[28.93,-94.04,33.02,-88.82],
    ME:[42.98,-71.08,47.46,-66.95],MD:[37.91,-79.49,39.72,-75.05],MA:[41.24,-73.50,42.89,-69.93],
    MI:[41.70,-90.42,48.26,-82.12],MN:[43.50,-97.24,49.38,-89.49],MS:[30.17,-91.66,34.99,-88.10],
    MO:[35.99,-95.77,40.61,-89.10],MT:[44.36,-116.05,49.00,-104.04],NE:[40.00,-104.05,43.00,-95.31],
    NV:[35.00,-120.01,42.00,-114.04],NH:[42.70,-72.56,45.31,-70.70],NJ:[38.93,-75.56,41.36,-73.89],
    NM:[31.33,-109.05,37.00,-103.00],NY:[40.50,-79.76,45.02,-71.86],NC:[33.84,-84.32,36.59,-75.46],
    ND:[45.94,-104.05,49.00,-96.55],OH:[38.40,-84.82,41.98,-80.52],OK:[33.62,-103.00,37.00,-94.43],
    OR:[41.99,-124.57,46.29,-116.46],PA:[39.72,-80.52,42.27,-74.69],RI:[41.15,-71.86,42.02,-71.12],
    SC:[32.03,-83.35,35.22,-78.54],SD:[42.48,-104.06,45.95,-96.44],TN:[34.98,-90.31,36.68,-81.65],
    TX:[25.84,-106.65,36.50,-93.51],UT:[36.99,-114.05,42.00,-109.04],VT:[42.73,-73.44,45.02,-71.46],
    VA:[36.54,-83.68,39.47,-75.24],WA:[45.54,-124.85,49.00,-116.92],WV:[37.20,-82.64,40.64,-77.72],
    WI:[42.49,-92.89,47.08,-86.25],WY:[40.99,-111.06,45.01,-104.05],DC:[38.79,-77.12,38.99,-76.91],
};

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

// GET /api/fun-stats
router.get('/fun-stats', async (req, res) => {
    try {
        const { rows: routes } = await queryTenant(req.userId, `
            SELECT id, name, date, distance, duration, top_speed, avg_speed,
                   start_time, end_time, coordinates, start_lat, start_lon,
                   end_lat, end_lon, travel_mode, elevation_gain, elevation_loss,
                   top_elevation
            FROM routes
            WHERE distance >= $1
            ORDER BY start_time ASC
        `, [MIN_ROUTE_MILES]);

        if (routes.length === 0) {
            return res.json({ empty: true });
        }

        // ── Aggregate trackers ──
        let totalDistance = 0, totalTimeMs = 0, maxSpeed = 0;
        let longestDistRoute = null, longestTimeRoute = null;
        let longestDistVal = 0, longestTimeVal = 0;
        let shortestDistRoute = null, shortestDistVal = Infinity;
        let fastestAvgRoute = null, fastestAvgVal = 0;
        let totalElevGain = 0, totalElevLoss = 0, maxElevation = -Infinity, hasElevation = false;

        const fineCells = new Set();
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
        const modeCounts = { drive: 0, scooter: 0, foot: 0 };
        const modeDistances = { drive: 0, scooter: 0, foot: 0 };
        let modeSwitchCount = 0, modeSwitchTransitions = 0;
        let previousMode = null;
        const directionCounts = new Array(8).fill(0);
        const seasonCounts = { spring: 0, summer: 0, fall: 0, winter: 0 };
        const seasonDistances = { spring: 0, summer: 0, fall: 0, winter: 0 };
        let firstJourney = null, lastJourney = null;
        const allCoords = [];
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
        const now = new Date();
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

        for (const route of routes) {
            const dist = Number(route.distance) || 0;
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

                const dateStr = route.start_time.toISOString().slice(0, 10);
                dayDistances[dateStr] = (dayDistances[dateStr] || 0) + dist;
                dayRouteCounts[dateStr] = (dayRouteCounts[dateStr] || 0) + 1;
                const monthStr = dateStr.slice(0, 7);
                monthDistances[monthStr] = (monthDistances[monthStr] || 0) + dist;

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

                if (!firstJourney) firstJourney = route;
                lastJourney = route;
            }

            if (route.start_lat != null && route.start_lon != null) {
                startCoords.push([route.start_lat, route.start_lon]);
            }

            // Process coordinates
            const coords = route.coordinates || [];
            const routeMonthStr = route.start_time ? route.start_time.toISOString().slice(0, 7) : null;
            const routeCoarseCells = new Set();
            let routeAddsNewTerritory = false;

            for (const coord of coords) {
                if (!Array.isArray(coord) || coord.length < 2) continue;
                const [lat, lon] = coord;
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

                allCoords.push([lat, lon]);

                const fineKey = `${Math.round(lat / 0.001)},${Math.round(lon / 0.001)}`;
                fineCells.add(fineKey);
                const coarseKey = `${Math.round(lat / 0.01)},${Math.round(lon / 0.01)}`;
                coarseCells.add(coarseKey);
                routeCoarseCells.add(coarseKey);
                if (!seenRouteCoarseCells.has(coarseKey)) routeAddsNewTerritory = true;

                // New territory tracking
                if (routeMonthStr === thisMonthStr) cellsThisMonth.add(coarseKey);
                else if (routeMonthStr === lastMonthStr) cellsLastMonth.add(coarseKey);
                if (routeMonthStr !== thisMonthStr) cellsBeforeThisMonth.add(coarseKey);

                // Extreme points
                if (lat > maxLat) { maxLat = lat; northernmost = [lat, lon]; }
                if (lat < minLat) { minLat = lat; southernmost = [lat, lon]; }
                if (lon > maxLon) { maxLon = lon; easternmost = [lat, lon]; }
                if (lon < minLon) { minLon = lon; westernmost = [lat, lon]; }
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
        if (homeCoord && allCoords.length > 0) {
            for (const [lat, lon] of allCoords) {
                const d = haversine(homeCoord[0], homeCoord[1], lat, lon);
                if (d > furthestPointMiles) { furthestPointMiles = d; furthestPointCoord = [lat, lon]; }
                if (d > coverageRadiusMiles) coverageRadiusMiles = d;
            }
        }

        // ── Derived stats ──
        const totalPoints = allCoords.length;
        const explorationScore = totalPoints > 0 ? Math.min(100, (fineCells.size / totalPoints) * 100) : 0;
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

        // ── State detection ──
        const statesVisited = new Set();
        // Sample every 10th coordinate for performance
        for (let i = 0; i < allCoords.length; i += 10) {
            const [lat, lon] = allCoords[i];
            for (const [state, [s, w, n, e]] of Object.entries(US_STATES)) {
                if (lat >= s && lat <= n && lon >= w && lon <= e) {
                    statesVisited.add(state);
                }
            }
        }

        // ── New territory this month ──
        let newCellsThisMonth = 0;
        for (const cell of cellsThisMonth) {
            if (!cellsBeforeThisMonth.has(cell)) newCellsThisMonth++;
        }

        // ── Monthly distance chart data ──
        const sortedMonths = Object.keys(monthDistances).sort();
        const monthlyChart = sortedMonths.map(m => ({
            month: m,
            distanceMiles: Number(monthDistances[m].toFixed(1)),
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
            const coords = route.coordinates || [];
            const dist = Number(route.distance) || 0;
            if (dist > 0.5 && coords.length > 10) {
                const ratio = coords.length / dist;
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

        res.json({
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
            modeDistances: { drive: Number(modeDistances.drive.toFixed(1)), scooter: Number(modeDistances.scooter.toFixed(1)), foot: Number(modeDistances.foot.toFixed(1)) },
            elevation: hasElevation ? {
                totalGainFt: Number(totalElevGain.toFixed(0)),
                totalLossFt: Number(totalElevLoss.toFixed(0)),
                peakElevationFt: maxElevation > -Infinity ? Number(maxElevation.toFixed(0)) : null,
            } : null,
            funComparisons: { earthLaps: Number(earthLaps.toFixed(2)), moonPercent: Number(moonPercent.toFixed(2)) },
            firstJourney: firstJourney ? { date: firstJourney.date, name: firstJourney.name, startTime: firstJourney.start_time?.toISOString() || null } : null,
            lastJourney: lastJourney ? { date: lastJourney.date, name: lastJourney.name, startTime: lastJourney.start_time?.toISOString() || null } : null,
            totalDataPoints: allCoords.length,
            // New stats
            statesVisited: [...statesVisited].sort(),
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
        });
    } catch (err) {
        console.error('GET /api/fun-stats error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
