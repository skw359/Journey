import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import './DataMigration.css';

export default function DataMigration() {
  const { completeMigration, migrationCount } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleImport = async () => {
    setLoading(true);
    try {
      await completeMigration(true);
    } catch {
      setLoading(false);
    }
  };

  const handleSkip = () => {
    completeMigration(false);
  };

  return (
    <div className="migration-page">
      {loading && (
        <div className="migration-loading-overlay">
          <div className="migration-loading-spinner" />
          <div className="migration-loading-text">
            Please wait, do not reload...
          </div>
        </div>
      )}
      <div className="migration-panel">
        <h1>Existing Data Found</h1>
        <p className="migration-desc">
          Your database contains journeys that aren't linked to any account.
          Would you like to import them to your new account?
        </p>
        <div className="migration-count">
          {migrationCount} {migrationCount === 1 ? 'journey' : 'journeys'} found
        </div>
        <div className="migration-actions">
          <button
            className="migration-btn-primary"
            onClick={handleImport}
            disabled={loading}
          >
            Import to my account
          </button>
          <button
            className="migration-btn-secondary"
            onClick={handleSkip}
            disabled={loading}
          >
            Start fresh
          </button>
        </div>
      </div>
    </div>
  );
}
