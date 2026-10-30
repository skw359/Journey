/**
 * Weather utility with configurable provider.
 * Reads settings from app_config table.
 *
 * Supported providers:
 *   - open-meteo  (default): Free, no API key, returns historical weather at journey time
 *   - openweather:           Requires API key, returns current weather at location
 *
 * Weather is looked up for the start's city (resolveWeatherLocation), never the exact point.
 */

const { GEOCODE_BASE_URL } = require('../config');
const { haversine } = require('./geo');
const log = require('../utils/logger').scope('weather');

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_MS = 30_000; // refresh config from DB every 30s

function normalizeHourlyTime(value) {
    if (typeof value !== 'string') return Number.NaN;
    if (/Z$|[+-]\d{2}:\d{2}$/.test(value)) return Date.parse(value);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return Date.parse(`${value}:00Z`);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value)) return Date.parse(`${value}:00:00Z`);
    return Date.parse(value);
}

function findHourlyIndex(times, startTime) {
    if (!Array.isArray(times) || times.length === 0) return -1;

    const date = new Date(startTime);
    if (Number.isNaN(date.getTime())) return -1;

    const targetHour = date.toISOString().slice(0, 13);
    const exactIdx = times.findIndex(time => typeof time === 'string' && time.slice(0, 13) === targetHour);
    if (exactIdx !== -1) return exactIdx;

    const targetMs = date.getTime();
    let bestIdx = -1;
    let bestDelta = Number.POSITIVE_INFINITY;

    times.forEach((time, idx) => {
        const timeMs = normalizeHourlyTime(time);
        if (Number.isNaN(timeMs)) return;
        const delta = Math.abs(timeMs - targetMs);
        if (delta < bestDelta) {
            bestDelta = delta;
            bestIdx = idx;
        }
    });

    return bestIdx;
}

function roundOrNull(value) {
    return value == null ? null : Math.round(value);
}

function calculateDewpoint(tempF, rh) {
    if (tempF == null || rh == null || rh <= 0) return null;
    const tc = (tempF - 32) * 5 / 9;
    const a = 17.27;
    const b = 237.7;
    const alpha = (a * tc) / (b + tc) + Math.log(rh / 100);
    const dpC = (b * alpha) / (a - alpha);
    return dpC * 9 / 5 + 32;
}

async function getWeatherConfig() {
    if (_configCache && Date.now() - _configCacheTime < CONFIG_CACHE_MS) {
        return _configCache;
    }

    const { pool } = require('../db');
    const { rows } = await pool.query(
        "SELECT key, value FROM app_config WHERE key IN ('weather_enabled', 'weather_provider', 'weather_api_key', 'weather_custom_url')"
    );
    const config = { enabled: true, provider: 'open-meteo', apiKey: '', customUrl: '' };
    for (const row of rows) {
        if (row.key === 'weather_enabled') config.enabled = row.value !== 'false';
        if (row.key === 'weather_provider') config.provider = row.value || 'open-meteo';
        if (row.key === 'weather_api_key') config.apiKey = row.value || '';
        if (row.key === 'weather_custom_url') config.customUrl = row.value || '';
    }

    _configCache = config;
    _configCacheTime = Date.now();
    return config;
}

function clearConfigCache() {
    _configCache = null;
    _configCacheTime = 0;
}

// ── Location: the start's city, never the exact point ─────────────────

const GEOCODE_TIMEOUT_MS = 8000;
const CITY_SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
// A name-search result farther than this from the start is the wrong place.
const MAX_CITY_DISTANCE_KM = 60;
// Without a city, weather comes from the center of a 0.1° cell (~11 km).
const GRID_DEG = 0.1;
const CACHE_LIMIT = 2000;

const cityCentroids = new Map();
const weatherCache = new Map();

function remember(map, key, value) {
    if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value);
    map.set(key, value);
    return value;
}

let stateNames = null;
function stateName(code) {
    if (!stateNames) {
        stateNames = new Map();
        try {
            const fc = require('../data/us-states.geojson');
            for (const f of fc.features || []) stateNames.set(f.properties.code, f.properties.name);
        } catch {
            // without names, same-named cities are told apart by distance alone
        }
    }
    return stateNames.get(String(code || '').toUpperCase()) || null;
}

function gridLocation(lat, lon) {
    const snap = (v) => Number((Math.round(v / GRID_DEG) * GRID_DEG).toFixed(4));
    return { lat: snap(lat), lon: snap(lon), city: null, source: 'grid' };
}

function finiteOr(value) {
    const n = Number(value);
    return value != null && Number.isFinite(n) ? n : null;
}

// Asks the configured geocoder (our own service) for the start's city. A city_lat/city_lon
// (or city_center {lat, lon}) in its reply is used as the city's point.
async function lookupCity(lat, lon) {
    if (!GEOCODE_BASE_URL) return null;
    const res = await fetch(`${GEOCODE_BASE_URL}/lookup?lat=${lat}&lon=${lon}`, {
        signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const city = data.city && data.city !== 'unknown' ? String(data.city) : null;
    if (!city) return null;
    const centerLat = finiteOr(data.city_lat ?? data.city_center?.lat);
    const centerLon = finiteOr(data.city_lon ?? data.city_center?.lon);
    return {
        city,
        state: data.state_code || null,
        country: data.country_code || null,
        center: centerLat != null && centerLon != null ? { lat: centerLat, lon: centerLon } : null,
    };
}

// The city's point by name search (only the name is sent); among same-named places, the
// one in the right country/state nearest the start wins.
async function searchCityCenter({ city, state, country }, near) {
    const url = `${CITY_SEARCH_URL}?name=${encodeURIComponent(city)}&count=20&language=en&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const { results = [] } = await res.json();
    const region = stateName(state);
    let best = null;
    for (const r of results) {
        if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
        if (country && r.country_code && r.country_code.toUpperCase() !== String(country).toUpperCase()) continue;
        if (region && r.admin1 && r.admin1 !== region) continue;
        const km = haversine(near.lat, near.lon, r.latitude, r.longitude) * 1.609344;
        if (!best || km < best.km) best = { lat: r.latitude, lon: r.longitude, km };
    }
    return best && best.km <= MAX_CITY_DISTANCE_KM ? { lat: best.lat, lon: best.lon } : null;
}

/**
 * Where to fetch weather for a journey starting at (lat, lon): the start city's center, or
 * the center of its 0.1° cell when there's no city (rural, at sea, geocoder down).
 * @returns {Promise<{lat: number, lon: number, city: string|null, source: 'city'|'grid'}|null>}
 */
async function resolveWeatherLocation(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    try {
        const found = await lookupCity(lat, lon);
        if (found) {
            const key = [found.city, found.state, found.country].join('|').toLowerCase();
            const label = [found.city, found.state || found.country].filter(Boolean).join(', ');
            let center = found.center || cityCentroids.get(key);
            if (!center) {
                center = await searchCityCenter(found, { lat, lon });
                if (center) remember(cityCentroids, key, center);
            }
            if (center) {
                return { lat: Math.round(center.lat * 1e4) / 1e4, lon: Math.round(center.lon * 1e4) / 1e4, city: label, source: 'city' };
            }
        }
    } catch (err) {
        log.debug(`city lookup failed, using the coarse grid: ${err.message}`);
    }
    return gridLocation(lat, lon);
}

// ── Open-Meteo (free, historical forecast) ─────────────────────────────

async function fetchFromOpenMeteo(lat, lon, startTime) {
    const date = new Date(startTime);
    const dateStr = date.toISOString().slice(0, 10);
    const hourlyVars = [
        'temperature_2m',
        'apparent_temperature',
        'relative_humidity_2m',
        'wind_speed_10m',
        'wind_direction_10m',
        'weather_code',
    ].join(',');

    const url = `https://historical-forecast-api.open-meteo.com/v1/forecast`
        + `?latitude=${lat}&longitude=${lon}`
        + `&start_date=${dateStr}&end_date=${dateStr}`
        + `&hourly=${hourlyVars}`
        + `&temperature_unit=fahrenheit&wind_speed_unit=mph`
        + `&timezone=GMT`;

    const response = await fetch(url);
    if (!response.ok) {
        const err = new Error(`Open-Meteo historical forecast error: ${response.status}`);
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    const hourly = data.hourly;
    if (!hourly || !hourly.time || hourly.time.length === 0) return null;

    const idx = findHourlyIndex(hourly.time, startTime);
    if (idx === -1) return null;
    const temp = hourly.temperature_2m[idx];
    if (temp == null) return null;

    return {
        temp: roundOrNull(temp),
        feelsLike: roundOrNull(hourly.apparent_temperature[idx]),
        humidity: roundOrNull(hourly.relative_humidity_2m[idx]),
        windSpeed: roundOrNull(hourly.wind_speed_10m[idx]),
        windDir: roundOrNull(hourly.wind_direction_10m?.[idx]),
        condition: wmoToCondition(hourly.weather_code[idx]),
        description: wmoToDescription(hourly.weather_code[idx]),
        icon: String(hourly.weather_code[idx]),
    };
}

function wmoToCondition(code) {
    if (code <= 1) return 'Clear';
    if (code === 2) return 'Clouds';
    if (code === 3) return 'Clouds';
    if (code >= 45 && code <= 48) return 'Fog';
    if (code >= 51 && code <= 57) return 'Drizzle';
    if (code >= 61 && code <= 67) return 'Rain';
    if (code >= 71 && code <= 77) return 'Snow';
    if (code >= 80 && code <= 82) return 'Rain';
    if (code >= 85 && code <= 86) return 'Snow';
    if (code >= 95) return 'Thunderstorm';
    return 'Unknown';
}

function wmoToDescription(code) {
    const descriptions = {
        0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
        45: 'fog', 48: 'depositing rime fog',
        51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
        56: 'light freezing drizzle', 57: 'dense freezing drizzle',
        61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
        66: 'light freezing rain', 67: 'heavy freezing rain',
        71: 'slight snow', 73: 'moderate snow', 75: 'heavy snow', 77: 'snow grains',
        80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
        85: 'slight snow showers', 86: 'heavy snow showers',
        95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
    };
    return descriptions[code] || 'unknown';
}

// ── OpenWeather (requires API key, current weather) ────────────────────

async function fetchFromOpenWeather(lat, lon, apiKey) {
    if (!apiKey) throw new Error('OpenWeather API key not configured');

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=imperial&appid=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`OpenWeather API error: ${response.status}`);

    const data = await response.json();
    const iconCode = data.weather[0].icon;

    return {
        temp: Math.round(data.main.temp),
        feelsLike: Math.round(data.main.feels_like),
        humidity: data.main.humidity,
        windSpeed: Math.round(data.wind.speed),
        windDir: roundOrNull(data.wind.deg),
        condition: data.weather[0].main,
        description: data.weather[0].description,
        icon: owIconToWmo(iconCode),
    };
}

// Map OpenWeather icon codes to WMO codes so the frontend only handles one format
function owIconToWmo(iconCode) {
    const map = {
        '01d': '0', '01n': '0',
        '02d': '2', '02n': '2',
        '03d': '3', '03n': '3',
        '04d': '3', '04n': '3',
        '09d': '80', '09n': '80',
        '10d': '61', '10n': '61',
        '11d': '95', '11n': '95',
        '13d': '71', '13n': '71',
        '50d': '45', '50n': '45',
    };
    return map[iconCode] || '0';
}

// ── Custom URL provider ────────────────────────────────────────────────

async function fetchFromCustom(urlTemplate, lat, lon, startTime, apiKey, city) {
    if (!urlTemplate) throw new Error('Custom weather URL not configured');

    const date = new Date(startTime);
    const url = urlTemplate
        .replace(/\{lat\}/g, lat)
        .replace(/\{lon\}/g, lon)
        .replace(/\{city\}/g, encodeURIComponent(city || ''))
        .replace(/\{date\}/g, date.toISOString().slice(0, 10))
        .replace(/\{timestamp\}/g, date.toISOString())
        .replace(/\{api_key\}/g, encodeURIComponent(apiKey || ''));

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Custom weather API error: ${response.status}`);

    const data = await response.json();

    // Accept flexible field names from external APIs
    return {
        temp: Math.round(data.temp ?? data.temperature ?? 0),
        feelsLike: Math.round(data.feelsLike ?? data.feels_like ?? data.temp ?? data.temperature ?? 0),
        humidity: Math.round(data.humidity ?? data.relative_humidity ?? 0),
        windSpeed: Math.round(data.windSpeed ?? data.wind_speed ?? 0),
        windDir: roundOrNull(data.windDir ?? data.wind_dir ?? data.wind_deg),
        condition: data.condition ?? data.weather ?? 'Unknown',
        description: data.description ?? data.condition ?? data.weather ?? 'unknown',
        icon: String(data.icon ?? data.weather_code ?? data.code ?? '0'),
    };
}

// ── Public API ─────────────────────────────────────────────────────────

/** Weather at a resolved location (see resolveWeatherLocation), cached by place and hour. */
async function fetchWeatherForLocation(location, startTime) {
    const config = await getWeatherConfig();
    if (!config.enabled || !location) return null;

    const hour = new Date(startTime).toISOString().slice(0, 13);
    const key = `${config.provider}|${location.lat},${location.lon}|${hour}`;
    if (weatherCache.has(key)) return weatherCache.get(key);

    let weather;
    if (config.provider === 'openweather') {
        weather = await fetchFromOpenWeather(location.lat, location.lon, config.apiKey);
    } else if (config.provider === 'custom') {
        weather = await fetchFromCustom(config.customUrl, location.lat, location.lon, startTime, config.apiKey, location.city);
    } else {
        weather = await fetchFromOpenMeteo(location.lat, location.lon, startTime);
    }
    // OpenWeather returns current conditions, which mustn't be reused for another hour.
    if (weather && config.provider !== 'openweather') remember(weatherCache, key, weather);
    return weather;
}

async function fetchAndStoreWeather(userId, routeId, lat, lon, startTime) {
    const { withTenantClient } = require('../db');

    try {
        const config = await getWeatherConfig();
        if (!config.enabled) return;
        const location = await resolveWeatherLocation(Number(lat), Number(lon));
        const weather = await fetchWeatherForLocation(location, startTime);
        if (!weather) return;

        await withTenantClient(userId, async (db) => {
            await db.query(`
                UPDATE routes SET
                    weather_temp = $1, weather_feels_like = $2,
                    weather_humidity = $3, weather_wind_speed = $4,
                    weather_wind_dir = $5,
                    weather_condition = $6, weather_description = $7,
                    weather_icon = $8,
                    weather_city = $10, weather_lat = $11, weather_lon = $12
                WHERE id = $9
            `, [
                weather.temp, weather.feelsLike, weather.humidity,
                weather.windSpeed, weather.windDir ?? null,
                weather.condition, weather.description,
                weather.icon, routeId,
                location.city, location.lat, location.lon,
            ]);
        });
    } catch (err) {
        log.error(`could not fetch/store for journey #${routeId}`, err);
    }
}

// A journey's stored weather location, resolved (and stored) when missing.
async function weatherLocationForRow(userId, row) {
    if (row.weather_lat != null && row.weather_lon != null) {
        return { lat: row.weather_lat, lon: row.weather_lon, city: row.weather_city || null };
    }
    const location = await resolveWeatherLocation(row.start_lat, row.start_lon);
    if (location) {
        const { withTenantClient } = require('../db');
        await withTenantClient(userId, (db) => db.query(
            'UPDATE routes SET weather_city = $2, weather_lat = $3, weather_lon = $4 WHERE id = $1',
            [row.id, location.city, location.lat, location.lon]
        ));
    }
    return location;
}

// Spacing between backfill requests, keeping well under Open-Meteo's free
// limit of 600 calls a minute.
const WIND_DIR_BACKFILL_DELAY_MS = 200;

/**
 * Fill in wind direction for journeys whose weather was stored before it was
 * recorded. Only Open-Meteo can look up weather at a past time, so it's used
 * whichever provider is configured (as soundings already are). Journeys it
 * has no data for stay NULL and are tried again on the next run.
 */
async function backfillWindDirections() {
    const config = await getWeatherConfig();
    if (!config.enabled) return { filled: 0, pending: 0 };

    const { pool, withTenantClient } = require('../db');
    const { rows: users } = await pool.query('SELECT id FROM users');
    let filled = 0;
    let pending = 0;

    for (const user of users) {
        const { rows } = await withTenantClient(user.id, (db) => db.query(`
            SELECT id, start_lat, start_lon, start_time, weather_city, weather_lat, weather_lon FROM routes
            WHERE weather_temp IS NOT NULL AND weather_wind_dir IS NULL
              AND start_lat IS NOT NULL AND start_lon IS NOT NULL AND start_time IS NOT NULL
            ORDER BY start_time DESC
        `));
        pending += rows.length;

        for (const row of rows) {
            try {
                const location = await weatherLocationForRow(user.id, row);
                const weather = location && await fetchFromOpenMeteo(location.lat, location.lon, row.start_time);
                if (weather?.windDir != null) {
                    await withTenantClient(user.id, (db) => db.query(
                        'UPDATE routes SET weather_wind_dir = $1 WHERE id = $2',
                        [weather.windDir, row.id],
                    ));
                    filled += 1;
                }
            } catch (err) {
                // Rate limited: stop here and pick the rest up next run
                if (err.status === 429) return { filled, pending };
                log.debug(`no wind direction for journey #${row.id}: ${err.message}`);
            }
            await new Promise((resolve) => setTimeout(resolve, WIND_DIR_BACKFILL_DELAY_MS));
        }
    }

    return { filled, pending };
}

// ── Atmospheric Sounding (pressure-level profile) ─────────────────────

const PRESSURE_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];

async function fetchSounding(lat, lon, startTime) {
    const date = new Date(startTime);
    const dateStr = date.toISOString().slice(0, 10);

    const tempVars = PRESSURE_LEVELS.map(p => `temperature_${p}hPa`).join(',');
    const rhVars = PRESSURE_LEVELS.map(p => `relative_humidity_${p}hPa`).join(',');
    const wsVars = PRESSURE_LEVELS.map(p => `wind_speed_${p}hPa`).join(',');
    const wdVars = PRESSURE_LEVELS.map(p => `wind_direction_${p}hPa`).join(',');
    const surfaceVars = [
        'temperature_2m',
        'apparent_temperature',
        'relative_humidity_2m',
        'wind_speed_10m',
        'surface_pressure',
    ].join(',');

    // Use historical-forecast API (supports pressure levels, unlike the archive API)
    const url = `https://historical-forecast-api.open-meteo.com/v1/forecast`
        + `?latitude=${lat}&longitude=${lon}`
        + `&start_date=${dateStr}&end_date=${dateStr}`
        + `&hourly=${surfaceVars},${tempVars},${rhVars},${wsVars},${wdVars}`
        + `&temperature_unit=fahrenheit&wind_speed_unit=mph`
        + `&timezone=GMT`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo sounding error: ${response.status}`);

    const data = await response.json();
    const hourly = data.hourly;
    if (!hourly || !hourly.time || hourly.time.length === 0) return null;

    const idx = findHourlyIndex(hourly.time, startTime);
    if (idx === -1) return null;

    const levels = PRESSURE_LEVELS.map(p => {
        const temp = hourly[`temperature_${p}hPa`]?.[idx];
        const rh = hourly[`relative_humidity_${p}hPa`]?.[idx];
        const ws = hourly[`wind_speed_${p}hPa`]?.[idx];
        const wd = hourly[`wind_direction_${p}hPa`]?.[idx];
        const dewpoint = calculateDewpoint(temp, rh);

        return {
            pressure: p,
            temp: roundOrNull(temp),
            dewpoint: roundOrNull(dewpoint),
            windSpeed: roundOrNull(ws),
            windDir: roundOrNull(wd),
        };
    }).filter(l => l.temp != null);

    const surfaceTemp = hourly.temperature_2m?.[idx];
    const surfaceRh = hourly.relative_humidity_2m?.[idx];
    const surfaceDewpoint = calculateDewpoint(surfaceTemp, surfaceRh);

    return {
        levels,
        time: hourly.time[idx],
        surface: {
            pressure: roundOrNull(hourly.surface_pressure?.[idx]),
            temp: roundOrNull(surfaceTemp),
            feelsLike: roundOrNull(hourly.apparent_temperature?.[idx]),
            humidity: roundOrNull(surfaceRh),
            dewpoint: roundOrNull(surfaceDewpoint),
            windSpeed: roundOrNull(hourly.wind_speed_10m?.[idx]),
        },
    };
}

/**
 * The pressure-level sounding for a journey at its start city and time, cached on the
 * journey after the first lookup.
 * @returns {Promise<{status: 'ok'|'not_found', sounding?: object|null}>}
 */
async function soundingForRoute(userId, routeId) {
    const { queryTenant } = require('../db');
    const { rows: [row] } = await queryTenant(userId, `
        SELECT id, sounding_data, start_lat, start_lon, start_time, weather_city, weather_lat, weather_lon
        FROM routes WHERE id = $1
    `, [routeId]);
    if (!row) {
        // A journey in Recently Deleted (looked up by its trash id); nothing is cached for it.
        const { rows: [trashed] } = await queryTenant(userId, "SELECT snapshot->'route' AS route FROM trashed_journeys WHERE id = $1", [routeId]);
        if (!trashed?.route) return { status: 'not_found' };
        const r = trashed.route;
        if (r.sounding_data) return { status: 'ok', sounding: r.sounding_data };
        if (r.start_time == null || r.start_lat == null) return { status: 'ok', sounding: null };
        const location = r.weather_lat != null
            ? { lat: r.weather_lat, lon: r.weather_lon }
            : await resolveWeatherLocation(r.start_lat, r.start_lon);
        return { status: 'ok', sounding: location ? await fetchSounding(location.lat, location.lon, r.start_time) : null };
    }
    if (row.sounding_data != null) return { status: 'ok', sounding: row.sounding_data };
    if (row.start_time == null || row.start_lat == null || row.start_lon == null) return { status: 'ok', sounding: null };

    const location = await weatherLocationForRow(userId, row);
    const sounding = location ? await fetchSounding(location.lat, location.lon, row.start_time) : null;
    if (sounding) {
        queryTenant(userId, 'UPDATE routes SET sounding_data = $1 WHERE id = $2', [JSON.stringify(sounding), routeId])
            .catch((err) => log.error('Failed to cache sounding data:', err));
    }
    return { status: 'ok', sounding };
}

module.exports = {
    resolveWeatherLocation,
    fetchWeatherForLocation,
    fetchAndStoreWeather,
    backfillWindDirections,
    clearConfigCache,
    fetchSounding,
    soundingForRoute,
};
