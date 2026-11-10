import apiFetch from './apiFetch';

// quiet: a background check that shouldn't light the page's loading bar.
export async function getPairingTokens({ quiet = false } = {}) {
  const res = quiet
    ? await fetch('/api/pairing/tokens', { credentials: 'include' })
    : await apiFetch('/api/pairing/tokens');
  if (!res.ok) throw new Error('Failed to get pairing tokens');
  return res.json();
}

// A new pairing code, valid until first use or 15 minutes. The token is only ever
// returned here.
export async function createPairingToken(label) {
  const res = await apiFetch('/api/pairing/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('Failed to create token');
  return res.json();
}

export async function revokePairingToken(id) {
  const res = await apiFetch(`/api/pairing/tokens/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to revoke token');
  return res.json();
}
