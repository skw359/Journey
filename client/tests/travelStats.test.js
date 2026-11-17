import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFilteredStats } from '../src/utils/travelStats.js';

const hour = 3600 * 1000;
const journey = (distance, travelMode, startMs, durationMs, points = 3) => ({
  distance,
  travelMode,
  startTime: startMs == null ? null : new Date(startMs).toISOString(),
  endTime: startMs == null ? null : new Date(startMs + durationMs).toISOString(),
  coordinates: Array.from({ length: points }, (_, i) => [40 + i, -74]),
});

test('totals add up the journeys given', () => {
  const start = Date.UTC(2025, 5, 1, 8);
  const stats = computeFilteredStats([
    journey('12.34', 'drive', start, 2 * hour, 100),
    journey('3.21', 'foot', start + 5 * hour, 0.5 * hour, 50),
    journey('2469.60', 'flight', start + 24 * hour, 30 * hour, 101),
    journey('7.05', 'drive', start + 60 * hour, 1.25 * hour, 10),
  ]);
  assert.deepEqual(stats, {
    totalRoutes: 4,
    totalDistance: 2492.2,
    totalTime: { days: 1, hours: 9, minutes: 45 },
    totalPoints: 261,
    modeDistances: { drive: 19.4, scooter: 0, foot: 3.2, train: 0, metro: 0, flight: 2469.6 },
  });
});

test('missing and odd values are counted as nothing, not as errors', () => {
  const stats = computeFilteredStats([
    journey(null, 'drive', null, 0, 0),
    journey('abc', 'train', Date.UTC(2025, 0, 1), hour),
    { distance: '5.00', travelMode: 'hovercraft', startTime: 'not a date', endTime: 'nor this' },
    { distance: 2.5, travelMode: 'metro', startTime: new Date(0).toISOString(), endTime: null },
  ]);
  assert.equal(stats.totalRoutes, 4);
  assert.equal(stats.totalDistance, 7.5, 'an unknown mode still counts toward the total');
  assert.deepEqual(stats.totalTime, { days: 0, hours: 1, minutes: 0 });
  assert.equal(stats.totalPoints, 3);
  assert.deepEqual(stats.modeDistances, { drive: 0, scooter: 0, foot: 0, train: 0, metro: 2.5, flight: 0 });
});

test('nothing to total', () => {
  const empty = { totalRoutes: 0, totalDistance: 0, totalTime: null, totalPoints: 0, modeDistances: { drive: 0, scooter: 0, foot: 0, train: 0, metro: 0, flight: 0 } };
  assert.deepEqual(computeFilteredStats([]), empty);
  assert.deepEqual(computeFilteredStats(null), empty);
  assert.deepEqual(computeFilteredStats(undefined), empty);
});
