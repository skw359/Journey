import apiFetch from './apiFetch';

export const WEATHER_SOUNDING_STORAGE_KEY = 'weatherSoundingEnabled';

export async function getDatabaseConfig() {
  const res = await apiFetch('/api/settings/database');
  if (!res.ok) throw new Error('Failed to get database config');
  return res.json();
}

export async function getStorageUsage() {
  const res = await apiFetch('/api/settings/storage');
  // A server that predates this endpoint answers with the SPA's index.html.
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.database) throw new Error(data.error || 'Failed to get storage usage');
  return data;
}

// Polls use plain fetch so the top loader doesn't flash every few seconds.
export async function getAttachmentStorage({ poll = false } = {}) {
  const url = '/api/settings/attachment-storage';
  const res = await (poll ? fetch(url, { credentials: 'include' }) : apiFetch(url));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load attachment storage');
  // A server that predates this endpoint answers with the SPA's index.html.
  if (!data.location) throw new Error('Restart the Journey server to manage attachment storage here.');
  return data;
}

export async function getAttachmentDrives({ refresh = false } = {}) {
  const res = await fetch(`/api/settings/attachment-storage/drives${refresh ? '?refresh=1' : ''}`, {
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data.drives)) throw new Error(data.error || 'Could not list drives');
  return data;
}

export async function getAttachmentMovePlan(target) {
  const res = await apiFetch(`/api/settings/attachment-storage/plan?target=${encodeURIComponent(target)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.files !== 'number') throw new Error(data.error || 'Failed to measure attachments');
  return data;
}

export async function setAttachmentLocation(target) {
  const res = await apiFetch('/api/settings/attachment-storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to change attachment storage');
  return data;
}

async function postAttachmentAction(action, fallbackError) {
  const res = await apiFetch(`/api/settings/attachment-storage/${action}`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || fallbackError);
  return data;
}

export const pauseAttachmentMove = () => postAttachmentAction('pause', 'Failed to pause');
export const resumeAttachmentMove = () => postAttachmentAction('resume', 'Failed to resume');

export async function getUnitPreference() {
  const res = await apiFetch('/api/settings/units');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to get unit preference');
  return data;
}

export async function updateUnitPreference(unitPreference) {
  const res = await apiFetch('/api/settings/units', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unitPreference }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update unit preference');
  return data;
}

export async function getWeatherConfig() {
  const res = await apiFetch('/api/settings/weather');
  if (!res.ok) throw new Error('Failed to get weather config');
  return res.json();
}

// The server looks up the journey's start city itself; no coordinates are sent.
export async function fetchSounding(routeId) {
  const params = new URLSearchParams({ routeId });
  const res = await apiFetch(`/api/settings/weather/sounding?${params}`);
  if (!res.ok) throw new Error('Failed to fetch sounding data');
  return res.json();
}

export async function updateWeatherConfig(config) {
  const res = await apiFetch('/api/settings/weather', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update weather config');
  return data;
}

export async function getFlightConfig() {
  const res = await apiFetch('/api/settings/flights');
  if (!res.ok) throw new Error('Failed to get flight config');
  return res.json();
}

export async function updateFlightConfig(config) {
  const res = await apiFetch('/api/settings/flights', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update flight config');
  return data;
}
