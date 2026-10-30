import { useState, useEffect, useRef } from 'react';
import { useUnits } from '../context/UnitsContext';
import {
  WEATHER_SOUNDING_STORAGE_KEY,
  fetchSounding,
  getWeatherConfig,
} from '../api/settings';
import SoundingChart from './SoundingChart';
import './WeatherBadge.css';

function isNightTime(startTime) {
  if (!startTime) return false;
  const hour = new Date(startTime).getHours();
  return hour < 6 || hour >= 19;
}

// WMO weather code → emoji icon
function getWeatherIcon(wmoCode, night) {
  const code = Number(wmoCode);
  if (code <= 1) return night ? '\uD83C\uDF19' : '\u2600\uFE0F';        // Clear
  if (code === 2) return night ? '\uD83C\uDF19' : '\uD83C\uDF24\uFE0F';  // Partly cloudy
  if (code === 3) return '\u2601\uFE0F';         // Overcast
  if (code >= 45 && code <= 48) return '\uD83C\uDF2B\uFE0F'; // Fog
  if (code >= 51 && code <= 57) return '\uD83C\uDF27\uFE0F'; // Drizzle
  if (code >= 61 && code <= 67) return '\uD83C\uDF27\uFE0F'; // Rain
  if (code >= 71 && code <= 77) return '\uD83C\uDF28\uFE0F'; // Snow
  if (code >= 80 && code <= 82) return '\uD83C\uDF26\uFE0F'; // Rain showers
  if (code >= 85 && code <= 86) return '\uD83C\uDF28\uFE0F'; // Snow showers
  if (code >= 95) return '\u26C8\uFE0F';         // Thunderstorm
  return '\uD83C\uDF21\uFE0F';
}

// WMO weather code → short label
function getWeatherLabel(wmoCode) {
  const code = Number(wmoCode);
  if (code === 0) return 'Clear';
  if (code === 1) return 'Clear';
  if (code === 2) return 'Partly Cloudy';
  if (code === 3) return 'Overcast';
  if (code >= 45 && code <= 48) return 'Foggy';
  if (code >= 51 && code <= 55) return 'Drizzle';
  if (code >= 56 && code <= 57) return 'Freezing Drizzle';
  if (code >= 61 && code <= 65) return 'Rainy';
  if (code >= 66 && code <= 67) return 'Freezing Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code >= 85 && code <= 86) return 'Snow Showers';
  if (code >= 95) return 'Thunderstorm';
  return 'Unknown';
}

function formatReading(value, unit = '') {
  return value == null ? 'N/A' : `${value}${unit}`;
}

export default function WeatherBadge({ weather, startTime, lat, lon, overlay, routeId, hasSpeedData, heatmapEnabled, onToggleHeatmap }) {
  const { convertTemperature, convertSpeed, temperatureUnit, speedUnit } = useUnits();
  const [soundingOpen, setSoundingOpen] = useState(false);
  const [soundingData, setSoundingData] = useState(null);
  const [soundingLoading, setSoundingLoading] = useState(false);
  const [soundingError, setSoundingError] = useState(null);
  const [soundingEnabled, setSoundingEnabled] = useState(
    () => localStorage.getItem(WEATHER_SOUNDING_STORAGE_KEY) !== 'false'
  );
  const panelRef = useRef(null);

  // Reset sounding data when route changes
  useEffect(() => {
    setSoundingData(null);
    setSoundingError(null);
    setSoundingOpen(false);
  }, [lat, lon, startTime]);

  useEffect(() => {
    let cancelled = false;

    getWeatherConfig().then(config => {
      if (cancelled) return;
      const nextSoundingEnabled = config.weather_sounding_enabled !== 'false';
      setSoundingEnabled(nextSoundingEnabled);
      localStorage.setItem(WEATHER_SOUNDING_STORAGE_KEY, String(nextSoundingEnabled));
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!soundingEnabled) {
      setSoundingOpen(false);
    }
  }, [soundingEnabled]);

  const handleClick = async () => {
    if (!soundingEnabled) return;
    if (soundingOpen) {
      setSoundingOpen(false);
      return;
    }
    if (!routeId || !startTime) return;

    setSoundingOpen(true);
    if (soundingData) return; // already fetched

    setSoundingLoading(true);
    setSoundingError(null);
    try {
      const data = await fetchSounding(routeId);
      setSoundingData(data);
    } catch {
      setSoundingError('Failed to load sounding data');
    } finally {
      setSoundingLoading(false);
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!soundingOpen) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setSoundingOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [soundingOpen]);

  if (!weather && !hasSpeedData) return null;

  const night = weather ? isNightTime(startTime) : false;
  const icon = weather ? getWeatherIcon(weather.icon, night) : null;
  const label = weather ? ((night && Number(weather.icon) <= 1) ? 'Clear Night' : getWeatherLabel(weather.icon)) : null;
  const temp = weather ? convertTemperature(weather.temp) : null;
  const badgeFeelsLike = weather ? convertTemperature(weather.feelsLike) : null;
  const badgeWindSpeed = weather ? convertSpeed(weather.windSpeed) : null;
  const soundingSurface = soundingData?.surface;
  const detailTemp = weather ? convertTemperature(soundingSurface?.temp ?? weather.temp) : null;
  const detailFeelsLike = weather ? convertTemperature(soundingSurface?.feelsLike ?? weather.feelsLike) : null;
  const detailWindSpeed = weather ? convertSpeed(soundingSurface?.windSpeed ?? weather.windSpeed) : null;
  const detailHumidity = weather ? (soundingSurface?.humidity ?? weather.humidity) : null;

  return (
    <div className={`weather-badge${overlay ? ' weather-overlay' : ''}${soundingOpen ? ' sounding-active' : ''}`} ref={panelRef}>
      <div className="weather-badge-row">
        {weather && (
          <div className="weather-section">
            <div
              className="weather-main"
              onClick={soundingEnabled ? handleClick : undefined}
              style={{ cursor: soundingEnabled ? 'pointer' : 'default' }}
            >
              <span className="weather-temp">{temp}{temperatureUnit}</span>
              <span className="weather-icon">{icon}</span>
              <span className="weather-label">{label}</span>
            </div>
            {!soundingOpen && (
              <div className="weather-tooltip">
                <div className="weather-details">
                  <span>Feels like {formatReading(badgeFeelsLike, temperatureUnit)}</span>
                  <span>Wind: {badgeWindSpeed == null ? 'N/A' : `${badgeWindSpeed.toFixed(0)} ${speedUnit}`}</span>
                  <span>Humidity: {weather.humidity == null ? 'N/A' : `${weather.humidity}%`}</span>
                </div>
              </div>
            )}
          </div>
        )}
        {weather && hasSpeedData && <div className="weather-badge-divider" />}
        {hasSpeedData && (
          <button
            type="button"
            className={`weather-speed-toggle${heatmapEnabled ? ' active' : ''}`}
            onClick={onToggleHeatmap}
            title={heatmapEnabled ? 'Disable speed heatmap' : 'Enable speed heatmap'}
          >
            <span className="weather-speed-bar" />
            <span className="weather-speed-label">Speed</span>
          </button>
        )}
      </div>
      {weather && soundingOpen && (
        <div className="sounding-panel">
          <div className="sounding-header">
            <span className="sounding-title">Atmospheric Sounding</span>
            <button className="sounding-close" onClick={() => setSoundingOpen(false)}>&times;</button>
          </div>
          <div className="sounding-details">
            <span>Surface: {formatReading(detailTemp, temperatureUnit)}</span>
            <span>Feels like {formatReading(detailFeelsLike, temperatureUnit)}</span>
            <span>Wind: {detailWindSpeed == null ? 'N/A' : `${detailWindSpeed.toFixed(0)} ${speedUnit}`}</span>
            <span>Humidity: {detailHumidity == null ? 'N/A' : `${detailHumidity}%`}</span>
          </div>
          <div className="sounding-note">
            Chart temperatures are pressure-level values, not the 2 m surface temperature shown above.
          </div>
          {soundingLoading && <div className="sounding-loading"><span className="sounding-spinner" />Loading sounding data...</div>}
          {soundingError && <div className="sounding-error">{soundingError}</div>}
          {soundingData && <SoundingChart data={soundingData} />}
        </div>
      )}
    </div>
  );
}
