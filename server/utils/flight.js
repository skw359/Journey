/**
 * Flight service — FlightAware AeroAPI client with great-circle synthesis fallback.
 * Reads flightaware_api_key from app_config table (same pattern as weather.js).
 */

const path = require('path');
const { haversine } = require('./geo');
const { formatDuration } = require('./format');
const log = require('../utils/logger').scope('flight');

// ── Config cache (mirrors weather.js pattern) ────────────────────────

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_MS = 30_000;

async function getFlightConfig() {
    if (_configCache && Date.now() - _configCacheTime < CONFIG_CACHE_MS) {
        return _configCache;
    }
    const { pool } = require('../db');
    const { rows } = await pool.query(
        "SELECT key, value FROM app_config WHERE key IN ('flightaware_api_key')"
    );
    const config = { apiKey: '' };
    for (const row of rows) {
        if (row.key === 'flightaware_api_key') config.apiKey = row.value || '';
    }
    _configCache = config;
    _configCacheTime = Date.now();
    return config;
}

function clearConfigCache() {
    _configCache = null;
    _configCacheTime = 0;
}

// ── Airport data ─────────────────────────────────────────────────────

let _airports = null;

function getAirports() {
    if (!_airports) {
        _airports = require('../data/airports.json');
    }
    return _airports;
}

function lookupAirport(iata) {
    const airports = getAirports();
    return airports[iata.toUpperCase()] || null;
}

// ── Great-circle synthesis ───────────────────────────────────────────

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

/**
 * Compute an intermediate point along the great-circle path from (lat1,lon1)
 * to (lat2,lon2). `f` ranges from 0 (start) to 1 (end).
 */
function intermediatePoint(lat1, lon1, lat2, lon2, f) {
    const phi1 = toRad(lat1), lam1 = toRad(lon1);
    const phi2 = toRad(lat2), lam2 = toRad(lon2);
    const d = 2 * Math.asin(Math.sqrt(
        Math.sin((phi2 - phi1) / 2) ** 2 +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2
    ));
    if (d < 1e-10) return [lat1, lon1];
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(phi1) * Math.cos(lam1) + b * Math.cos(phi2) * Math.cos(lam2);
    const y = a * Math.cos(phi1) * Math.sin(lam1) + b * Math.cos(phi2) * Math.sin(lam2);
    const z = a * Math.sin(phi1) + b * Math.sin(phi2);
    return [toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))];
}

/**
 * Generate a realistic altitude profile for a flight.
 * Returns altitude in meters for a given fraction f (0-1) of the flight.
 */
function flightAltitudeM(f) {
    const cruiseM = 10668; // 35,000 ft
    const climbEnd = 0.12;
    const descentStart = 0.85;
    if (f <= climbEnd) {
        // Climb phase — smooth ramp up
        const t = f / climbEnd;
        return cruiseM * (1 - Math.cos(t * Math.PI / 2));
    }
    if (f >= descentStart) {
        // Descent phase — smooth ramp down
        const t = (f - descentStart) / (1 - descentStart);
        return cruiseM * Math.cos(t * Math.PI / 2);
    }
    return cruiseM;
}

/**
 * Generate a synthetic flight track using great-circle interpolation.
 */
function synthesizeTrack(depAirport, arrAirport, departureTime, arrivalTime) {
    const numPoints = 100;
    const depTime = new Date(departureTime).getTime();
    const arrTime = new Date(arrivalTime).getTime();
    const durationMs = arrTime - depTime;

    const coords = [];
    const profileTimeMs = [];
    const profileDistMi = [];
    const profileElevM = [];
    const profileSpeedMph = [];

    let totalMiles = 0;
    let lastLat = null, lastLon = null;

    for (let i = 0; i <= numPoints; i++) {
        const f = i / numPoints;
        const [lat, lon] = intermediatePoint(
            depAirport.lat, depAirport.lon,
            arrAirport.lat, arrAirport.lon, f
        );
        const ts = depTime + f * durationMs;
        const altM = flightAltitudeM(f);

        if (lastLat !== null) {
            totalMiles += haversine(lastLat, lastLon, lat, lon);
        }

        // Estimate speed based on altitude profile (slower during climb/descent)
        const cruiseSpeedMph = 550;
        let speedMph;
        if (f <= 0.12) speedMph = 200 + (cruiseSpeedMph - 200) * (f / 0.12);
        else if (f >= 0.85) speedMph = cruiseSpeedMph - (cruiseSpeedMph - 180) * ((f - 0.85) / 0.15);
        else speedMph = cruiseSpeedMph;

        coords.push([parseFloat(lat.toFixed(5)), parseFloat(lon.toFixed(5))]);
        profileTimeMs.push(Math.round(ts));
        profileDistMi.push(parseFloat(totalMiles.toFixed(2)));
        profileElevM.push(parseFloat(altM.toFixed(1)));
        profileSpeedMph.push(parseFloat(speedMph.toFixed(1)));

        lastLat = lat;
        lastLon = lon;
    }

    const speeds = profileSpeedMph.filter(s => s > 0);
    const elevations = profileElevM.filter(e => e > 0);

    return {
        coordinates: coords,
        profileTimeMs,
        profileDistMi,
        profileElevM,
        profileSpeedMph,
        distance: parseFloat(totalMiles.toFixed(2)),
        duration: formatDuration(durationMs / 1000),
        durationSec: durationMs / 1000,
        topSpeed: speeds.length ? parseFloat(Math.max(...speeds).toFixed(2)) : 0,
        avgSpeed: speeds.length ? parseFloat((speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(2)) : 0,
        topElevation: elevations.length ? parseFloat(Math.max(...elevations).toFixed(2)) : 0,
        lowestElevation: 0,
        avgElevation: elevations.length ? parseFloat((elevations.reduce((a, b) => a + b, 0) / elevations.length).toFixed(2)) : 0,
        elevationGain: parseFloat((10668).toFixed(2)), // climb to cruise
        elevationLoss: parseFloat((10668).toFixed(2)), // descend from cruise
        source: 'great_circle',
    };
}

// ── FlightAware AeroAPI ──────────────────────────────────────────────

const AEROAPI_BASE = 'https://aeroapi.flightaware.com/aeroapi';

async function flightAwareFetch(endpoint, apiKey) {
    const res = await fetch(`${AEROAPI_BASE}${endpoint}`, {
        headers: { 'x-apikey': apiKey },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`FlightAware API ${res.status}: ${text}`);
    }
    return res.json();
}

/**
 * Convert FlightAware flight object to our normalized format.
 */
function normalizeFlightAwareFlight(fa) {
    const airports = getAirports();
    const depCode = fa.origin?.code_iata || fa.origin?.code || '';
    const arrCode = fa.destination?.code_iata || fa.destination?.code || '';
    const depInfo = airports[depCode] || { name: depCode, city: '' };
    const arrInfo = airports[arrCode] || { name: arrCode, city: '' };

    const depTime = fa.scheduled_out || fa.actual_out || fa.estimated_out || '';
    const arrTime = fa.scheduled_in || fa.actual_in || fa.estimated_in || '';

    let durationStr = '';
    if (depTime && arrTime) {
        const sec = (new Date(arrTime).getTime() - new Date(depTime).getTime()) / 1000;
        if (sec > 0) durationStr = formatDuration(sec);
    }

    return {
        flightId: fa.fa_flight_id || '',
        flightNumber: fa.ident_iata || fa.ident || '',
        airline: fa.operator_iata || fa.operator || '',
        departure: {
            airport: depCode,
            airportName: depInfo.name,
            city: depInfo.city,
            time: depTime,
        },
        arrival: {
            airport: arrCode,
            airportName: arrInfo.name,
            city: arrInfo.city,
            time: arrTime,
        },
        duration: durationStr,
        source: 'flightaware',
    };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Search for flights matching the given criteria.
 * Returns an array of normalized flight objects.
 */
async function searchFlights(departure, arrival, date, departureTime, flightNumber) {
    const config = await getFlightConfig();
    const airports = getAirports();

    const depAirport = airports[departure.toUpperCase()];
    const arrAirport = airports[arrival.toUpperCase()];
    if (!depAirport || !arrAirport) {
        throw new Error(`Unknown airport code: ${!depAirport ? departure : arrival}`);
    }

    // If we have an API key, try FlightAware
    if (config.apiKey) {
        try {
            let flights = [];

            if (flightNumber) {
                // Search by flight number
                const ident = flightNumber.replace(/\s+/g, '').toUpperCase();
                const data = await flightAwareFetch(`/flights/${ident}?start=${date}T00:00:00Z&end=${date}T23:59:59Z`, config.apiKey);
                flights = (data.flights || [])
                    .filter(f => {
                        const depCode = f.origin?.code_iata || f.origin?.code || '';
                        const arrCode = f.destination?.code_iata || f.destination?.code || '';
                        // Filter to matching airports if both specified
                        if (departure && depCode && depCode !== departure.toUpperCase()) return false;
                        if (arrival && arrCode && arrCode !== arrival.toUpperCase()) return false;
                        return true;
                    })
                    .map(normalizeFlightAwareFlight);
            } else {
                // Search by origin/destination
                const query = `-origin {${departure.toUpperCase()}} -destination {${arrival.toUpperCase()}}`;
                const data = await flightAwareFetch(
                    `/flights/search?query=${encodeURIComponent(query)}&start=${date}T00:00:00Z&end=${date}T23:59:59Z`,
                    config.apiKey
                );
                flights = (data.flights || []).map(normalizeFlightAwareFlight);
            }

            // Filter by approximate departure time if provided
            if (departureTime && flights.length > 1) {
                const targetHour = parseInt(departureTime.split(':')[0], 10);
                flights.sort((a, b) => {
                    const aHour = a.departure.time ? new Date(a.departure.time).getUTCHours() : 24;
                    const bHour = b.departure.time ? new Date(b.departure.time).getUTCHours() : 24;
                    return Math.abs(aHour - targetHour) - Math.abs(bHour - targetHour);
                });
            }

            if (flights.length > 0) return flights;
            // Fall through to synthetic if no results
        } catch (err) {
            log.warn('FlightAware search failed — falling back to synthesis', err);
            // Fall through to synthetic
        }
    }

    // Fallback: synthetic result
    const depTimeStr = departureTime || '08:00';
    const depDateTime = `${date}T${depTimeStr}:00`;
    const distMi = haversine(depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon);
    const flightHours = distMi / 500; // ~500 mph avg
    const arrDateTime = new Date(new Date(depDateTime).getTime() + flightHours * 3600000);

    return [{
        flightId: `synth-${departure.toUpperCase()}-${arrival.toUpperCase()}-${date}`,
        flightNumber: flightNumber || '',
        airline: '',
        departure: {
            airport: departure.toUpperCase(),
            airportName: depAirport.name,
            city: depAirport.city,
            time: new Date(depDateTime).toISOString(),
        },
        arrival: {
            airport: arrival.toUpperCase(),
            airportName: arrAirport.name,
            city: arrAirport.city,
            time: arrDateTime.toISOString(),
        },
        duration: formatDuration(flightHours * 3600),
        source: 'great_circle',
    }];
}

/**
 * Get the flight track (coordinate path) for a given flight.
 * Returns Journey-compatible track data.
 */
async function getFlightTrack(flightId, departure, arrival, departureTime, arrivalTime) {
    const config = await getFlightConfig();
    const airports = getAirports();

    const depAirport = airports[departure.toUpperCase()];
    const arrAirport = airports[arrival.toUpperCase()];
    if (!depAirport || !arrAirport) {
        throw new Error(`Unknown airport code: ${!depAirport ? departure : arrival}`);
    }

    // Try FlightAware if we have a key and it's not a synthetic ID
    if (config.apiKey && flightId && !flightId.startsWith('synth-')) {
        try {
            const data = await flightAwareFetch(`/flights/${flightId}/track`, config.apiKey);
            const positions = data.positions || [];

            if (positions.length >= 2) {
                const coords = [];
                const profileTimeMs = [];
                const profileDistMi = [];
                const profileElevM = [];
                const profileSpeedMph = [];
                let totalMiles = 0;
                let topSpeedMph = 0;
                let sumSpeed = 0;
                let speedCount = 0;
                let topElevM = 0;
                let lowestElevM = Infinity;
                let sumElev = 0;
                let lastLat = null, lastLon = null;

                for (const pos of positions) {
                    const lat = pos.latitude;
                    const lon = pos.longitude;
                    if (lat == null || lon == null) continue;

                    const altFt = pos.altitude || 0;
                    const altM = altFt * 0.3048;
                    const speedKts = pos.groundspeed || 0;
                    const speedMph = speedKts * 1.15078;
                    const ts = pos.timestamp ? new Date(pos.timestamp).getTime() : 0;

                    if (lastLat !== null) {
                        totalMiles += haversine(lastLat, lastLon, lat, lon);
                    }

                    coords.push([parseFloat(lat.toFixed(5)), parseFloat(lon.toFixed(5))]);
                    profileTimeMs.push(ts);
                    profileDistMi.push(parseFloat(totalMiles.toFixed(2)));
                    profileElevM.push(parseFloat(altM.toFixed(1)));
                    profileSpeedMph.push(parseFloat(speedMph.toFixed(1)));

                    if (speedMph > topSpeedMph) topSpeedMph = speedMph;
                    if (speedMph > 0) { sumSpeed += speedMph; speedCount++; }
                    if (altM > topElevM) topElevM = altM;
                    if (altM < lowestElevM) lowestElevM = altM;
                    sumElev += altM;

                    lastLat = lat;
                    lastLon = lon;
                }

                const firstTs = profileTimeMs[0];
                const lastTs = profileTimeMs[profileTimeMs.length - 1];
                const durationSec = (lastTs - firstTs) / 1000;

                // Compute elevation gain/loss
                let elevGain = 0, elevLoss = 0;
                for (let i = 1; i < profileElevM.length; i++) {
                    const d = profileElevM[i] - profileElevM[i - 1];
                    if (d > 5) elevGain += d;
                    else if (d < -5) elevLoss += Math.abs(d);
                }

                return {
                    coordinates: coords,
                    profileTimeMs,
                    profileDistMi,
                    profileElevM,
                    profileSpeedMph,
                    distance: parseFloat(totalMiles.toFixed(2)),
                    duration: formatDuration(durationSec),
                    durationSec,
                    topSpeed: parseFloat(topSpeedMph.toFixed(2)),
                    avgSpeed: speedCount ? parseFloat((sumSpeed / speedCount).toFixed(2)) : 0,
                    topElevation: parseFloat(topElevM.toFixed(2)),
                    lowestElevation: lowestElevM === Infinity ? 0 : parseFloat(lowestElevM.toFixed(2)),
                    avgElevation: coords.length ? parseFloat((sumElev / coords.length).toFixed(2)) : 0,
                    elevationGain: parseFloat(elevGain.toFixed(2)),
                    elevationLoss: parseFloat(elevLoss.toFixed(2)),
                    source: 'flightaware',
                };
            }
            // If positions are sparse, fall through to synthesis
        } catch (err) {
            log.warn('FlightAware track failed — falling back to synthesis', err);
        }
    }

    // Fallback: great-circle synthesis
    const depTime = departureTime || new Date().toISOString();
    const distMi = haversine(depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon);
    const flightHours = distMi / 500;
    const arrTime = arrivalTime || new Date(new Date(depTime).getTime() + flightHours * 3600000).toISOString();

    return synthesizeTrack(depAirport, arrAirport, depTime, arrTime);
}

module.exports = {
    searchFlights,
    getFlightTrack,
    getAirports,
    clearConfigCache,
};
