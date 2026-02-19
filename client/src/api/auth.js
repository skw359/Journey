export async function getAuthStatus() {
  const res = await fetch('/api/auth/status');
  return res.json();
}

export async function register({ username, password, firstName, lastName }) {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, firstName, lastName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  return data;
}

export async function login({ username, password }) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data;
}

export async function logout() {
  const res = await fetch('/api/auth/logout', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Logout failed');
  return data;
}

export async function deleteAccount(password) {
  const res = await fetch('/api/auth/account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Account deletion failed');
  return data;
}

export async function migrateData() {
  const res = await fetch('/api/auth/migrate', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Migration failed');
  return data;
}

export async function uploadAvatar(file) {
  const formData = new FormData();
  formData.append('avatar', file);
  const res = await fetch('/api/auth/avatar', {
    method: 'POST',
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Avatar upload failed');
  return data;
}
