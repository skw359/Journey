import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useUnits } from '../context/UnitsContext';
import Modal from '../components/Modal';
import {
  LARGE_ROUTE_WARNING_MESSAGE,
  LARGE_ROUTE_WARNING_SUPPRESSED_KEY,
  isLargeRouteWarningSuppressed,
  setLargeRouteWarningSuppressed
} from '../utils/largeRouteWarning';
import { UNIT_PREFERENCES } from '../utils/units';
import { getDatabaseConfig, updateDatabaseConfig, testDatabaseConnection } from '../api/settings';
import { uploadAvatar } from '../api/auth';
import './Settings.css';

export default function Settings() {
  const { theme, toggleTheme } = useTheme();
  const { user, logout, updateUser, deleteAccount } = useAuth();
  const { isMetric, setUnitPreference } = useUnits();
  const [suppressLargeRouteWarning, setSuppressLargeRouteWarning] = useState(() => isLargeRouteWarningSuppressed());
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
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key === LARGE_ROUTE_WARNING_SUPPRESSED_KEY) {
        setSuppressLargeRouteWarning(event.newValue === 'true');
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    getDatabaseConfig().then(config => {
      if (config.db_host) setDbHost(config.db_host);
      if (config.db_port) setDbPort(config.db_port);
      if (config.db_name) setDbName(config.db_name);
      if (config.db_user) setDbUser(config.db_user);
    }).catch(() => {});
  }, []);

  const handleWarningToggle = (event) => {
    const shouldSuppress = event.target.checked;
    setSuppressLargeRouteWarning(shouldSuppress);
    setLargeRouteWarningSuppressed(shouldSuppress);
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
      setDeleteError('Please enter your password to confirm account deletion.');
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

  return (
    <div id="main-app" className="settings-page">
      <main className="settings-main">
        <section className="settings-panel">
          <div className="settings-profile-header">
            <button
              className="settings-profile-avatar-btn"
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
                {avatarUploading ? '...' : 'Edit'}
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

          <label className="settings-item" htmlFor="suppress-large-route-warning-toggle">
            <div className="settings-item-copy">
              <span className="settings-item-title">Suppress large route warning</span>
              <span className="settings-item-detail">
                Turn off the notification:
                {' '}
                &quot;{LARGE_ROUTE_WARNING_MESSAGE}&quot;
              </span>
            </div>
            <span className="settings-switch">
              <input
                id="suppress-large-route-warning-toggle"
                type="checkbox"
                checked={suppressLargeRouteWarning}
                onChange={handleWarningToggle}
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
              {dbTesting ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              className="settings-btn settings-btn-primary"
              onClick={handleSaveDatabase}
              disabled={dbSaving || !dbHost || !dbName || !dbUser}
            >
              {dbSaving ? 'Saving...' : 'Save & Reconnect'}
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
            <span className="btn-text">{deleteLoading ? 'Deleting...' : 'Delete Account'}</span>
            <span className="btn-loader" />
          </button>
        </div>
      </Modal>
    </div>
  );
}
