import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { getPairingTokens, createPairingToken, revokePairingToken } from '../api/pairing';
import './PairClient.css';

// How often the page asks whether the code on screen has been scanned.
const SCAN_CHECK_MS = 2000;

export default function PairClient() {
  const navigate = useNavigate();
  const [qrData, setQrData] = useState(null);
  // The code on screen: 'waiting' to be scanned, 'paired', or 'expired'.
  const [codeState, setCodeState] = useState('waiting');
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
      setCodeState('waiting');
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

  // The phone talks to the server, not to this page, so the page has to ask.
  useEffect(() => {
    if (!qrData || codeState !== 'waiting') return undefined;
    let stopped = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const list = await getPairingTokens({ quiet: true });
        if (stopped) return;
        setTokens(list);
        const code = list.find((token) => token.id === qrData.id);
        if (code?.status === 'active') setCodeState('paired');
        else if (!code || new Date(qrData.expiresAt).getTime() <= Date.now()) setCodeState('expired');
      } catch {
        // Offline for a moment; the next check will catch up.
      }
    };
    const timer = setInterval(check, SCAN_CHECK_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [qrData, codeState]);

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
  // Codes nobody has scanned yet aren't devices.
  const pairedDevices = tokens.filter((token) => token.status === 'active');

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
              {qrValue && codeState === 'waiting' && (
                <>
                  <div className="pair-qr-container">
                    <div className="pair-qr-wrapper">
                      <QRCodeSVG value={qrValue} size={240} level="M" />
                    </div>
                  </div>
                  <p className="pair-status" role="status">
                    <span className="pair-status-dot" aria-hidden="true" />
                    Waiting for your iPhone to scan this code
                  </p>
                  <p className="pair-instructions">
                    Open the Journey app on your iPhone, go to Settings, and tap "Scan QR Code" to pair.
                    The code works once, within 15 minutes.
                  </p>
                </>
              )}

              {codeState === 'paired' && (
                <div className="pair-result" role="status">
                  <span className="pair-result-title">{qrData?.label || 'iPhone'} paired</span>
                  <span className="pair-result-detail">It can now upload journeys to this server.</span>
                </div>
              )}

              {codeState === 'expired' && (
                <div className="pair-result expired" role="status">
                  <span className="pair-result-title">This code has expired</span>
                  <span className="pair-result-detail">Codes work for 15 minutes. Make a new one to pair.</span>
                </div>
              )}

              <h2 className="pair-section-title">Paired Devices</h2>

              {pairedDevices.length === 0 ? (
                <p className="pair-empty">No paired devices yet.</p>
              ) : (
                <div className="pair-token-list">
                  {pairedDevices.map(token => (
                    <div key={token.id} className="pair-token-item">
                      <div className="pair-token-info">
                        <span className="pair-token-label">{token.label || 'Device'}</span>
                        <span className="pair-token-meta">
                          Paired {formatDate(token.created_at)}
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
                {codeState === 'paired' ? 'Pair Another Device' : 'New Pairing Code'}
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
