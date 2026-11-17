import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertAccelerationFromFtPerSec2,
  convertDistanceFromMiles,
  convertElevationFromMeters,
  convertSpeedFromMph,
  convertTemperatureFromF,
  getAccelerationUnitLabel,
  getDistanceUnitLabel,
  getElevationUnitLabel,
  getSpeedUnitLabel,
  getTemperatureUnitLabel,
  isMetricPreference,
  normalizeUnitPreference,
  toDisplayNumber,
} from '../src/utils/units.js';

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);

test('anything but "metric" is imperial', () => {
  assert.equal(normalizeUnitPreference('metric'), 'metric');
  for (const other of ['imperial', 'Metric', '', null, undefined, 42]) {
    assert.equal(normalizeUnitPreference(other), 'imperial', String(other));
    assert.equal(isMetricPreference(other), false);
  }
  assert.equal(isMetricPreference('metric'), true);
});

test('unit labels follow the preference', () => {
  assert.deepEqual(
    [getDistanceUnitLabel, getSpeedUnitLabel, getElevationUnitLabel, getAccelerationUnitLabel, getTemperatureUnitLabel].map((label) => label('imperial')),
    ['mi', 'mph', 'ft', 'ft/s²', '°F'],
  );
  assert.deepEqual(
    [getDistanceUnitLabel, getSpeedUnitLabel, getElevationUnitLabel, getAccelerationUnitLabel, getTemperatureUnitLabel].map((label) => label('metric')),
    ['km', 'km/h', 'm', 'm/s²', '°C'],
  );
});

test('stored units convert only for the other system', () => {
  // Stored as miles, mph, metres, °F and ft/s².
  assert.equal(convertDistanceFromMiles(10, 'imperial'), 10);
  near(convertDistanceFromMiles(10, 'metric'), 16.09344, 'km');
  assert.equal(convertSpeedFromMph(60, 'imperial'), 60);
  near(convertSpeedFromMph(60, 'metric'), 96.56064, 'km/h');
  assert.equal(convertElevationFromMeters(1000, 'metric'), 1000);
  near(convertElevationFromMeters(1000, 'imperial'), 3280.84, 'ft');
  assert.equal(Math.round(convertElevationFromMeters(8849, 'imperial')), 29032, 'Everest in feet');
  assert.equal(convertTemperatureFromF(212, 'imperial'), 212);
  assert.equal(convertTemperatureFromF(212, 'metric'), 100);
  assert.equal(convertTemperatureFromF(32, 'metric'), 0);
  assert.equal(convertTemperatureFromF(-40, 'metric'), -40);
  assert.equal(convertTemperatureFromF(71, 'metric'), 22, 'rounded to a whole degree');
  assert.equal(convertAccelerationFromFtPerSec2(10, 'imperial'), 10);
  near(convertAccelerationFromFtPerSec2(10, 'metric'), 3.048, 'm/s²');
});

test('numbers sent as text convert like numbers', () => {
  // The API sends distances and speeds as strings ("12.34").
  near(convertDistanceFromMiles('12.34', 'metric'), 12.34 * 1.609344, 'km');
  assert.equal(convertSpeedFromMph('55.00', 'imperial'), 55);
  assert.equal(convertDistanceFromMiles(0, 'metric'), 0, 'a real zero stays zero');
  assert.equal(convertDistanceFromMiles('0', 'imperial'), 0);
});

test('a missing reading stays missing instead of becoming zero', () => {
  const converters = [
    convertDistanceFromMiles, convertSpeedFromMph, convertElevationFromMeters,
    convertTemperatureFromF, convertAccelerationFromFtPerSec2,
  ];
  for (const convert of converters) {
    for (const unit of ['imperial', 'metric']) {
      // Number(null) and Number('') are 0: a journey with no "feels like" must not read 0 °F (-18 °C).
      for (const missing of [null, undefined, '', '   ', 'n/a', NaN, Infinity, true, false, {}, []]) {
        assert.equal(convert(missing, unit), null, `${convert.name}(${JSON.stringify(missing)}, ${unit})`);
      }
    }
  }
});

test('toDisplayNumber rounds for display', () => {
  assert.equal(toDisplayNumber(3.14159), 3.1);
  assert.equal(toDisplayNumber('2.71828', 3), 2.718);
  assert.equal(toDisplayNumber(5, 0), 5);
  assert.equal(toDisplayNumber(null), null);
  assert.equal(toDisplayNumber('abc'), null);
});
