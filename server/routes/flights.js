const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { withTenantClient, toApiRoute } = require('../db');
const { haversine } = require('../utils/geo');
const { formatDuration } = require('../utils/format');
const { searchFlights, getFlightTrack, getAirports } = require('../utils/flight');
const { fetchAndStoreWeather } = require('../utils/weather');
const { computeCitiesPassed } = require('../utils/cities');
const { computePlacesPassed } = require('../utils/places');
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

        // Insert into database
        await withTenantClient(req.userId, async (client) => {
            await client.query('BEGIN');
            try {
                const startCoord = routeData.startCoord || [null, null];
                const endCoord = routeData.endCoord || [null, null];

                await client.query(`
                    INSERT INTO routes (
                        id, name, date, distance, duration, top_speed, avg_speed,
                        top_elevation, lowest_elevation, avg_elevation,
                        start_time, end_time, coordinates,
                        elevation_gain, elevation_loss,
                        start_lat, start_lon, end_lat, end_lon,
                        source, watch_recorded,
                        profile_time_ms, profile_dist_mi, profile_elev_m, profile_speed_mph,
                        travel_mode
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7,
                        $8, $9, $10,
                        $11, $12, $13,
                        $14, $15,
                        $16, $17, $18, $19,
                        $20, $21,
                        $22, $23, $24, $25,
                        $26
                    )
                `, [
                    routeData.id,
                    routeData.name,
                    routeData.date,
                    routeData.distance,
                    routeData.duration,
                    routeData.topSpeed,
                    routeData.avgSpeed,
                    routeData.topElevation,
                    routeData.lowestElevation,
                    routeData.avgElevation,
                    routeData.startTime,
                    routeData.endTime,
                    JSON.stringify(routeData.coordinates),
                    routeData.elevationGain,
                    routeData.elevationLoss,
                    startCoord[0],
                    startCoord[1],
                    endCoord[0],
                    endCoord[1],
                    routeData.source,
                    routeData.watchRecorded,
                    JSON.stringify(routeData.profileTimeMs),
                    JSON.stringify(routeData.profileDistMi),
                    JSON.stringify(routeData.profileElevM),
                    JSON.stringify(routeData.profileSpeedMph),
                    routeData.travelMode,
                ]);

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        });

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

        // Fire-and-forget: weather, cities, places
        if (routeData.startCoord && routeData.startCoord[0] != null) {
            fetchAndStoreWeather(req.userId, routeData.id, routeData.startCoord[0], routeData.startCoord[1], routeData.startTime)
                .catch(err => log.scope('weather').error('flight import fetch failed', err));
        }

        if (routeData.coordinates && routeData.coordinates.length >= 2) {
            computeCitiesPassed(routeData.coordinates)
                .then(cities => {
                    if (cities === null) {
                        log.scope('cities').error(`geocoder unreachable — flight #${routeData.id} left for backfill`);
                        return;
                    }
                    return withTenantClient(req.userId, client =>
                        client.query('UPDATE routes SET cities_passed = $1 WHERE id = $2', [JSON.stringify(cities), routeData.id])
                    ).then(() => log.scope('cities').debug(`computed for flight #${routeData.id}`));
                })
                .catch(err => log.scope('cities').error('flight computation failed', err));

            computePlacesPassed(routeData.coordinates)
                .then(places => {
                    if (places === null) {
                        log.scope('places').error(`geocoder unreachable — flight #${routeData.id} left for backfill`);
                        return;
                    }
                    return withTenantClient(req.userId, client =>
                        client.query('UPDATE routes SET places_passed = $1 WHERE id = $2', [JSON.stringify(places), routeData.id])
                    ).then(() => log.scope('places').debug(`computed for flight #${routeData.id}`));
                })
                .catch(err => log.scope('places').error('flight computation failed', err));
        }
    } catch (err) {
        log.error('POST /api/flights/import error:', err);
        res.status(500).json({ error: 'Failed to import flight' });
    }
});

module.exports = router;
