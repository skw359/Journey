import apiFetch from './apiFetch';

const API_BASE = '/api';

export async function fetchRoutes() {
  const res = await apiFetch(`${API_BASE}/routes`);
  if (!res.ok) throw new Error('Failed to fetch journeys');
  return res.json();
}

export async function fetchRouteDetail(id, params = {}) {
  const query = new URLSearchParams();
  if (params.maxPoints != null) query.set('maxPoints', params.maxPoints);
  const qs = query.toString();
  const res = await apiFetch(`${API_BASE}/routes/${id}${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Journey not found');
  return res.json();
}

export async function deleteRoute(id) {
  const res = await apiFetch(`${API_BASE}/routes/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete journey');
  return res.json();
}

export async function renameRoute(id, newName) {
  const res = await apiFetch(`${API_BASE}/routes/${id}/name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName }),
  });
  if (!res.ok) throw new Error('Rename failed');
  return res.json();
}

export async function updateTravelMode(id, travelMode) {
  const res = await apiFetch(`${API_BASE}/routes/${id}/travel-mode`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ travelMode }),
  });
  if (!res.ok) throw new Error('Failed to update travel mode');
  return res.json();
}

export async function uploadPhotos(routeId, files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('photos', file);
  }
  const res = await apiFetch(`${API_BASE}/routes/${routeId}/photos`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Upload failed');
  }
  return res.json();
}

export async function deletePhoto(routeId, photoId) {
  const res = await apiFetch(`${API_BASE}/routes/${routeId}/photos/${photoId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete photo');
  return res.json();
}

export async function deleteDataPoint(routeId, index) {
  const res = await apiFetch(`${API_BASE}/routes/${routeId}/points/${index}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function renameWaypoint(routeId, waypointId, label) {
  const res = await apiFetch(`${API_BASE}/routes/${routeId}/waypoints/${waypointId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('Failed to rename waypoint');
  return res.json();
}

export async function fetchAllTimeMapData(params = {}) {
  const query = new URLSearchParams();
  if (params.maxPoints != null) query.set('maxPoints', params.maxPoints);
  if (params.bounds) query.set('bounds', params.bounds);
  const qs = query.toString();
  const res = await apiFetch(`${API_BASE}/alltime-map-data${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Failed to fetch all-time map data');
  return res.json();
}

export async function fetchAllPoints(params = {}) {
  const query = new URLSearchParams();
  if (params.start) query.set('start', params.start);
  if (params.end) query.set('end', params.end);
  if (params.countOnly) query.set('countOnly', '1');
  const res = await apiFetch(`${API_BASE}/all-points?${query}`);
  if (!res.ok) throw new Error('Failed to fetch all points');
  return res.json();
}

export async function fetchHeatmapData() {
  const res = await apiFetch(`${API_BASE}/heatmap-data`);
  if (!res.ok) throw new Error('Failed to fetch heatmap data');
  return res.json();
}

export async function fetchHeatmapGrid(params = {}) {
  const query = new URLSearchParams();
  if (params.start) query.set('start', params.start);
  if (params.end) query.set('end', params.end);
  if (params.zoom != null) query.set('zoom', params.zoom);
  if (params.bounds) query.set('bounds', params.bounds);
  const qs = query.toString();
  const res = await apiFetch(`${API_BASE}/heatmap-grid${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Failed to fetch heatmap grid');
  return res.json();
}
