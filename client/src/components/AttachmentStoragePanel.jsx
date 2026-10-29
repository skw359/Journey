import { useCallback, useEffect, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import Modal from './Modal';
import { formatBytes } from '../utils/formatters';
import {
  getAttachmentStorage,
  getAttachmentDrives,
  getAttachmentMovePlan,
  setAttachmentLocation,
  pauseAttachmentMove,
  resumeAttachmentMove,
} from '../api/settings';

const FAST_POLL_MS = 2000;
const SLOW_POLL_MS = 10000;

const countFiles = (n) => `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
const optionKey = (location) => (location.kind === 'internal' ? 'internal' : location.volumeId);

function placesText(places) {
  return places.map((place) => place.name).join(' and ');
}

function MoveStatus({ status, onPause, onResume }) {
  const { move, waiting, location, canManage } = status;
  const waitingText = waiting.files > 0
    ? `${countFiles(waiting.files)} (${formatBytes(waiting.bytes)}) on ${placesText(waiting.places)}`
    : null;

  if (move.phase === 'moving' || (move.phase === 'waiting' && move.reason === 'busy')) {
    const done = move.bytesDone + (move.current?.bytesDone || 0);
    const pct = move.bytesTotal > 0 ? Math.min(100, (done / move.bytesTotal) * 100) : 0;
    let detail = 'Waiting for uploads and conversions to finish...';
    if (move.current) {
      detail = `${move.current.step === 'verifying' ? 'Checking' : 'Copying'} ${move.current.name}`;
    }
    return (
      <div className="settings-attach-move">
        <span className="settings-item-detail">
          Moving to {location.name}: {move.filesDone.toLocaleString()} of {countFiles(move.filesTotal)}
          {' · '}{formatBytes(done)} of {formatBytes(move.bytesTotal)}
        </span>
        <div
          className="settings-storage-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label="Attachment move progress"
        >
          <span className="settings-storage-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="settings-item-detail settings-attach-current">{detail}</span>
        <span className="settings-item-detail">Runs on the server, so it keeps going if you close this page.</span>
        {canManage && (
          <div className="settings-btn-row">
            <button className="settings-btn settings-btn-secondary" onClick={onPause}>Pause</button>
          </div>
        )}
      </div>
    );
  }

  if (move.phase === 'error') {
    return (
      <div className="settings-attach-move">
        <div className="settings-connection-status error">
          {move.error || 'Moving attachments stopped.'}
          {move.failed.length > 0 && (
            <ul className="settings-attach-failures">
              {move.failed.slice(0, 5).map((failure) => (
                <li key={failure.name}>{failure.name}: {failure.error}</li>
              ))}
            </ul>
          )}
        </div>
        {waitingText && <span className="settings-item-detail">Still to move: {waitingText}. They open from there in the meantime.</span>}
        {canManage && (
          <div className="settings-btn-row">
            <button className="settings-btn settings-btn-secondary" onClick={onResume}>Try again</button>
          </div>
        )}
      </div>
    );
  }

  if (!waitingText) return null;

  if (move.phase === 'paused') {
    return (
      <div className="settings-attach-move">
        <span className="settings-item-detail">
          Moving is paused. {waitingText} still {waiting.files === 1 ? 'needs' : 'need'} to move to {location.name}.
        </span>
        {canManage && (
          <div className="settings-btn-row">
            <button className="settings-btn settings-btn-primary" onClick={onResume}>Resume</button>
          </div>
        )}
      </div>
    );
  }

  let detail = `${waitingText} will move to ${location.name} shortly.`;
  if (!location.online) detail = `${waitingText} will move to ${location.name} once it's connected.`;
  else if (move.reason === 'locked') detail = `${waitingText} will move once the move-attachments script finishes.`;
  return (
    <div className="settings-attach-move">
      <span className="settings-item-detail">{detail}</span>
    </div>
  );
}

// Where the server keeps photos and videos. Moves run on the server; this panel only mirrors
// them, so a reload or another tab picks up a move already in progress.
export default function AttachmentStoragePanel({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [drives, setDrives] = useState(null);
  const [drivesError, setDrivesError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState(null);
  const [confirmOption, setConfirmOption] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const scannedRef = useRef(false);
  const onChangedRef = useRef(onChanged);
  const wasMovingRef = useRef(false);

  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const load = useCallback((poll = false) => (
    getAttachmentStorage({ poll })
      .then((next) => {
        setStatus(next);
        setLoadError('');
      })
      .catch((err) => {
        if (!poll) setLoadError(err.message);
      })
  ), []);

  const scan = useCallback((refresh = false) => {
    setScanning(true);
    setDrivesError('');
    getAttachmentDrives({ refresh })
      .then(setDrives)
      .catch((err) => setDrivesError(err.message))
      .finally(() => setScanning(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!status?.canManage || scannedRef.current) return;
    scannedRef.current = true;
    scan();
  }, [status?.canManage, scan]);

  const phase = status?.move.phase;
  const online = status?.location.online;
  const waitingFiles = status?.waiting.files || 0;
  let pollMs = null;
  if (phase === 'moving' || (online && waitingFiles > 0 && phase !== 'paused' && phase !== 'error')) {
    pollMs = FAST_POLL_MS;
  } else if (status && (!online || phase === 'waiting')) {
    pollMs = SLOW_POLL_MS;
  }

  useEffect(() => {
    if (!pollMs) return undefined;
    const timer = setInterval(() => load(true), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, load]);

  useEffect(() => {
    const moving = phase === 'moving';
    if (wasMovingRef.current && !moving) onChangedRef.current?.();
    wasMovingRef.current = moving;
  }, [phase]);

  const runAction = async (action) => {
    setActionError('');
    try {
      setStatus(await action());
    } catch (err) {
      setActionError(err.message);
    }
  };

  const currentKey = status ? optionKey(status.location) : null;
  const chosenKey = selected ?? currentKey;
  const options = [];
  if (drives) {
    options.push({
      key: 'internal',
      target: { kind: 'internal' },
      name: 'This PC',
      detail: `${drives.internal.path} · ${formatBytes(drives.internal.freeBytes)} free`,
      problem: null,
    });
    for (const drive of drives.drives) {
      options.push({
        key: drive.id,
        target: { kind: 'drive', volumeId: drive.id },
        name: `${drive.label} (${drive.letter}:)`,
        detail: `${drive.bus} · ${drive.fileSystem} · ${formatBytes(drive.freeBytes)} free of ${formatBytes(drive.totalBytes)}`,
        problem: drive.healthy ? null : drive.status,
      });
    }
    if (status?.location.kind === 'drive' && !options.some((option) => option.key === currentKey)) {
      options.splice(1, 0, {
        key: currentKey,
        target: null,
        name: status.location.name,
        detail: status.location.path,
        problem: 'Not connected',
      });
    }
  }
  const chosen = options.find((option) => option.key === chosenKey);
  const canMove = Boolean(chosen && chosen.key !== currentKey && chosen.target && !chosen.problem);

  const openConfirm = () => {
    setConfirmOption(chosen);
    setPlan(null);
    setPlanError('');
    setActionError('');
    getAttachmentMovePlan(chosen.key).then(setPlan).catch((err) => setPlanError(err.message));
  };

  const closeConfirm = () => {
    if (!saving) setConfirmOption(null);
  };

  const confirmMove = async () => {
    setSaving(true);
    setActionError('');
    try {
      setStatus(await setAttachmentLocation(confirmOption.target));
      setConfirmOption(null);
      setSelected(null);
      onChangedRef.current?.();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const location = status?.location;
  const shortOfSpace = plan && plan.freeBytes < plan.neededBytes;

  return (
    <section className="settings-panel" style={{ marginTop: 24 }}>
      <h2 className="settings-section-title">Attachment storage</h2>
      <p className="settings-description">Where the server keeps your photos and videos.</p>

      {loadError && <div className="settings-inline-error">{loadError}</div>}
      {!status && !loadError && (
        <p className="settings-item-detail settings-storage-loading">Checking attachment storage...</p>
      )}

      {status && (
        <>
          <div className="settings-storage-row">
            <div className="settings-item-copy">
              <span className="settings-item-title">{location.name}</span>
              <span className="settings-item-detail">
                {location.path}
                {location.freeBytes != null && ` · ${formatBytes(location.freeBytes)} free of ${formatBytes(location.totalBytes)}`}
              </span>
            </div>
            <span className={`settings-attach-state${location.online ? '' : ' offline'}`}>
              {location.online ? 'Connected' : 'Not connected'}
            </span>
          </div>

          {!location.online && (
            <div className="settings-connection-status warning">
              {location.name} isn&apos;t connected. New photos and videos are saved to This PC for now and move
              to {location.label} on their own once it&apos;s plugged back in. Ones already on it can&apos;t be
              opened until then.
            </div>
          )}

          <MoveStatus
            status={status}
            onPause={() => runAction(pauseAttachmentMove)}
            onResume={() => runAction(resumeAttachmentMove)}
          />

          {actionError && !confirmOption && <div className="settings-inline-error">{actionError}</div>}

          {status.canManage ? (
            <>
              <div className="settings-form-group">
                <span className="settings-field-label">Store attachments on</span>
                {drivesError && <div className="settings-inline-error">{drivesError}</div>}
                {!drives && !drivesError && <p className="settings-item-detail">Looking for drives...</p>}
                {drives && (
                  <div className="settings-drive-list" role="radiogroup" aria-label="Attachment storage location">
                    {options.map((option) => {
                      const unavailable = Boolean(option.problem) || !option.target;
                      return (
                        <label
                          key={option.key}
                          className={`settings-drive-option${chosenKey === option.key ? ' selected' : ''}${unavailable ? ' unavailable' : ''}`}
                        >
                          <input
                            type="radio"
                            name="attachment-location"
                            value={option.key}
                            checked={chosenKey === option.key}
                            disabled={unavailable && option.key !== currentKey}
                            onChange={() => setSelected(option.key)}
                          />
                          <span className="settings-item-copy">
                            <span className="settings-item-title">
                              {option.name}
                              {option.key === currentKey && <span className="settings-drive-badge">Current</span>}
                              {option.problem && <span className="settings-drive-badge problem">{option.problem}</span>}
                            </span>
                            <span className="settings-item-detail">{option.detail}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {drives && drives.drives.length === 0 && (
                  <p className="settings-item-detail settings-drive-empty">
                    No external drives found. Plug one in, then press Rescan.
                  </p>
                )}
              </div>
              <div className="settings-btn-row">
                <button className="settings-btn settings-btn-secondary" onClick={() => scan(true)} disabled={scanning}>
                  {scanning ? 'Scanning...' : 'Rescan drives'}
                </button>
                <button className="settings-btn settings-btn-primary" onClick={openConfirm} disabled={!canMove}>
                  {canMove ? `Move to ${chosen.name}` : 'Move attachments'}
                </button>
              </div>
            </>
          ) : (
            <p className="settings-danger-note">Only the primary account can change where attachments are stored.</p>
          )}
        </>
      )}

      <Modal open={Boolean(confirmOption)} onClose={closeConfirm}>
        <div className="modal-header rename-header">
          <HardDrive size={24} />
          <h3>Move attachments to {confirmOption?.name}?</h3>
        </div>
        <div className="modal-body">
          {!plan && !planError && <p>Measuring what needs to move...</p>}
          {plan && (
            <>
              <p>
                New photos and videos will be saved to {plan.path} from now on. The {countFiles(plan.files)} (
                {formatBytes(plan.bytes)}) stored now will be copied there, checked against the originals, and then
                removed from where they are.
              </p>
              <p className="settings-item-detail">
                {formatBytes(plan.freeBytes)} free there. Journey keeps working while the files move.
              </p>
            </>
          )}
          {shortOfSpace && (
            <div className="settings-inline-error">
              Not enough space: this needs {formatBytes(plan.neededBytes)}.
            </div>
          )}
          {planError && <div className="settings-inline-error">{planError}</div>}
          {actionError && <div className="settings-inline-error">{actionError}</div>}
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={closeConfirm} disabled={saving}>Cancel</button>
          <button
            className={`modal-btn modal-btn-confirm${saving ? ' loading' : ''}`}
            onClick={confirmMove}
            disabled={saving || !plan || shortOfSpace}
          >
            <span className="btn-text">Move</span>
            <span className="btn-loader" />
          </button>
        </div>
      </Modal>
    </section>
  );
}
