import { useCallback, useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useUnits } from '../context/UnitsContext';
import Modal from '../components/Modal';
import AttachmentStoragePanel from '../components/AttachmentStoragePanel';
import { UNIT_PREFERENCES } from '../utils/units';
import { formatBytes } from '../utils/formatters';
import {
  WEATHER_SOUNDING_STORAGE_KEY,
  getDatabaseConfig,
  getStorageUsage,
  updateDatabaseConfig,
  testDatabaseConnection,
  getWeatherConfig,
  updateWeatherConfig,
  getFlightConfig,
  updateFlightConfig,
} from '../api/settings';
import { uploadAvatar } from '../api/auth';
import { getMarcoConfig, updateMarcoConfig, testMarcoConnection } from '../api/ask';
import './Settings.css';

// Label stays in layout (hidden) while loading so the button keeps its size.
function BtnLabel({ loading, children }) {
  return (
    <>
      <span className={`settings-btn-label${loading ? ' is-hidden' : ''}`}>{children}</span>
      {loading && <span className="settings-btn-spinner" role="status" aria-label="Working" />}
    </>
  );
}

export default function Settings() {
  const { theme, toggleTheme } = useTheme();
  const { user, logout, updateUser, deleteAccount, setMarcoEnabled: setMarcoNavEnabled } = useAuth();
  const { isMetric, setUnitPreference } = useUnits();
  const avatarInputRef = useRef(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [unitPreferenceSaving, setUnitPreferenceSaving] = useState(false);
  const [unitPreferenceError, setUnitPreferenceError] = useState('');

  // Database config state
  const [dbHost, setDbHost] = useState('');
  const [dbPort, setDbPort] = useState('5432');
  const [dbName, setDbName] = useState('');
  const [dbUser, setDbUser] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [dbTestResult, setDbTestResult] = useState(null);
  const [dbSaving, setDbSaving] = useState(false);
  const [dbTesting, setDbTesting] = useState(false);
  const [preloadData, setPreloadData] = useState(() => localStorage.getItem('preloadData') === 'true');

  // Storage usage state
  const [storage, setStorage] = useState(null);
  const [storageError, setStorageError] = useState('');

  // Weather config state
  const [weatherEnabled, setWeatherEnabled] = useState(true);
  const [weatherProvider, setWeatherProvider] = useState('open-meteo');
  const [weatherApiKey, setWeatherApiKey] = useState('');
  const [weatherCustomUrl, setWeatherCustomUrl] = useState('');
  const [weatherSoundingEnabled, setWeatherSoundingEnabled] = useState(
    () => localStorage.getItem(WEATHER_SOUNDING_STORAGE_KEY) !== 'false'
  );
  const [weatherSoundingSaving, setWeatherSoundingSaving] = useState(false);
  const [weatherSoundingError, setWeatherSoundingError] = useState('');
  const [weatherSaving, setWeatherSaving] = useState(false);
  const [weatherResult, setWeatherResult] = useState(null);
  const weatherSoundingTouchedRef = useRef(false);

  // Flight config state
  const [flightApiKey, setFlightApiKey] = useState('');
  const [flightSaving, setFlightSaving] = useState(false);
  const [flightResult, setFlightResult] = useState(null);

  // Journey AI (Marco) config state
  const [marcoEnabled, setMarcoEnabled] = useState(false);
  const [marcoUrl, setMarcoUrl] = useState('');
  const [marcoModel, setMarcoModel] = useState('');
  const [marcoDefaultModel, setMarcoDefaultModel] = useState('gemma4:e4b');
  const [marcoTimeoutS, setMarcoTimeoutS] = useState('');
  const [marcoTimeoutMeta, setMarcoTimeoutMeta] = useState({ def: 120, min: 10, max: 600 });
  const [marcoTesting, setMarcoTesting] = useState(false);
  const [marcoSaving, setMarcoSaving] = useState(false);
  const [marcoResult, setMarcoResult] = useState(null);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);


  useEffect(() => {
    getDatabaseConfig().then(config => {
      if (config.db_host) setDbHost(config.db_host);
      if (config.db_port) setDbPort(config.db_port);
      if (config.db_name) setDbName(config.db_name);
      if (config.db_user) setDbUser(config.db_user);
    }).catch(() => {});

    getFlightConfig().then(config => {
      if (config.flightaware_api_key) setFlightApiKey(config.flightaware_api_key);
    }).catch(() => {});

    getMarcoConfig().then(config => {
      setMarcoEnabled(Boolean(config.enabled));
      if (config.url) setMarcoUrl(config.url);
      if (config.model) setMarcoModel(config.model);
      if (config.defaultModel) setMarcoDefaultModel(config.defaultModel);
      if (config.timeoutS != null) setMarcoTimeoutS(String(config.timeoutS));
      setMarcoTimeoutMeta(prev => ({
        def: config.defaultTimeoutS ?? prev.def,
        min: config.minTimeoutS ?? prev.min,
        max: config.maxTimeoutS ?? prev.max,
      }));
    }).catch(() => {});

    getWeatherConfig().then(config => {
      setWeatherEnabled(config.weather_enabled !== 'false');
      if (config.weather_provider) setWeatherProvider(config.weather_provider);
      if (config.weather_custom_url) setWeatherCustomUrl(config.weather_custom_url);
      const nextSoundingEnabled = config.weather_sounding_enabled !== 'false';
      if (!weatherSoundingTouchedRef.current) {
        setWeatherSoundingEnabled(nextSoundingEnabled);
        localStorage.setItem(WEATHER_SOUNDING_STORAGE_KEY, String(nextSoundingEnabled));
      }
    }).catch(() => {});
  }, []);

  const loadStorage = useCallback(() => {
    getStorageUsage()
      .then(data => { setStorage(data); setStorageError(''); })
      .catch(err => setStorageError(err.message || 'Failed to get storage usage'));
  }, []);

  useEffect(() => { loadStorage(); }, [loadStorage]);

  const handleWeatherSoundingToggle = async (event) => {
    const nextValue = event.target.checked;
    const previousValue = weatherSoundingEnabled;

    weatherSoundingTouchedRef.current = true;
    setWeatherSoundingEnabled(nextValue);
    setWeatherSoundingSaving(true);
    setWeatherSoundingError('');
    localStorage.setItem(WEATHER_SOUNDING_STORAGE_KEY, String(nextValue));

    try {
      await updateWeatherConfig({ soundingEnabled: nextValue });
      setWeatherResult(null);
    } catch (err) {
      setWeatherSoundingEnabled(previousValue);
      setWeatherSoundingError(err.message || 'Failed to save atmospheric sounding setting');
      localStorage.setItem(WEATHER_SOUNDING_STORAGE_KEY, String(previousValue));
    } finally {
      setWeatherSoundingSaving(false);
    }
  };

  const handleUnitToggle = async (event) => {
    const nextPreference = event.target.checked
      ? UNIT_PREFERENCES.METRIC
      : UNIT_PREFERENCES.IMPERIAL;
    setUnitPreferenceError('');
    setUnitPreferenceSaving(true);
    try {
      await setUnitPreference(nextPreference);
    } catch (err) {
      setUnitPreferenceError(err.message || 'Failed to save unit preference');
    } finally {
      setUnitPreferenceSaving(false);
    }
  };

  const getDbConfig = () => ({
    host: dbHost,
    port: dbPort,
    database: dbName,
    username: dbUser,
    password: dbPassword,
  });

  const handleTestConnection = async () => {
    setDbTesting(true);
    setDbTestResult(null);
    try {
      const result = await testDatabaseConnection(getDbConfig());
      setDbTestResult(result);
    } catch {
      setDbTestResult({ success: false, error: 'Connection test failed' });
    } finally {
      setDbTesting(false);
    }
  };

  const handleSaveDatabase = async () => {
    setDbSaving(true);
    setDbTestResult(null);
    try {
      await updateDatabaseConfig(getDbConfig());
      setDbTestResult({ success: true, message: 'Connected and saved' });
      loadStorage();
    } catch (err) {
      setDbTestResult({ success: false, error: err.message });
    } finally {
      setDbSaving(false);
    }
  };

  const handleAvatarClick = () => {
    avatarInputRef.current?.click();
  };

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      const data = await uploadAvatar(file);
      updateUser({ avatarUrl: data.avatarUrl });
    } catch (err) {
      console.error('Avatar upload failed:', err);
    } finally {
      setAvatarUploading(false);
      e.target.value = '';
    }
  };

  const handleSaveWeather = async () => {
    setWeatherSaving(true);
    setWeatherResult(null);
    try {
      const payload = {
        enabled: weatherEnabled,
        provider: weatherProvider,
        soundingEnabled: weatherSoundingEnabled,
      };
      if (weatherApiKey && !weatherApiKey.startsWith('\u2022')) {
        payload.apiKey = weatherApiKey;
      }
      if (weatherProvider === 'custom') {
        payload.customUrl = weatherCustomUrl;
      }
      await updateWeatherConfig(payload);
      localStorage.setItem(WEATHER_SOUNDING_STORAGE_KEY, String(weatherSoundingEnabled));
      setWeatherResult({ success: true, message: 'Weather settings saved' });
      if (weatherApiKey && !weatherApiKey.startsWith('\u2022')) {
        setWeatherApiKey('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
      }
    } catch (err) {
      setWeatherResult({ success: false, error: err.message });
    } finally {
      setWeatherSaving(false);
    }
  };

  const handleSaveFlight = async () => {
    setFlightSaving(true);
    setFlightResult(null);
    try {
      const payload = {};
      if (flightApiKey && !flightApiKey.startsWith('\u2022')) {
        payload.apiKey = flightApiKey;
      }
      await updateFlightConfig(payload);
      setFlightResult({ success: true, message: 'Flight settings saved' });
      if (flightApiKey && !flightApiKey.startsWith('\u2022')) {
        setFlightApiKey('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
      }
    } catch (err) {
      setFlightResult({ success: false, error: err.message });
    } finally {
      setFlightSaving(false);
    }
  };

  const handleTestMarco = async () => {
    setMarcoTesting(true);
    setMarcoResult(null);
    try {
      const result = await testMarcoConnection({ url: marcoUrl, model: marcoModel || marcoDefaultModel });
      setMarcoResult(result.success
        ? { success: true, message: result.message }
        : { success: false, error: result.message || result.error || 'Connection test failed' });
    } catch {
      setMarcoResult({ success: false, error: 'Connection test failed' });
    } finally {
      setMarcoTesting(false);
    }
  };

  const handleSaveMarco = async () => {
    setMarcoSaving(true);
    setMarcoResult(null);
    try {
      const saved = await updateMarcoConfig({
        enabled: marcoEnabled,
        url: marcoUrl,
        model: marcoModel || marcoDefaultModel,
        timeoutS: marcoTimeoutS,
      });
      setMarcoUrl(saved.url || '');
      setMarcoModel(saved.model || '');
      if (saved.timeoutS != null) setMarcoTimeoutS(String(saved.timeoutS));
      setMarcoNavEnabled(Boolean(saved.enabled));
      setMarcoResult({
        success: true,
        message: saved.enabled
          ? 'Journey AI is on — ask Marco anything from the Marco tab'
          : 'Journey AI settings saved (currently off)',
      });
    } catch (err) {
      setMarcoResult({ success: false, error: err.message });
    } finally {
      setMarcoSaving(false);
    }
  };

  const handleDeleteModalOpen = () => {
    setDeletePassword('');
    setDeleteError('');
    setDeleteModalOpen(true);
  };

  const handleDeleteModalClose = () => {
    if (deleteLoading) return;
    setDeleteModalOpen(false);
    setDeletePassword('');
    setDeleteError('');
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) {
      setDeleteError('Please enter your password to confirm account deletion');
      return;
    }

    setDeleteLoading(true);
    setDeleteError('');
    try {
      await deleteAccount(deletePassword);
      setDeleteModalOpen(false);
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete account');
    } finally {
      setDeleteLoading(false);
    }
  };

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.displayName || user?.username;
  const initials = [user?.firstName, user?.lastName]
    .filter(Boolean)
    .map(n => n[0]?.toUpperCase())
    .join('') || user?.username?.[0]?.toUpperCase() || '?';
  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  const dbBytes = storage?.database.bytes || 0;
  const accountBytes = storage?.account.bytes || 0;
  const photoBytes = storage?.photos.bytes || 0;
  const accountShare = dbBytes > 0 ? Math.min(100, (accountBytes / dbBytes) * 100) : 0;

  return (
    <div id="main-app" className="settings-page">
      <main className="settings-main">
        <section className="settings-panel">
          <div className="settings-profile-header">
            <button
              className={`settings-profile-avatar-btn${avatarUploading ? ' uploading' : ''}`}
              onClick={handleAvatarClick}
              disabled={avatarUploading}
              title="Change profile picture"
            >
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="settings-profile-avatar-img" />
              ) : (
                <span className="settings-profile-avatar-initials">{initials}</span>
              )}
              <span className="settings-profile-avatar-overlay">
                {avatarUploading ? <span className="settings-btn-spinner" role="status" aria-label="Uploading" /> : 'Edit'}
              </span>
            </button>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg"
              onChange={handleAvatarChange}
              hidden
            />
            <div className="settings-profile-info">
              <h1 className="settings-profile-name">{fullName}</h1>
              <span className="settings-profile-username">{user?.username}</span>
              {memberSince && (
                <span className="settings-profile-member-since">Member since {memberSince}</span>
              )}
            </div>
          </div>

          <label className="settings-item" htmlFor="theme-toggle">
            <div className="settings-item-copy">
              <span className="settings-item-title">Light / Dark theme</span>
              <span className="settings-item-detail">
                {theme === 'dark' ? 'Dark mode is active.' : 'Light mode is active.'}
              </span>
            </div>
            <span className="settings-switch">
              <input
                id="theme-toggle"
                type="checkbox"
                checked={theme === 'dark'}
                onChange={toggleTheme}
              />
              <span className="settings-slider" />
            </span>
          </label>

          <label className="settings-item" htmlFor="unit-toggle">
            <div className="settings-item-copy">
              <span className="settings-item-title">Metric / Imperial units</span>
              <span className="settings-item-detail">
                {isMetric
                  ? 'Showing km, km/h, m, and m/s\u00B2.'
                  : 'Showing mi, mph, ft, and ft/s\u00B2.'}
                {unitPreferenceSaving ? ' Saving...' : ''}
              </span>
            </div>
            <span className="settings-switch">
              <input
                id="unit-toggle"
                type="checkbox"
                checked={isMetric}
                onChange={handleUnitToggle}
                disabled={unitPreferenceSaving}
              />
              <span className="settings-slider" />
            </span>
          </label>
          {unitPreferenceError && <div className="settings-inline-error">{unitPreferenceError}</div>}

          <label className="settings-item" htmlFor="preload-toggle">
            <div className="settings-item-copy">
              <span className="settings-item-title">Preload journey data</span>
              <span className="settings-item-detail">
                Use full-resolution data for Atlas and Top Journeys on startup. Uses more resources and bandwidth. It's recommended to leave this option off.
              </span>
            </div>
            <span className="settings-switch">
              <input
                id="preload-toggle"
                type="checkbox"
                checked={preloadData}
                onChange={(e) => {
                  const val = e.target.checked;
                  localStorage.setItem('preloadData', val ? 'true' : 'false');
                  setPreloadData(val);
                }}
              />
              <span className="settings-slider" />
            </span>
          </label>

        </section>

        <section className="settings-panel" style={{ marginTop: 24 }}>
          <h2 className="settings-section-title">Client Pairing</h2>
          <p className="settings-description">
            Pair your iPhone or Apple Watch with this server using a QR code.
          </p>
          <div style={{ marginTop: 16 }}>
            <Link to="/pair" className="settings-btn settings-btn-primary" style={{ textDecoration: 'none', display: 'inline-block' }}>
              Open Pairing
            </Link>
          </div>
        </section>

        <section className="settings-panel" style={{ marginTop: 24 }}>
          <h2 className="settings-section-title">Weather API</h2>
          <p className="settings-description">
            Configure the weather data provider for journey weather information.
          </p>

          <label className="settings-item" htmlFor="weather-toggle">
            <div className="settings-item-copy">
              <span className="settings-item-title">Enable weather data</span>
              <span className="settings-item-detail">
                Automatically fetch weather conditions when new journeys are uploaded.
              </span>
            </div>
            <span className="settings-switch">
              <input
                id="weather-toggle"
                type="checkbox"
                checked={weatherEnabled}
                onChange={(e) => setWeatherEnabled(e.target.checked)}
              />
              <span className="settings-slider" />
            </span>
          </label>

          <label className="settings-item" htmlFor="weather-sounding-toggle">
            <div className="settings-item-copy">
              <span className="settings-item-title">Show atmospheric sounding on click</span>
              <span className="settings-item-detail">
                {weatherSoundingEnabled
                  ? 'Clicking the weather badge opens the atmospheric sounding chart and details.'
                  : 'Clicking the weather badge stays on the basic weather summary only.'}
                {weatherSoundingSaving ? ' Saving...' : ''}
              </span>
            </div>
            <span className="settings-switch">
              <input
                id="weather-sounding-toggle"
                type="checkbox"
                checked={weatherSoundingEnabled}
                onChange={handleWeatherSoundingToggle}
                disabled={weatherSoundingSaving}
              />
              <span className="settings-slider" />
            </span>
          </label>
          {weatherSoundingError && <div className="settings-inline-error">{weatherSoundingError}</div>}

          {weatherEnabled && (
            <>
              <div className="settings-form-group">
                <label className="settings-field-label" htmlFor="weather-provider">Provider</label>
                <select
                  id="weather-provider"
                  className="settings-input"
                  value={weatherProvider}
                  onChange={(e) => { setWeatherProvider(e.target.value); setWeatherApiKey(''); }}
                >
                  <option value="open-meteo">Open-Meteo (free, no API key)</option>
                  <option value="openweather">OpenWeather (requires API key)</option>
                  <option value="custom">Custom URL</option>
                </select>
                <span className="settings-item-detail" style={{ marginTop: 6, display: 'block' }}>
                  {weatherProvider === 'open-meteo' && 'Uses historical weather data at the exact time of the journey. Free with no API key required.'}
                  {weatherProvider === 'openweather' && 'Uses current weather at the journey location. Requires a free API key from openweathermap.org.'}
                  {weatherProvider === 'custom' && 'Use your own weather API endpoint. The response must return JSON with weather data.'}
                </span>
              </div>

              {(weatherProvider === 'openweather' || weatherProvider === 'custom') && (
                <div className="settings-form-group">
                  <label className="settings-field-label" htmlFor="weather-api-key">API Key</label>
                  <input
                    id="weather-api-key"
                    className="settings-input"
                    type="password"
                    value={weatherApiKey}
                    onChange={(e) => setWeatherApiKey(e.target.value)}
                    placeholder={weatherProvider === 'custom' ? 'Optional — used with {api_key} placeholder' : 'Enter your OpenWeather API key'}
                    onFocus={(e) => { if (e.target.value.startsWith('\u2022')) e.target.value = ''; setWeatherApiKey(''); }}
                  />
                </div>
              )}

              {weatherProvider === 'custom' && (
                <div className="settings-form-group">
                  <label className="settings-field-label" htmlFor="weather-custom-url">Endpoint URL</label>
                  <input
                    id="weather-custom-url"
                    className="settings-input"
                    type="text"
                    value={weatherCustomUrl}
                    onChange={(e) => setWeatherCustomUrl(e.target.value)}
                    placeholder="https://api.example.com/weather?lat={lat}&lon={lon}&date={date}"
                  />
                  <span className="settings-item-detail" style={{ marginTop: 6, display: 'block' }}>
                    {'Available placeholders: {lat}, {lon}, {date} (YYYY-MM-DD), {timestamp} (ISO 8601), {api_key}. Response JSON should include: temp, humidity, wind_speed, description, and optionally feels_like, condition, icon/weather_code.'}
                  </span>
                </div>
              )}

              {weatherResult && (
                <div className={`settings-connection-status ${weatherResult.success ? 'success' : 'error'}`}>
                  {weatherResult.success ? weatherResult.message : weatherResult.error}
                </div>
              )}

              <div className="settings-btn-row">
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={handleSaveWeather}
                  disabled={weatherSaving || (weatherProvider === 'openweather' && !weatherApiKey) || (weatherProvider === 'custom' && !weatherCustomUrl)}
                >
                  <BtnLabel loading={weatherSaving}>Save Weather Settings</BtnLabel>
                </button>
              </div>
            </>
          )}

          {!weatherEnabled && (
            <div className="settings-btn-row">
              <button
                className="settings-btn settings-btn-primary"
                onClick={handleSaveWeather}
                disabled={weatherSaving}
              >
                <BtnLabel loading={weatherSaving}>Save Weather Settings</BtnLabel>
              </button>
            </div>
          )}
        </section>

        <section className="settings-panel" style={{ marginTop: 24 }}>
          <h2 className="settings-section-title">Flight Import</h2>
          <p className="settings-description">
            Configure FlightAware AeroAPI to import real flight tracks. Without an API key, flight imports use estimated great-circle routes.
          </p>

          <div className="settings-form-group">
            <label className="settings-field-label" htmlFor="flight-api-key">FlightAware API Key</label>
            <input
              id="flight-api-key"
              className="settings-input"
              type="password"
              value={flightApiKey}
              onChange={(e) => setFlightApiKey(e.target.value)}
              placeholder="Enter your FlightAware AeroAPI key"
              onFocus={(e) => { if (e.target.value.startsWith('\u2022')) e.target.value = ''; setFlightApiKey(''); }}
            />
            <span className="settings-item-detail" style={{ marginTop: 6, display: 'block' }}>
              Free personal tier available at flightaware.com/aeroapi — provides ~500 lookups/month with actual flight track data.
            </span>
          </div>

          {flightResult && (
            <div className={`settings-connection-status ${flightResult.success ? 'success' : 'error'}`}>
              {flightResult.success ? flightResult.message : flightResult.error}
            </div>
          )}

          <div className="settings-btn-row">
            <button
              className="settings-btn settings-btn-primary"
              onClick={handleSaveFlight}
              disabled={flightSaving}
            >
              <BtnLabel loading={flightSaving}>Save Flight Settings</BtnLabel>
            </button>
          </div>
        </section>

        <section className="settings-panel" style={{ marginTop: 24 }}>
          <h2 className="settings-section-title">Journey AI</h2>
          <p className="settings-description">
            Ask Marco natural-language questions about your travels, answered from your own
            journey data by a local LLM running on your Ollama server. Nothing leaves your network.
          </p>

          <label className="settings-item" htmlFor="marco-toggle">
            <div className="settings-item-copy">
              <span className="settings-item-title">Enable Journey AI</span>
              <span className="settings-item-detail">
                {marcoEnabled
                  ? 'Marco is available in the navigation bar.'
                  : 'Adds a Marco tab where you can ask about distances, speeds, and places.'}
              </span>
            </div>
            <span className="settings-switch">
              <input
                id="marco-toggle"
                type="checkbox"
                checked={marcoEnabled}
                onChange={(e) => setMarcoEnabled(e.target.checked)}
              />
              <span className="settings-slider" />
            </span>
          </label>

          {marcoEnabled && (
            <>
              <div className="settings-form-group">
                <label className="settings-field-label" htmlFor="marco-url">Ollama URL</label>
                <input
                  id="marco-url"
                  className="settings-input"
                  type="text"
                  value={marcoUrl}
                  onChange={(e) => setMarcoUrl(e.target.value)}
                  placeholder="http://192.168.1.50:11434"
                />
                <span className="settings-item-detail" style={{ marginTop: 6, display: 'block' }}>
                  The address of the machine running Ollama. The Journey server talks to it directly,
                  so use an address reachable from the server, not from your browser.
                </span>
              </div>

              <div className="settings-form-group">
                <label className="settings-field-label" htmlFor="marco-model">Model</label>
                <input
                  id="marco-model"
                  className="settings-input"
                  type="text"
                  value={marcoModel}
                  onChange={(e) => setMarcoModel(e.target.value)}
                  placeholder={marcoDefaultModel}
                />
                <span className="settings-item-detail" style={{ marginTop: 6, display: 'block' }}>
                  Must already be pulled on the Ollama machine and support tool calling
                  (gemma4:e4b works well). Test Connection verifies both.
                </span>
              </div>

              <div className="settings-form-group">
                <label className="settings-field-label" htmlFor="marco-timeout">Response timeout (seconds)</label>
                <input
                  id="marco-timeout"
                  className="settings-input"
                  type="number"
                  min={marcoTimeoutMeta.min}
                  max={marcoTimeoutMeta.max}
                  step="1"
                  value={marcoTimeoutS}
                  onChange={(e) => setMarcoTimeoutS(e.target.value)}
                  placeholder={String(marcoTimeoutMeta.def)}
                />
                <span className="settings-item-detail" style={{ marginTop: 6, display: 'block' }}>
                  How long Marco waits for the AI machine before giving up ({marcoTimeoutMeta.min}–{marcoTimeoutMeta.max} seconds;
                  blank uses {marcoTimeoutMeta.def}). Raise this if the machine is slow or takes a while to load the model.
                </span>
              </div>
            </>
          )}

          {marcoResult && (
            <div className={`settings-connection-status ${marcoResult.success ? 'success' : 'error'}`}>
              {marcoResult.success ? marcoResult.message : marcoResult.error}
            </div>
          )}

          <div className="settings-btn-row">
            {marcoEnabled && (
              <button
                className="settings-btn settings-btn-secondary"
                onClick={handleTestMarco}
                disabled={marcoTesting || !marcoUrl}
              >
                <BtnLabel loading={marcoTesting}>Test Connection</BtnLabel>
              </button>
            )}
            <button
              className="settings-btn settings-btn-primary"
              onClick={handleSaveMarco}
              disabled={marcoSaving || (marcoEnabled && !marcoUrl)}
            >
              <BtnLabel loading={marcoSaving}>Save AI Settings</BtnLabel>
            </button>
          </div>
        </section>

        <section className="settings-panel" style={{ marginTop: 24 }}>
          <h2 className="settings-section-title">Storage</h2>
          <p className="settings-description">How much space Journey is using on the server.</p>

          {storageError && <div className="settings-inline-error">{storageError}</div>}
          {!storage && !storageError && (
            <p className="settings-item-detail settings-storage-loading">Measuring storage...</p>
          )}

          {storage && (
            <>
              <div className="settings-storage-row">
                <div className="settings-item-copy">
                  <span className="settings-item-title">Database</span>
                  <span className="settings-item-detail">
                    PostgreSQL {storage.database.version} {'·'} {storage.database.name}
                  </span>
                </div>
                <span className="settings-storage-size" title={`${dbBytes.toLocaleString()} bytes`}>
                  {storage.database.pretty}
                </span>
              </div>

              <div
                className="settings-storage-bar"
                role="img"
                aria-label={`Your journeys use ${Math.round(accountShare)}% of the database`}
              >
                <span
                  className="settings-storage-bar-fill"
                  style={{ width: `${accountShare}%`, minWidth: accountBytes > 0 ? 3 : 0 }}
                />
              </div>
              <div className="settings-storage-legend">
                <span className="settings-storage-legend-item">
                  <span className="settings-storage-dot mine" />
                  Your journeys <strong>{formatBytes(accountBytes)}</strong>
                  {' · '}
                  {storage.account.journeys.toLocaleString()} {storage.account.journeys === 1 ? 'journey' : 'journeys'}
                </span>
                <span className="settings-storage-legend-item">
                  <span className="settings-storage-dot other" />
                  Other accounts &amp; app data <strong>{formatBytes(dbBytes - accountBytes)}</strong>
                </span>
              </div>

              <div className="settings-storage-row">
                <div className="settings-item-copy">
                  <span className="settings-item-title">Your photos</span>
                  <span className="settings-item-detail">
                    {storage.photos.count.toLocaleString()} {storage.photos.count === 1 ? 'photo' : 'photos'},
                    stored on {storage.photos.location || "the server's disk"} rather than in the database.
                  </span>
                </div>
                <span className="settings-storage-size" title={`${photoBytes.toLocaleString()} bytes`}>
                  {formatBytes(photoBytes)}
                </span>
              </div>

              <div className="settings-storage-row">
                <div className="settings-item-copy">
                  <span className="settings-item-title">Your total</span>
                  <span className="settings-item-detail">Your journey data plus your photos.</span>
                </div>
                <span className="settings-storage-size">{formatBytes(accountBytes + photoBytes)}</span>
              </div>
            </>
          )}
        </section>

        <AttachmentStoragePanel onChanged={loadStorage} />

        <section className="settings-panel" style={{ marginTop: 24 }}>
          <h2 className="settings-section-title">Database Connection</h2>
          <p className="settings-description">Configure the PostgreSQL database connection.</p>

          <div className="settings-form-group">
            <label className="settings-field-label" htmlFor="db-host">Host</label>
            <input
              id="db-host"
              className="settings-input"
              type="text"
              value={dbHost}
              onChange={(e) => setDbHost(e.target.value)}
              placeholder="localhost"
            />
          </div>

          <div className="settings-form-group">
            <label className="settings-field-label" htmlFor="db-port">Port</label>
            <input
              id="db-port"
              className="settings-input"
              type="text"
              value={dbPort}
              onChange={(e) => setDbPort(e.target.value)}
              placeholder="5432"
            />
          </div>

          <div className="settings-form-group">
            <label className="settings-field-label" htmlFor="db-name">Database Name</label>
            <input
              id="db-name"
              className="settings-input"
              type="text"
              value={dbName}
              onChange={(e) => setDbName(e.target.value)}
              placeholder="journey"
            />
          </div>

          <div className="settings-form-group">
            <label className="settings-field-label" htmlFor="db-user">Username</label>
            <input
              id="db-user"
              className="settings-input"
              type="text"
              value={dbUser}
              onChange={(e) => setDbUser(e.target.value)}
              placeholder="postgres"
            />
          </div>

          <div className="settings-form-group">
            <label className="settings-field-label" htmlFor="db-password">Password</label>
            <input
              id="db-password"
              className="settings-input"
              type="password"
              value={dbPassword}
              onChange={(e) => setDbPassword(e.target.value)}
              placeholder="Enter password"
            />
          </div>

          {dbTestResult && (
            <div className={`settings-connection-status ${dbTestResult.success ? 'success' : 'error'}`}>
              {dbTestResult.success ? dbTestResult.message || 'Connection successful' : dbTestResult.error}
            </div>
          )}

          <div className="settings-btn-row">
            <button
              className="settings-btn settings-btn-secondary"
              onClick={handleTestConnection}
              disabled={dbTesting || !dbHost || !dbName || !dbUser}
            >
              <BtnLabel loading={dbTesting}>Test Connection</BtnLabel>
            </button>
            <button
              className="settings-btn settings-btn-primary"
              onClick={handleSaveDatabase}
              disabled={dbSaving || !dbHost || !dbName || !dbUser}
            >
              <BtnLabel loading={dbSaving}>Save &amp; Reconnect</BtnLabel>
            </button>
          </div>
        </section>

        <section className="settings-panel" style={{ marginTop: 24 }}>
          <h2 className="settings-section-title">Account</h2>
          <p className="settings-description">Manage sign-in and account lifecycle actions.</p>
          <div className="settings-btn-row">
            <button className="settings-btn settings-btn-secondary" onClick={logout}>
              Sign Out
            </button>
            <button className="settings-btn settings-btn-danger" onClick={handleDeleteModalOpen}>
              Delete Account
            </button>
          </div>
          <p className="settings-danger-note">
            Deleting your account removes any associated account data, including your journeys,
            waypoints, photos, pairing tokens, and profile details permanently.
          </p>
        </section>
      </main>

      <Modal open={deleteModalOpen} onClose={handleDeleteModalClose}>
        <div className="modal-header">
          <h3>Delete Account</h3>
        </div>
        <div className="modal-body">
          <p>
            This action is permanent. All data associated with your account will be removed.
          </p>
          <label className="settings-field-label" htmlFor="confirm-delete-password">
            Confirm with your password
          </label>
          <input
            id="confirm-delete-password"
            className="modern-input"
            type="password"
            value={deletePassword}
            onChange={(e) => setDeletePassword(e.target.value)}
            autoComplete="current-password"
            placeholder="Enter your password"
            disabled={deleteLoading}
          />
          {deleteError && <div className="settings-inline-error">{deleteError}</div>}
        </div>
        <div className="modal-buttons">
          <button
            className="modal-btn modal-btn-cancel"
            onClick={handleDeleteModalClose}
            disabled={deleteLoading}
          >
            Cancel
          </button>
          <button
            className={`modal-btn modal-btn-delete${deleteLoading ? ' loading' : ''}`}
            onClick={handleDeleteAccount}
            disabled={deleteLoading}
          >
            <span className="btn-text">Delete Account</span>
            <span className="btn-loader" />
          </button>
        </div>
      </Modal>
    </div>
  );
}
