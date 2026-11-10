'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const AEROAPI = 'https://aeroapi.flightaware.com/aeroapi';

test('flight search, track and import', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const admin = await h.registerAdmin(env.origin);
    const second = await h.registerInvited(env.origin, admin, 'second');
    assert.equal((await admin.put('/api/settings/flights', { json: { apiKey: 'test-key' } })).status, 200);

    const aeroCalls = () => h.outbound.calls.filter((url) => url.startsWith(AEROAPI));
    t.beforeEach(() => { h.outbound.calls.length = 0; });
    const route = { departure: 'JFK', arrival: 'LAX' };

    await t.test('a flight id cannot steer the FlightAware request', async () => {
        const hostile = [
            '../airports/KSEA/flights?max_pages=5&x=',
            'UAL4/../../airports',
            'UAL4?max_pages=50',
            'UAL4#x',
            'UAL 4',
            'x'.repeat(100),
            42,
            { id: 'UAL4' },
        ];
        for (const flightId of hostile) {
            for (const path of ['/api/flights/track', '/api/flights/import']) {
                const res = await second.post(path, { json: { ...route, flightId } });
                assert.equal(res.status, 400, `${path} ${JSON.stringify(flightId)}`);
            }
        }
        assert.deepEqual(aeroCalls(), [], 'nothing was sent with the admin\'s key');
        assert.equal((await second.get('/api/routes')).data.length, 0);

        const real = await second.post('/api/flights/track', { json: { ...route, flightId: 'UAL4-1669704000-schedule-1227p' } });
        assert.equal(real.status, 200, real.text);
        assert.deepEqual(aeroCalls(), [`${AEROAPI}/flights/UAL4-1669704000-schedule-1227p/track`]);
        assert.equal(real.data.source, 'great_circle', 'FlightAware is offline in tests, so the track is synthesized');
    });

    await t.test('a flight number cannot steer the FlightAware request', async () => {
        const search = { ...route, date: '2025-10-01' };
        for (const flightNumber of ['../airports/KSEA', 'UA123?x=1', 'UA/123', 'UA#1', 'U', 42]) {
            const res = await second.post('/api/flights/search', { json: { ...search, flightNumber } });
            assert.equal(res.status, 400, JSON.stringify(flightNumber));
        }
        assert.deepEqual(aeroCalls(), []);

        const ok = await second.post('/api/flights/search', { json: { ...search, flightNumber: 'ua 123' } });
        assert.equal(ok.status, 200, ok.text);
        assert.deepEqual(aeroCalls(), [`${AEROAPI}/flights/UA123?start=2025-10-01T00:00:00Z&end=2025-10-01T23:59:59Z`]);
        assert.equal(ok.data.flights[0].flightId, 'synth-JFK-LAX-2025-10-01');
    });

    await t.test('every route validates airports, dates and times', async () => {
        const cases = [
            ['/api/flights/search', { departure: 42, arrival: 'LAX', date: '2025-10-01' }],
            ['/api/flights/search', { departure: 'JFK', arrival: 'ZZZ', date: '2025-10-01' }],
            ['/api/flights/search', { ...route, date: '2025-13-45' }],
            ['/api/flights/search', { ...route, date: '2025-10-01', departureTime: '25:00' }],
            ['/api/flights/search', { ...route, date: '2025-10-01', departureTime: 800 }],
            ['/api/flights/track', { departure: 42, arrival: 'LAX' }],
            ['/api/flights/track', { departure: ['JFK'], arrival: 'LAX' }],
            ['/api/flights/track', { departure: 'JFKX', arrival: 'LAX' }],
            ['/api/flights/track', { departure: 'JFK', arrival: 'ZZZ' }],
            ['/api/flights/track', { ...route, departureTime: 'yesterday' }],
            ['/api/flights/track', { ...route, departureTime: 12345 }],
            ['/api/flights/track', { ...route, departureTime: '2025-10-01T12:00:00Z', arrivalTime: '2025-10-01T10:00:00Z' }],
            ['/api/flights/import', { departure: 'JFK' }],
            ['/api/flights/import', { ...route, arrivalTime: '0001-01-01T00:00:00Z' }],
            ['/api/flights/import', { ...route, name: 'x'.repeat(201) }],
            ['/api/flights/import', { ...route, name: { toString: 1 } }],
        ];
        for (const [path, json] of cases) {
            const res = await second.post(path, { json });
            assert.equal(res.status, 400, `${path} ${JSON.stringify(json)}: ${res.text}`);
            assert.ok(!/is not a function|undefined/.test(res.data.error), res.data.error);
        }
        assert.equal((await second.get('/api/routes')).data.length, 0);
    });

    await t.test('an imported flight is named in the importer\'s time zone', async () => {
        // 03:30 UTC on 2 Oct is still 1 Oct in New York.
        const times = { departureTime: '2025-10-02T03:30:00.000Z', arrivalTime: '2025-10-02T09:30:00.000Z' };
        const res = await second.post('/api/flights/import', { json: { ...route, ...times, timeZone: 'America/New_York' } });
        assert.equal(res.status, 201, res.text);
        assert.equal(res.data.route.name, 'Flight - JFK to LAX - Oct 01, 2025');
        assert.equal(res.data.route.date, 'Oct 01, 2025');
        assert.equal(res.data.route.travelMode, 'flight');

        const named = await second.post('/api/flights/import', { json: { ...route, ...times, name: '  Red-eye home  ' } });
        assert.equal(named.status, 201, named.text);
        assert.equal(named.data.route.name, 'Red-eye home');
        assert.equal((await second.get('/api/routes')).data.length, 2);
        assert.equal((await admin.get('/api/routes')).data.length, 0);
    });
});
