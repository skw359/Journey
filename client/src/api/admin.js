import apiFetch from './apiFetch';

async function request(url, options, fallbackError) {
  const res = await apiFetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || fallbackError);
  return data;
}

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

export const listInvites = () => request('/api/admin/invites', undefined, 'Failed to load invites');
export const createInvite = ({ note, expiresInDays }) =>
  request('/api/admin/invites', json('POST', { note, expiresInDays }), 'Failed to create invite');
export const revokeInvite = (id) => request(`/api/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Failed to revoke invite');

export const listUsers = () => request('/api/admin/users', undefined, 'Failed to load accounts');
export const setUserAdmin = (id, isAdmin) =>
  request(`/api/admin/users/${encodeURIComponent(id)}`, json('PATCH', { isAdmin }), 'Failed to update account');
export const removeUser = (id) => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Failed to delete account');
