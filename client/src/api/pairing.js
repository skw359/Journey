import apiFetch from './apiFetch';

export async function getPairingTokens() {
  const res = await apiFetch('/api/pairing/tokens');
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
