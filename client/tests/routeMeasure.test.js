import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fromLonLat } from 'ol/proj.js';

// routeMeasure imports OpenLayers without file extensions, as Vite allows.
register('./resolve-ol.mjs', import.meta.url);
const {
  haversineMiles, buildTrack, snapToTrack, positionAtDistance, pathBetween, greatCircleFlat,
} = await import('../src/utils/routeMeasure.js');

const close = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? ''} ${actual} vs ${expected}`);
const xy = (lat, lon) => fromLonLat([lon, lat]);

test('great-circle distance in miles', () => {
  assert.equal(haversineMiles(40, -74, 40, -74), 0);
  // One degree of latitude with the server's Earth radius (3958.8 mi).
  close(haversineMiles(0, 0, 1, 0), 69.0941, 0.001);
  close(haversineMiles(40, -74, 41, -74), 69.0941, 0.001);
  // A degree of longitude shrinks with latitude.
  close(haversineMiles(60, 0, 60, 1), 69.0941 * Math.cos(Math.PI / 3), 0.01);
  // JFK to LAX.
  close(haversineMiles(40.6413, -73.7781, 33.9416, -118.4085), 2469, 6);
  close(haversineMiles(10, 20, 30, 40), haversineMiles(30, 40, 10, 20), 1e-9, 'symmetric');
});

test('a track measures along the recorded distance profile when there is one', () => {
  const coordinates = [[40, -74], [40.01, -74], [40.02, -74], [40.03, -74]];
  const fromHops = buildTrack({ coordinates });
  assert.equal(fromHops.n, 4);
  assert.equal(fromHops.fromProfile, false);
  assert.equal(fromHops.cum[0], 0);
  close(fromHops.cum[3], haversineMiles(40, -74, 40.03, -74), 1e-6, 'summed hops');

  // The profile is what the journey's own distance was built from, so it wins.
  const fromProfile = buildTrack({ coordinates, profileDistMi: [0, 0.5, 1.5, 3] });
  assert.equal(fromProfile.fromProfile, true);
  assert.deepEqual([...fromProfile.cum], [0, 0.5, 1.5, 3]);
  // Rounded profiles can tie or dip; a reading never runs backwards.
  assert.deepEqual([...buildTrack({ coordinates, profileDistMi: ['0', '1.2', '1.1', '2'] }).cum], [0, 1.2, 1.2, 2]);
  // A profile that doesn't line up with the points is ignored.
  assert.equal(buildTrack({ coordinates, profileDistMi: [0, 1, 2] }).fromProfile, false);
  assert.equal(buildTrack({ coordinates, profileDistMi: [0, 1, 'far', 3] }).fromProfile, false);
});

test('a point that cannot be read takes its neighbour\'s place, keeping indices aligned', () => {
  const track = buildTrack({ coordinates: [[40, -74], null, ['x', 'y'], [40.02, -74]] });
  assert.equal(track.n, 4);
  assert.deepEqual([...track.lats], [40, 40, 40, 40.02]);
  assert.deepEqual([...track.cum].slice(0, 3), [0, 0, 0]);
  // Leading junk takes the first readable point's position.
  assert.deepEqual([...buildTrack({ coordinates: [null, [41, -73]] }).lats], [41, 41]);
  assert.equal(buildTrack(null).n, 0);
  assert.equal(buildTrack({ coordinates: 'nope' }).n, 0);
});

test('snapping finds the nearest spot on the route', () => {
  const track = buildTrack({ coordinates: [[40, -74], [40, -73.99], [40.01, -73.99]], profileDistMi: [0, 1, 2] });
  const [x0, y0] = xy(40, -74);
  const [x1] = xy(40, -73.99);
  const [, y2] = xy(40.01, -73.99);

  // Just above the middle of the first leg.
  const mid = snapToTrack(track, (x0 + x1) / 2, y0 + 5);
  assert.equal(mid.i, 0);
  close(mid.t, 0.5, 1e-9);
  close(mid.cum, 0.5, 1e-9, 'half a mile along');
  close(mid.y, y0, 1e-6, 'on the line');
  // Past either end clamps to it.
  assert.equal(snapToTrack(track, x0 - 500, y0).cum, 0);
  assert.equal(snapToTrack(track, x1, y2 + 500).cum, 2);
  // Out of reach.
  assert.equal(snapToTrack(track, x0, y0 + 1000, { maxDist: 100 }), null);
  assert.notEqual(snapToTrack(track, x0, y0 + 50, { maxDist: 100 }), null);
  assert.equal(snapToTrack(buildTrack({ coordinates: [] }), 0, 0), null);
  assert.equal(snapToTrack(null, 0, 0), null);
  // A single point is its own nearest spot.
  const dot = buildTrack({ coordinates: [[40, -74]] });
  assert.equal(snapToTrack(dot, x0 + 3, y0).i, 0);
  assert.equal(snapToTrack(dot, x0 + 300, y0, { maxDist: 10 }), null);
});

test('dragging along an out-and-back route stays on the leg that was grabbed', () => {
  // Out along one line and back along a line 0.00002° beside it.
  const out = Array.from({ length: 11 }, (_, i) => [40, -74 + i * 0.001]);
  const back = Array.from({ length: 11 }, (_, i) => [40.00002, -73.99 - i * 0.001]);
  const track = buildTrack({ coordinates: [...out, ...back] });
  const [px, py] = xy(40.000012, -73.995); // slightly nearer the way back
  assert.ok(snapToTrack(track, px, py).i >= 11, 'with no handle, the nearer leg wins');

  const grabbed = snapToTrack(track, ...xy(40, -73.996));
  assert.ok(grabbed.i < 10);
  const dragged = snapToTrack(track, px, py, { prefer: grabbed, preferSlack: 5 });
  assert.ok(dragged.i < 10, 'stays on the way out');
  // A deliberate move well onto the other leg still switches.
  const [qx, qy] = xy(40.0002, -73.995);
  const jumped = snapToTrack(track, qx, qy, { prefer: grabbed, preferSlack: 0 });
  assert.ok(jumped.i >= 10, 'the far side of the return leg belongs to it');
});

test('a position a given distance along the route', () => {
  const track = buildTrack({ coordinates: [[40, -74], [40, -73.99], [40, -73.98]], profileDistMi: [0, 1, 3] });
  assert.deepEqual([positionAtDistance(track, -5).i, positionAtDistance(track, -5).cum], [0, 0], 'clamped to the start');
  assert.equal(positionAtDistance(track, 99).cum, 3, 'clamped to the end');
  const second = positionAtDistance(track, 2);
  assert.equal(second.i, 1);
  close(second.t, 0.5, 1e-9);
  close(second.x, (track.xs[1] + track.xs[2]) / 2, 1e-6);
  assert.equal(positionAtDistance(track, 1).cum, 1);
  // Two points at the same distance: no division by zero.
  const tied = buildTrack({ coordinates: [[40, -74], [40, -73.99], [40, -73.98]], profileDistMi: [0, 1, 1] });
  assert.ok(Number.isFinite(positionAtDistance(tied, 1).x));
});

test('the path between two positions follows the route, whichever is given first', () => {
  const track = buildTrack({ coordinates: [[40, -74], [40, -73.99], [40.01, -73.99], [40.01, -73.98]], profileDistMi: [0, 1, 2, 3] });
  const a = positionAtDistance(track, 0.5);
  const b = positionAtDistance(track, 2.5);
  const flat = pathBetween(track, a, b);
  assert.deepEqual(flat, [a.x, a.y, track.xs[1], track.ys[1], track.xs[2], track.ys[2], b.x, b.y]);
  assert.deepEqual(pathBetween(track, b, a), flat);
  assert.deepEqual(pathBetween(track, a, a), [a.x, a.y, a.x, a.y]);
});

test('a great-circle arc for drawing straight-line measurements', () => {
  const flat = greatCircleFlat(40.6413, -73.7781, 51.47, -0.4543, 32); // New York to London
  assert.equal(flat.length, 33 * 2);
  const [startX, startY] = xy(40.6413, -73.7781);
  const [endX, endY] = xy(51.47, -0.4543);
  close(flat[0], startX, 1e-3); close(flat[1], startY, 1e-3);
  close(flat.at(-2), endX, 1e-3); close(flat.at(-1), endY, 1e-3);
  // The arc bows north of the straight line on the map.
  assert.ok(flat[33] > (startY + endY) / 2, 'bows toward the pole');

  // Tokyo to Los Angeles crosses the antimeridian without streaking back across the map.
  const pacific = greatCircleFlat(35.55, 139.78, 33.94, -118.41, 64);
  for (let k = 2; k < pacific.length; k += 2) {
    assert.ok(Math.abs(pacific[k] - pacific[k - 2]) < 2_000_000, `continuous at step ${k / 2}`);
  }
  // The same point twice is a zero-length line, not NaN.
  const still = greatCircleFlat(40, -74, 40, -74);
  assert.equal(still.length, 4);
  assert.ok(still.every(Number.isFinite));
});
