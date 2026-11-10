'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test('Fun Stats units and time zones', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const owner = await h.registerAdmin(env.origin);

    // 01:00 UTC on Saturday 25 Oct 2025 is 6 pm on Friday 24 Oct in Los Angeles.
    const start = Date.UTC(2025, 9, 25, 1, 0, 0);
    const climb = h.lineRows({ count: 400, start }).map((row, i) => ({ ...row, ele: 100 + i }));
    const up = await h.uploadJourney(owner, h.journeyZip(climb), { timeZone: 'America/Los_Angeles' });
    assert.equal(up.status, 201, up.text);

    await t.test('elevation is reported in metres, matching the journey', async () => {
        const detail = (await owner.get(`/api/routes/${up.data.id}`)).data;
        assert.equal(Number(detail.elevationGain), 399);
        const { elevation } = (await owner.get('/api/fun-stats')).data;
        assert.deepEqual(elevation, { totalGainM: 399, totalLossM: 0, peakElevationM: 499 });
    });

    await t.test('days, weekdays and hours are counted in the viewer\'s zone', async () => {
        const la = (await owner.get('/api/fun-stats?tz=America%2FLos_Angeles')).data;
        assert.equal(la.timeZone, 'America/Los_Angeles');
        assert.equal(la.weekdayCount, 1);
        assert.equal(la.weekendCount, 0);
        assert.deepEqual(la.peakDayOfWeek, { day: 'Friday', count: 1 });
        assert.deepEqual(la.peakHour, { hour: 18, count: 1 });
        assert.equal(la.timeOfDay[0].name, 'Evening');
        assert.deepEqual(la.activityHeatmap, { '2025-10-24': 1 });
        assert.equal(la.busiestDay.date, '2025-10-24');
        assert.equal(la.habitInsights.commuteWindow.count, 1, '6 pm on a weekday is the commute window');
        assert.equal(la.bingoCard.find((square) => square.id === 'friday_journey').completed, true);
        assert.equal(la.bingoCard.find((square) => square.id === 'weekend_warrior').completed, false);
        assert.equal(la.monthlyChart[0].month, '2025-10');

        // The same journey seen from UTC, without a zone, or with a zone that doesn't exist.
        for (const query of ['?tz=UTC', '', '?tz=Mars%2FOlympus']) {
            const utc = (await owner.get(`/api/fun-stats${query}`)).data;
            assert.equal(utc.timeZone, 'UTC', query);
            assert.equal(utc.weekendCount, 1, query);
            assert.deepEqual(utc.peakDayOfWeek, { day: 'Saturday', count: 1 }, query);
            assert.deepEqual(utc.peakHour, { hour: 1, count: 1 }, query);
            assert.deepEqual(utc.activityHeatmap, { '2025-10-25': 1 }, query);
            assert.equal(utc.bingoCard.find((square) => square.id === 'friday_journey').completed, false, query);
        }

        // A zone on the far side of the date line, to be sure nothing is hard-wired.
        const tokyo = (await owner.get('/api/fun-stats?tz=Asia%2FTokyo')).data;
        assert.deepEqual(tokyo.peakHour, { hour: 10, count: 1 });
        assert.deepEqual(tokyo.activityHeatmap, { '2025-10-25': 1 });
    });

    await t.test('the journey is named for the day it happened where it was recorded', async () => {
        assert.equal(up.data.name, 'Journey - Oct 24, 2025 - 18:00');
        assert.equal(up.data.date, 'Oct 24, 2025');
    });

    await t.test('flights count as a travel mode', async () => {
        const flight = await owner.post('/api/flights/import', { json: {
            departure: 'JFK', arrival: 'LAX',
            departureTime: '2025-10-20T15:00:00.000Z', arrivalTime: '2025-10-20T21:00:00.000Z',
        } });
        assert.equal(flight.status, 201, flight.text);
        const stats = (await owner.get('/api/fun-stats')).data;
        assert.equal(stats.modeCounts.flight, 1);
        assert.ok(stats.modeDistances.flight > 2000);
        assert.equal(stats.modeCounts.drive + stats.modeCounts.foot + stats.modeCounts.scooter, 1);
    });
});
