/**
 * Weather utility with configurable provider.
 * Reads settings from app_config table.
 *
 * Supported providers:
 *   - open-meteo  (default): Free, no API key, returns historical weather at journey time
 *   - openweather:           Requires API key, returns current weather at location
 */

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

async function fetchFromCustom(urlTemplate, lat, lon, startTime, apiKey) {
    if (!urlTemplate) throw new Error('Custom weather URL not configured');

    const date = new Date(startTime);
    const url = urlTemplate
        .replace(/\{lat\}/g, lat)
        .replace(/\{lon\}/g, lon)
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

async function fetchWeatherForCoord(lat, lon, startTime) {
    const config = await getWeatherConfig();
    if (!config.enabled) return null;

    if (config.provider === 'openweather') {
        return fetchFromOpenWeather(lat, lon, config.apiKey);
    }
    if (config.provider === 'custom') {
        return fetchFromCustom(config.customUrl, lat, lon, startTime, config.apiKey);
    }
    return fetchFromOpenMeteo(lat, lon, startTime);
}

async function fetchAndStoreWeather(userId, routeId, lat, lon, startTime) {
    const { withTenantClient } = require('../db');

    try {
        const weather = await fetchWeatherForCoord(lat, lon, startTime);
        if (!weather) return;

        await withTenantClient(userId, async (db) => {
            await db.query(`
                UPDATE routes SET
                    weather_temp = $1, weather_feels_like = $2,
                    weather_humidity = $3, weather_wind_speed = $4,
                    weather_wind_dir = $5,
                    weather_condition = $6, weather_description = $7,
                    weather_icon = $8
                WHERE id = $9
            `, [
                weather.temp, weather.feelsLike, weather.humidity,
                weather.windSpeed, weather.windDir ?? null,
                weather.condition, weather.description,
                weather.icon, routeId,
            ]);
        });
    } catch (err) {
        log.error(`could not fetch/store for journey #${routeId}`, err);
    }
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
            SELECT id, start_lat, start_lon, start_time FROM routes
            WHERE weather_temp IS NOT NULL AND weather_wind_dir IS NULL
              AND start_lat IS NOT NULL AND start_lon IS NOT NULL AND start_time IS NOT NULL
            ORDER BY start_time DESC
        `));
        pending += rows.length;

        for (const row of rows) {
            try {
                const weather = await fetchFromOpenMeteo(row.start_lat, row.start_lon, row.start_time);
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

module.exports = { fetchWeatherForCoord, fetchAndStoreWeather, backfillWindDirections, clearConfigCache, fetchSounding };
