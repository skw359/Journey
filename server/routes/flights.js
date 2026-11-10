const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { withTenantTransaction } = require('../db');
const { formatDuration } = require('../utils/format');
const { searchFlights, getFlightTrack, getAirports, isFlightId, normalizeFlightNumber } = require('../utils/flight');
const { fetchAndStoreWeather } = require('../utils/weather');
const { insertRoute } = require('../utils/routeRecords');
const { journeyDate } = require('../utils/journeyIngest');
const { parseTimeZone } = require('../utils/timeZone');
const { refreshDerivedSoon } = require('../utils/journeyDerived');
const { computePassedLists } = require('./upload');
const log = require('../utils/logger').scope('flights');

const MAX_NAME_CHARS = 200;
const EARLIEST_FLIGHT_MS = Date.UTC(1950, 0, 1);
const LATEST_FLIGHT_AHEAD_MS = 2 * 365 * 86400000;

class BadRequest extends Error {}

function airportCode(value) {
    if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
        throw new BadRequest('Airport codes must be 3-letter IATA codes');
    }
    const code = value.toUpperCase();
    if (!getAirports()[code]) throw new BadRequest(`Unknown airport code: ${code}`);
    return code;
}

function optionalInstant(value, label) {
    if (value == null || value === '') return null;
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms) || ms < EARLIEST_FLIGHT_MS || ms > Date.now() + LATEST_FLIGHT_AHEAD_MS) {
        throw new BadRequest(`${label} must be an ISO date and time`);
    }
    return new Date(ms).toISOString();
}

// Every field of a flight request, checked once for /search, /track and /import. Nothing
// from the body reaches the flight service or the database except through here.
function parseFlightRequest(body, { search = false } = {}) {
    const input = body && typeof body === 'object' ? body : {};
    if (!input.departure || !input.arrival || (search && !input.date)) {
        throw new BadRequest(search
            ? 'Departure airport, arrival airport, and date are required'
            : 'Departure and arrival airport codes are required');
    }
    const flight = { departure: airportCode(input.departure), arrival: airportCode(input.arrival) };

    if (search) {
        if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
            || !Number.isFinite(Date.parse(`${input.date}T00:00:00Z`))) {
            throw new BadRequest('Date must be in YYYY-MM-DD format');
        }
        flight.date = input.date;
        flight.departureTime = null;
        if (input.departureTime != null && input.departureTime !== '') {
            if (typeof input.departureTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.departureTime)) {
                throw new BadRequest('Departure time must be in HH:MM format');
            }
            flight.departureTime = input.departureTime;
        }
        flight.flightNumber = null;
        if (input.flightNumber != null && input.flightNumber !== '') {
            flight.flightNumber = normalizeFlightNumber(input.flightNumber);
            if (!flight.flightNumber) throw new BadRequest('Flight numbers are letters and digits, like UA123');
        }
        return flight;
    }

    flight.flightId = null;
    if (input.flightId != null && input.flightId !== '') {
        if (!isFlightId(input.flightId)) throw new BadRequest('Invalid flight id');
        flight.flightId = input.flightId;
    }
    flight.departureTime = optionalInstant(input.departureTime, 'Departure time');
    flight.arrivalTime = optionalInstant(input.arrivalTime, 'Arrival time');
    if (flight.departureTime && flight.arrivalTime && flight.arrivalTime <= flight.departureTime) {
        throw new BadRequest('Arrival must be after departure');
    }
    flight.name = null;
    if (input.name != null && input.name !== '') {
        if (typeof input.name !== 'string') throw new BadRequest('Invalid name');
        const name = input.name.trim();
        if (name.length > MAX_NAME_CHARS) throw new BadRequest(`Names are limited to ${MAX_NAME_CHARS} characters`);
        flight.name = name || null;
    }
    return flight;
}

function sendFlightError(res, err, label, fallback) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    log.error(`${label} error:`, err);
    res.status(500).json({ error: fallback });
}

// GET /api/flights/airports — return airport lookup data for frontend autocomplete
router.get('/airports', (req, res) => {
    try {
        const airports = getAirports();
        res.json(airports);
    } catch (err) {
        log.error('GET /api/flights/airports error:', err);
        res.status(500).json({ error: 'Failed to load airport data' });
    }
});

// POST /api/flights/search — search for flights matching criteria
router.post('/search', express.json(), async (req, res) => {
    try {
        const { departure, arrival, date, departureTime, flightNumber } = parseFlightRequest(req.body, { search: true });
        const flights = await searchFlights(departure, arrival, date, departureTime, flightNumber);
        res.json({ flights });
    } catch (err) {
        sendFlightError(res, err, 'POST /api/flights/search', 'Flight search failed');
    }
});

// POST /api/flights/track — get flight track for map preview
router.post('/track', express.json(), async (req, res) => {
    try {
        const { flightId, departure, arrival, departureTime, arrivalTime } = parseFlightRequest(req.body);
        const track = await getFlightTrack(flightId, departure, arrival, departureTime, arrivalTime);
        res.json(track);
    } catch (err) {
        sendFlightError(res, err, 'POST /api/flights/track', 'Failed to load the flight track');
    }
});

// POST /api/flights/import — import a flight as a journey
router.post('/import', express.json(), async (req, res) => {
    try {
        const { flightId, departure, arrival, departureTime, arrivalTime, name } = parseFlightRequest(req.body);
        // Names and dates read in the importer's zone, not the server's.
        const timeZone = parseTimeZone(req.body?.timeZone) || undefined;

        const track = await getFlightTrack(flightId, departure, arrival, departureTime, arrivalTime);

        if (!track.coordinates || track.coordinates.length < 2) {
            return res.status(400).json({ error: 'Could not generate flight track' });
        }

        const startTime = departureTime ? new Date(departureTime) : new Date(track.profileTimeMs[0]);
        const endTime = arrivalTime ? new Date(arrivalTime) : new Date(track.profileTimeMs[track.profileTimeMs.length - 1]);
        const durationSec = (endTime.getTime() - startTime.getTime()) / 1000;

        const routeId = `journey-${crypto.randomBytes(8).toString('hex')}`;
        const defaultName = `Flight - ${departure} to ${arrival} - ${journeyDate(startTime, timeZone)}`;

        const routeData = {
            id: routeId,
            name: name || defaultName,
            date: journeyDate(startTime, timeZone),
            distance: track.distance,
            duration: formatDuration(durationSec),
            topSpeed: track.topSpeed,
            avgSpeed: track.avgSpeed,
            topElevation: track.topElevation,
            lowestElevation: track.lowestElevation,
            avgElevation: track.avgElevation,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            coordinates: track.coordinates,
            elevationGain: track.elevationGain,
            elevationLoss: track.elevationLoss,
            startCoord: track.coordinates[0],
            endCoord: track.coordinates[track.coordinates.length - 1],
            source: 'flight_import',
            watchRecorded: false,
            profileTimeMs: track.profileTimeMs,
            profileDistMi: track.profileDistMi,
            profileElevM: track.profileElevM,
            profileSpeedMph: track.profileSpeedMph,
            travelMode: 'flight',
        };

        await withTenantTransaction(req.userId, (db) => insertRoute(db, {
            id: routeData.id,
            name: routeData.name,
            date: routeData.date,
            distance: routeData.distance,
            duration: routeData.duration,
            top_speed: routeData.topSpeed,
            avg_speed: routeData.avgSpeed,
            top_elevation: routeData.topElevation,
            lowest_elevation: routeData.lowestElevation,
            avg_elevation: routeData.avgElevation,
            start_time: routeData.startTime,
            end_time: routeData.endTime,
            coordinates: routeData.coordinates,
            elevation_gain: routeData.elevationGain,
            elevation_loss: routeData.elevationLoss,
            start_lat: routeData.startCoord ? routeData.startCoord[0] : null,
            start_lon: routeData.startCoord ? routeData.startCoord[1] : null,
            end_lat: routeData.endCoord ? routeData.endCoord[0] : null,
            end_lon: routeData.endCoord ? routeData.endCoord[1] : null,
            source: routeData.source,
            watch_recorded: routeData.watchRecorded,
            profile_time_ms: routeData.profileTimeMs,
            profile_dist_mi: routeData.profileDistMi,
            profile_elev_m: routeData.profileElevM,
            profile_speed_mph: routeData.profileSpeedMph,
            travel_mode: routeData.travelMode,
        }));

        log.success(`flight imported · ${departure}→${arrival} · ${routeData.distance}mi · #${routeData.id} · via ${track.source}`);

        const fullRoute = {
            ...routeData,
            distance: routeData.distance != null ? Number(routeData.distance).toFixed(2) : null,
            topSpeed: routeData.topSpeed != null ? Number(routeData.topSpeed).toFixed(2) : null,
            avgSpeed: routeData.avgSpeed != null ? Number(routeData.avgSpeed).toFixed(2) : null,
            topElevation: routeData.topElevation != null ? Number(routeData.topElevation).toFixed(2) : null,
            lowestElevation: routeData.lowestElevation != null ? Number(routeData.lowestElevation).toFixed(2) : null,
            avgElevation: routeData.avgElevation != null ? Number(routeData.avgElevation).toFixed(2) : null,
            waypoints: [],
            photos: [],
        };

        res.status(201).json({ message: 'Flight imported', route: fullRoute });

        // Fire-and-forget: weather (for the departure city), map data, cities, places
        if (routeData.startCoord && routeData.startCoord[0] != null) {
            fetchAndStoreWeather(req.userId, routeData.id, routeData.startCoord[0], routeData.startCoord[1], routeData.startTime)
                .catch(err => log.scope('weather').error('flight import fetch failed', err));
        }
        refreshDerivedSoon(req.userId);
        computePassedLists(req.userId, routeData.id, routeData.coordinates);
    } catch (err) {
        if (res.headersSent) return log.error('POST /api/flights/import follow-up failed:', err);
        sendFlightError(res, err, 'POST /api/flights/import', 'Failed to import flight');
    }
});

module.exports = router;
