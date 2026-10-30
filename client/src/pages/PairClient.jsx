import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { getPairingTokens, createPairingToken, revokePairingToken } from '../api/pairing';
import './PairClient.css';

export default function PairClient() {
  const navigate = useNavigate();
  const [qrData, setQrData] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadTokens = useCallback(async () => {
    try {
      setTokens(await getPairingTokens());
    } catch (err) {
      console.error('Failed to load paired devices:', err);
    }
  }, []);

  // Tokens are stored hashed, so the code shown is always a fresh one.
  const handleGenerate = useCallback(async () => {
    try {
      setQrData(await createPairingToken('iPhone'));
      await loadTokens();
    } catch (err) {
      console.error('Failed to create token:', err);
    } finally {
      setLoading(false);
    }
  }, [loadTokens]);

  useEffect(() => {
    handleGenerate();
  }, [handleGenerate]);

  const handleRevoke = async (id) => {
    try {
      await revokePairingToken(id);
      if (qrData?.id === id) setQrData(null);
      await loadTokens();
    } catch (err) {
      console.error('Failed to revoke token:', err);
    }
  };

  const qrValue = qrData
    ? `journey://pair?server=${encodeURIComponent(qrData.serverUrl)}&token=${qrData.token}`
    : '';

  const formatDate = (dateStr) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleBack = () => {
    if (window.history.state?.idx > 0) {
      navigate(-1);
      return;
    }
    navigate('/settings');
  };

  return (
    <div id="main-app" className="settings-page">
      <main className="pair-main">
        <div className="pair-panel">
          <button type="button" className="pair-back-btn" onClick={handleBack}>
            ← Back
          </button>
          <h1>Pair Client</h1>
          <p className="pair-subtitle">
            Scan this QR code with your iPhone to connect it to this server.
          </p>

          {loading ? (
            <div className="pair-loading">
              <div className="pair-spinner" />
            </div>
          ) : (
            <>
              {qrValue && (
                <div className="pair-qr-container">
                  <div className="pair-qr-wrapper">
                    <QRCodeSVG value={qrValue} size={240} level="M" />
                  </div>
                </div>
              )}

              <p className="pair-instructions">
                Open the Journey app on your iPhone, go to Settings, and tap "Scan QR Code" to pair.
                The code works once, within 15 minutes.
              </p>

              <h2 className="pair-section-title">Paired Devices</h2>

              {tokens.length === 0 ? (
                <p className="pair-empty">No paired devices yet.</p>
              ) : (
                <div className="pair-token-list">
                  {tokens.map(token => (
                    <div key={token.id} className="pair-token-item">
                      <div className="pair-token-info">
                        <span className="pair-token-label">{token.label || 'Device'}</span>
                        <span className="pair-token-meta">
                          {token.status === 'pending' ? 'Waiting to be scanned' : `Created ${formatDate(token.created_at)}`}
                          {token.last_used_at && ` · Last used ${formatDate(token.last_used_at)}`}
                        </span>
                      </div>
                      <button
                        className="pair-revoke-btn"
                        onClick={() => handleRevoke(token.id)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button className="pair-generate-btn" onClick={handleGenerate}>
                New Pairing Code
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
