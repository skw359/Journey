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

export async function fetchTrash() {
  const res = await apiFetch(`${API_BASE}/routes/trash`);
  if (!res.ok) throw new Error('Failed to load Recently Deleted');
  return res.json();
}

export async function fetchTrashDetail(trashId) {
  const res = await apiFetch(`${API_BASE}/routes/trash/${trashId}`);
  if (!res.ok) throw new Error('Trashed journey not found');
  return res.json();
}

export async function restoreTrashedJourney(trashId) {
  const res = await apiFetch(`${API_BASE}/routes/trash/${trashId}/restore`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to restore journey');
  }
  return res.json();
}

export async function permanentlyDeleteTrashedJourney(trashId) {
  const res = await apiFetch(`${API_BASE}/routes/trash/${trashId}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to delete journey');
  }
  return res.json();
}

export async function emptyTrash() {
  const res = await apiFetch(`${API_BASE}/routes/trash`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to empty Trash');
  }
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

// Files bigger than this go up in pieces of this size (server/routes/mediaUploads.js), so no
// single request is large or slow. Smaller files share requests of up to this many bytes.
const CHUNK_BYTES = 32 * 1024 * 1024;
const PIECE_RETRIES = 8;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// XHR rather than fetch so uploads can report progress. Resolves for any HTTP status.
function sendXhr(method, url, body, { contentType, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.responseType = 'json';
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => resolve({ status: xhr.status, data: xhr.response || {} });
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.send(body);
  });
}

const isOk = (res) => res.status >= 200 && res.status < 300;

function errorMessage(res) {
  return res.data?.error
    || (res.status === 413 ? 'File is larger than the server allows' : `Upload failed (${res.status})`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postBatch(routeId, files, onFraction) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('photos', file);
  }
  const res = await sendXhr('POST', `${API_BASE}/routes/${routeId}/photos`, formData, { onProgress: onFraction });
  if (!isOk(res)) throw new Error(errorMessage(res));
  return res.data;
}

// Sends one file in pieces, retrying dropped pieces from wherever the server says it got to.
// The key lets the same file picked again later resume an unfinished upload.
async function uploadInPieces(routeId, file, onBytes) {
  const base = `${API_BASE}/routes/${routeId}/uploads`;
  const start = async () => {
    const res = await sendXhr('POST', base, JSON.stringify({
      name: file.name,
      size: file.size,
      type: file.type,
      key: `${file.name}:${file.size}:${file.lastModified}`,
    }), { contentType: 'application/json' });
    if (!isOk(res)) throw new Error(errorMessage(res));
    return res.data;
  };

  let { id, offset } = await start();
  let failures = 0;
  let restarted = false;
  for (;;) {
    const from = offset;
    const piece = file.slice(from, Math.min(from + CHUNK_BYTES, file.size));
    const res = await sendXhr('PUT', `${base}/${id}?offset=${from}`, piece, {
      contentType: 'application/octet-stream',
      onProgress: (fraction) => onBytes(from + fraction * piece.size),
    }).catch(() => null);

    if (res && isOk(res)) {
      if (res.data.photos) return res.data;
      offset = res.data.offset;
      onBytes(offset);
      failures = 0;
      continue;
    }
    if (res?.status === 404 && !restarted) {
      restarted = true;
      ({ id, offset } = await start());
      continue;
    }
    if (res && res.status !== 409 && !RETRYABLE_STATUS.has(res.status)) {
      throw new Error(errorMessage(res));
    }
    if (++failures > PIECE_RETRIES) {
      throw new Error(res ? errorMessage(res) : 'Upload failed: network error');
    }
    await wait(Math.min(1000 * 2 ** (failures - 1), 30000));
    const status = await sendXhr('GET', `${base}/${id}`).catch(() => null);
    if (status && isOk(status)) {
      if (status.data.photos) return status.data;
      offset = status.data.offset;
    }
  }
}

// Uploads photos and videos of any size, reporting overall progress (0..1) via onProgress.
// Files that fail come back in `skipped` alongside the server's own skips.
export async function uploadPhotos(routeId, files, onProgress) {
  const list = Array.from(files);
  const totalBytes = list.reduce((sum, file) => sum + file.size, 0) || 1;
  let doneBytes = 0;
  const report = (bytes) => onProgress?.(Math.min((doneBytes + bytes) / totalBytes, 1));
  const result = { photos: [], skipped: [] };
  const collect = (data) => {
    result.photos.push(...(data.photos || []));
    result.skipped.push(...(data.skipped || []));
  };

  const batches = [];
  for (const file of list.filter((f) => f.size <= CHUNK_BYTES)) {
    const last = batches[batches.length - 1];
    if (last && last.bytes + file.size <= CHUNK_BYTES) {
      last.files.push(file);
      last.bytes += file.size;
    } else {
      batches.push({ files: [file], bytes: file.size });
    }
  }

  for (const batch of batches) {
    try {
      collect(await postBatch(routeId, batch.files, (fraction) => report(fraction * batch.bytes)));
    } catch (err) {
      const name = batch.files.length === 1 ? batch.files[0].name : `${batch.files.length} files`;
      result.skipped.push({ name, reason: err.message });
    }
    doneBytes += batch.bytes;
  }

  for (const file of list.filter((f) => f.size > CHUNK_BYTES)) {
    try {
      collect(await uploadInPieces(routeId, file, report));
    } catch (err) {
      result.skipped.push({ name: file.name, reason: err.message });
    }
    doneBytes += file.size;
  }
  return result;
}

// Plain fetch (not apiFetch) so background polling doesn't flash the global top loader.
export async function fetchRouteMedia(routeId) {
  const res = await fetch(`${API_BASE}/routes/${routeId}/photos`);
  if (!res.ok) throw new Error('Failed to fetch media');
  const data = await res.json();
  return data.photos;
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

export async function combineJourneys(journeyIds, name) {
  const res = await apiFetch(`${API_BASE}/routes/combine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ journeyIds, name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to combine journeys');
  }
  return res.json();
}

export async function undoCombine(routeId) {
  const res = await apiFetch(`${API_BASE}/routes/${routeId}/undo-combine`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to undo combine');
  }
  return res.json();
}

export async function fetchAirports() {
  const res = await apiFetch(`${API_BASE}/flights/airports`);
  if (!res.ok) throw new Error('Failed to fetch airports');
  return res.json();
}

export async function searchFlights(params) {
  const res = await apiFetch(`${API_BASE}/flights/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Flight search failed');
  }
  return res.json();
}

export async function getFlightTrack(params) {
  const res = await apiFetch(`${API_BASE}/flights/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to get flight track');
  }
  return res.json();
}

export async function importFlight(params) {
  const res = await apiFetch(`${API_BASE}/flights/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to import flight');
  }
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