const express = require('express');
const router = express.Router();
const { GEOCODE_BASE_URL } = require('../config');
const log = require('../utils/logger').scope('geocode');

// The web client's reverse-geocoding calls go through here so the geocoder's
// address stays in server config instead of the browser bundle.
const ENDPOINTS = new Set(['lookup', 'building']);
const UPSTREAM_TIMEOUT_MS = 10000;

// GET /api/geocode/:endpoint?lat=..&lon=..
router.get('/:endpoint', async (req, res) => {
  if (!ENDPOINTS.has(req.params.endpoint)) return res.status(404).json({ error: 'Unknown geocode endpoint' });
  if (!GEOCODE_BASE_URL) return res.status(503).json({ error: 'Geocoding is not configured' });

  const query = new URLSearchParams(req.query).toString();
  try {
    const upstream = await fetch(`${GEOCODE_BASE_URL}/${req.params.endpoint}?${query}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // Pass the status through: the client falls back to /lookup on a 404 from /building.
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    log.warn(`Geocoder ${req.params.endpoint} failed: ${err.message}`);
    res.status(502).json({ error: 'Geocoder unreachable' });
  }
});

module.exports = router;
