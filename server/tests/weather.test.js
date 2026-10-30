'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const START = { lat: 40.748817, lon: -73.985428 };
const GEOCODER = 'http://geocoder.test';

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const forecast = {
    hourly: {
        time: ['2025-10-29T09:00'],
        temperature_2m: [55], apparent_temperature: [52], relative_humidity_2m: [60],
        wind_speed_10m: [8], wind_direction_10m: [200], weather_code: [2],
    },
};

test('weather never sends the exact start point to a third party', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer({ env: { GEOCODE_BASE_URL: GEOCODER } });
    t.after(env.teardown);
    const owner = await h.registerAdmin(env.origin);
    let geocoderUp = true;
    let geocoderCenter = null;

    h.outbound.handler = (url) => {
        if (url.startsWith(`${GEOCODER}/lookup`)) {
            if (!geocoderUp) return json({ error: 'down' }, 503);
            return json({ city: 'New York', state_code: 'NY', country_code: 'US', ...(geocoderCenter || {}) });
        }
        if (url.startsWith(GEOCODER)) return json({}, 404);
        if (url.startsWith('https://geocoding-api.open-meteo.com/v1/search')) {
            return json({ results: [
                { name: 'New York', latitude: 39.68, longitude: -93.92, country_code: 'US', admin1: 'Missouri' },
                { name: 'New York', latitude: 40.71427, longitude: -74.00597, country_code: 'US', admin1: 'New York' },
                { name: 'New York', latitude: 53.07, longitude: -0.14, country_code: 'GB', admin1: 'England' },
            ] });
        }
        if (url.startsWith('https://historical-forecast-api.open-meteo.com/')) return json(forecast);
        if (url.startsWith('https://custom.test/')) return json({ temp: 50, condition: 'Clear' });
        return null;
    };

    const thirdParty = () => h.outbound.calls.filter((url) => !url.startsWith(GEOCODER));
    const leaksExactPoint = (url) => url.includes('40.7488') || url.includes('-73.9854') || url.includes('40.74881');
    let lat = START.lat;
    async function uploadAndWait() {
        const rows = h.lineRows({ lat, lon: START.lon, count: 300 });
        lat += 0.0000001; // a distinct recording each time, same start city
        const res = await h.uploadJourney(owner, h.journeyZip(rows));
        assert.equal(res.status, 201, res.text);
        for (let i = 0; i < 50; i++) {
            const detail = (await owner.get(`/api/routes/${res.data.id}`)).data;
            if (detail.weather) return detail;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return (await owner.get(`/api/routes/${res.data.id}`)).data;
    }

    await t.test('weather is fetched for the start city found by name', async () => {
        h.outbound.calls.length = 0;
        const journey = await uploadAndWait();
        assert.equal(journey.weather.location, 'New York, NY');
        const weatherCalls = thirdParty().filter((u) => u.includes('historical-forecast'));
        assert.equal(weatherCalls.length, 1);
        assert.match(weatherCalls[0], /latitude=40\.7143&longitude=-74\.006/);
        assert.ok(thirdParty().every((u) => !leaksExactPoint(u)), thirdParty().join('\n'));
        const search = thirdParty().find((u) => u.includes('geocoding-api'));
        assert.ok(search && !/lat|lon/i.test(new URL(search).search.replace(/language/, '')), 'the search sends only the name');
    });

    await t.test('a city center from the geocoder is used directly', async () => {
        geocoderCenter = { city_lat: 40.7128, city_lon: -74.006 };
        h.outbound.calls.length = 0;
        const journey = await uploadAndWait();
        geocoderCenter = null;
        assert.ok(journey.weather);
        assert.ok(!thirdParty().some((u) => u.includes('geocoding-api')), 'no name search needed');
        assert.ok(thirdParty().some((u) => /latitude=40\.7128&longitude=-74\.006/.test(u)));
    });

    await t.test('without a city, weather comes from a 0.1° grid cell', async () => {
        geocoderUp = false;
        h.outbound.calls.length = 0;
        const journey = await uploadAndWait();
        geocoderUp = true;
        assert.ok(journey.weather);
        assert.equal(journey.weather.location, null);
        const call = thirdParty().find((u) => u.includes('historical-forecast'));
        assert.match(call, /latitude=40\.7&longitude=-74(&|$)/);
        assert.ok(thirdParty().every((u) => !leaksExactPoint(u)));
    });

    await t.test('a custom provider gets the city point and name', async () => {
        const saved = await owner.put('/api/settings/weather', {
            json: { provider: 'custom', customUrl: 'https://custom.test/w?lat={lat}&lon={lon}&city={city}&t={timestamp}' },
        });
        assert.equal(saved.status, 200);
        h.outbound.calls.length = 0;
        await uploadAndWait();
        const call = thirdParty().find((u) => u.startsWith('https://custom.test/'));
        assert.ok(call, thirdParty().join('\n'));
        assert.match(call, /lat=40\.7143&lon=-74\.006&city=New%20York%2C%20NY/);
        assert.ok(!leaksExactPoint(call));
        await owner.put('/api/settings/weather', { json: { provider: 'open-meteo' } });
    });

    await t.test('soundings use the stored city location, not coordinates from the browser', async () => {
        const journey = (await owner.get('/api/routes')).data[0];
        h.outbound.calls.length = 0;
        const res = await owner.get(`/api/settings/weather/sounding?routeId=${journey.id}&lat=40.748817&lon=-73.985428&time=2025-10-29T09:26:40Z`);
        assert.ok([200, 404].includes(res.status));
        const call = thirdParty().find((u) => u.includes('historical-forecast'));
        assert.ok(call);
        assert.ok(!leaksExactPoint(call), call);
        assert.equal((await owner.get('/api/settings/weather/sounding?lat=1&lon=2&time=x')).status, 400);
    });

    await t.test('turning weather off stops every lookup', async () => {
        await owner.put('/api/settings/weather', { json: { enabled: false } });
        h.outbound.calls.length = 0;
        const rows = h.lineRows({ lat: 41.5, lon: -72, count: 300 });
        await h.uploadJourney(owner, h.journeyZip(rows));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(thirdParty().length, 0);
    });
});
