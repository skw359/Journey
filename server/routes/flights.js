const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { withTenantTransaction } = require('../db');
const { formatDuration } = require('../utils/format');
const { searchFlights, getFlightTrack, getAirports } = require('../utils/flight');
const { fetchAndStoreWeather } = require('../utils/weather');
const { insertRoute } = require('../utils/routeRecords');
const { refreshDerivedSoon } = require('../utils/journeyDerived');
const { computePassedLists } = require('./upload');
const log = require('../utils/logger').scope('flights');

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
        const { departure, arrival, date, departureTime, flightNumber } = req.body;

        if (!departure || !arrival || !date) {
            return res.status(400).json({ error: 'Departure airport, arrival airport, and date are required' });
        }

        if (!/^[A-Za-z]{3}$/.test(departure) || !/^[A-Za-z]{3}$/.test(arrival)) {
            return res.status(400).json({ error: 'Airport codes must be 3-letter IATA codes' });
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format' });
        }

        const flights = await searchFlights(departure, arrival, date, departureTime, flightNumber);
        res.json({ flights });
    } catch (err) {
        log.error('POST /api/flights/search error:', err);
        res.status(err.message.includes('Unknown airport') ? 400 : 500).json({ error: err.message });
    }
});

// POST /api/flights/track — get flight track for map preview
router.post('/track', express.json(), async (req, res) => {
    try {
        const { flightId, departure, arrival, departureTime, arrivalTime } = req.body;

        if (!departure || !arrival) {
            return res.status(400).json({ error: 'Departure and arrival airport codes are required' });
        }

        const track = await getFlightTrack(flightId, departure, arrival, departureTime, arrivalTime);
        res.json(track);
    } catch (err) {
        log.error('POST /api/flights/track error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/flights/import — import a flight as a journey
router.post('/import', express.json(), async (req, res) => {
    try {
        const { flightId, departure, arrival, departureTime, arrivalTime, name } = req.body;

        if (!departure || !arrival) {
            return res.status(400).json({ error: 'Departure and arrival airport codes are required' });
        }

        // Get the flight track
        const track = await getFlightTrack(flightId, departure, arrival, departureTime, arrivalTime);

        if (!track.coordinates || track.coordinates.length < 2) {
            return res.status(400).json({ error: 'Could not generate flight track' });
        }

        const startTime = departureTime ? new Date(departureTime) : new Date(track.profileTimeMs[0]);
        const endTime = arrivalTime ? new Date(arrivalTime) : new Date(track.profileTimeMs[track.profileTimeMs.length - 1]);
        const durationSec = (endTime.getTime() - startTime.getTime()) / 1000;

        const routeId = `journey-${crypto.randomBytes(8).toString('hex')}`;
        const defaultName = `Flight - ${departure.toUpperCase()} to ${arrival.toUpperCase()} - ${startTime.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}`;

        const routeData = {
            id: routeId,
            name: name || defaultName,
            date: startTime.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
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

        log.success(`flight imported · ${departure.toUpperCase()}→${arrival.toUpperCase()} · ${routeData.distance}mi · #${routeData.id} · via ${track.source}`);

        // Return the full route object
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
        log.error('POST /api/flights/import error:', err);
        res.status(500).json({ error: 'Failed to import flight' });
    }
});

module.exports = router;
