import { useCallback, useEffect, useState } from 'react';
import { listInvites, createInvite, revokeInvite, listUsers, setUserAdmin, removeUser } from '../api/admin';

const STATUS_LABELS = { pending: 'Waiting', used: 'Used', expired: 'Expired', revoked: 'Revoked' };

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

// Server admin only: accounts are invite-only, so new people join through links made here.
export default function AdminAccountsPanel() {
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [note, setNote] = useState('');
  const [days, setDays] = useState('7');
  const [newInvite, setNewInvite] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [u, i] = await Promise.all([listUsers(), listInvites()]);
      setUsers(u);
      setInvites(i);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () => run(async () => {
    const invite = await createInvite({ note: note.trim(), expiresInDays: Number(days) });
    setNewInvite(invite);
    setCopied(false);
    setNote('');
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(newInvite.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleRemove = (account) => {
    if (!window.confirm(`Delete ${account.username} and all of their journeys, photos and settings? This can't be undone.`)) return;
    run(() => removeUser(account.id));
  };

  return (
    <section className="settings-panel" style={{ marginTop: 24 }}>
      <h2 className="settings-section-title">Accounts &amp; Invites</h2>
      <p className="settings-description">
        New accounts need an invite link. Each link works once and expires; it is shown only when it's created.
      </p>

      <div className="settings-form-group">
        <label className="settings-field-label" htmlFor="invite-note">Who is it for? (optional)</label>
        <input
          id="invite-note"
          className="settings-input"
          type="text"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Alex's phone"
        />
      </div>
      <div className="settings-form-group">
        <label className="settings-field-label" htmlFor="invite-days">Expires after</label>
        <select id="invite-days" className="settings-input" value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
        </select>
      </div>
      <div className="settings-btn-row">
        <button className="settings-btn settings-btn-primary" onClick={handleCreate} disabled={busy}>
          Create Invite Link
        </button>
      </div>

      {newInvite && (
        <div className="settings-connection-status success" style={{ wordBreak: 'break-all' }}>
          <div>Send this link to the person you're inviting. It won't be shown again.</div>
          <code>{newInvite.url}</code>
          <div className="settings-btn-row">
            <button className="settings-btn settings-btn-secondary" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy Link'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="settings-inline-error">{error}</div>}

      {invites.length > 0 && (
        <>
          <h3 className="settings-field-label" style={{ marginTop: 20 }}>Invites</h3>
          {invites.map((invite) => (
            <div key={invite.id} className="settings-storage-row">
              <div className="settings-item-copy">
                <span className="settings-item-title">{invite.note || 'Invite'}</span>
                <span className="settings-item-detail">
                  {STATUS_LABELS[invite.status] || invite.status}
                  {invite.status === 'used' && invite.usedBy ? ` by ${invite.usedBy}` : ''}
                  {invite.status === 'pending' ? ` · expires ${formatDate(invite.expiresAt)}` : ''}
                </span>
              </div>
              {invite.status === 'pending' && (
                <button className="settings-btn settings-btn-secondary" onClick={() => run(() => revokeInvite(invite.id))} disabled={busy}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </>
      )}

      <h3 className="settings-field-label" style={{ marginTop: 20 }}>Accounts</h3>
      {users.map((account) => (
        <div key={account.id} className="settings-storage-row">
          <div className="settings-item-copy">
            <span className="settings-item-title">
              {account.displayName || account.username}{account.isYou ? ' (you)' : ''}
            </span>
            <span className="settings-item-detail">
              {account.username}{account.isAdmin ? ' · admin' : ''} · joined {formatDate(account.createdAt)}
            </span>
          </div>
          {!account.isYou && (
            <div className="settings-btn-row" style={{ marginTop: 0 }}>
              <button
                className="settings-btn settings-btn-secondary"
                onClick={() => run(() => setUserAdmin(account.id, !account.isAdmin))}
                disabled={busy}
              >
                {account.isAdmin ? 'Remove Admin' : 'Make Admin'}
              </button>
              <button className="settings-btn settings-btn-danger" onClick={() => handleRemove(account)} disabled={busy}>
                Delete
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
