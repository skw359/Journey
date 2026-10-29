export const UNIT_PREFERENCES = Object.freeze({
  IMPERIAL: 'imperial',
  METRIC: 'metric',
});

const MI_TO_KM = 1.609344;
const M_TO_FT = 3.28084;
const FTPS2_TO_MPS2 = 0.3048;

function toFiniteNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeUnitPreference(value) {
  return value === UNIT_PREFERENCES.METRIC
    ? UNIT_PREFERENCES.METRIC
    : UNIT_PREFERENCES.IMPERIAL;
}

export function isMetricPreference(value) {
  return normalizeUnitPreference(value) === UNIT_PREFERENCES.METRIC;
}

export function getDistanceUnitLabel(unitPreference) {
  return isMetricPreference(unitPreference) ? 'km' : 'mi';
}

export function getSpeedUnitLabel(unitPreference) {
  return isMetricPreference(unitPreference) ? 'km/h' : 'mph';
}

export function getElevationUnitLabel(unitPreference) {
  return isMetricPreference(unitPreference) ? 'm' : 'ft';
}

export function getAccelerationUnitLabel(unitPreference) {
  return isMetricPreference(unitPreference) ? 'm/s\u00B2' : 'ft/s\u00B2';
}

export function getTemperatureUnitLabel(unitPreference) {
  return isMetricPreference(unitPreference) ? '\u00B0C' : '\u00B0F';
}

export function convertTemperatureFromF(value, unitPreference) {
  const f = toFiniteNumber(value);
  if (f === null) return null;
  return isMetricPreference(unitPreference) ? Math.round((f - 32) * 5 / 9) : f;
}

export function convertDistanceFromMiles(value, unitPreference) {
  const miles = toFiniteNumber(value);
  if (miles === null) return null;
  return isMetricPreference(unitPreference) ? miles * MI_TO_KM : miles;
}

export function convertSpeedFromMph(value, unitPreference) {
  const mph = toFiniteNumber(value);
  if (mph === null) return null;
  return isMetricPreference(unitPreference) ? mph * MI_TO_KM : mph;
}

export function convertElevationFromMeters(value, unitPreference) {
  const meters = toFiniteNumber(value);
  if (meters === null) return null;
  return isMetricPreference(unitPreference) ? meters : meters * M_TO_FT;
}

export function convertAccelerationFromFtPerSec2(value, unitPreference) {
  const ftPerSec2 = toFiniteNumber(value);
  if (ftPerSec2 === null) return null;
  return isMetricPreference(unitPreference) ? ftPerSec2 * FTPS2_TO_MPS2 : ftPerSec2;
}

export function toDisplayNumber(value, fractionDigits = 1) {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return null;
  return Number(parsed.toFixed(fractionDigits));
}
