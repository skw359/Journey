export const mToFt = (m) => parseFloat(m) * 3.28084;

export function formatTime(timestamp, startTime) {
  const elapsed = timestamp - startTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatCompactDurationMs(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}

export function formatCompactDuration(startISO, endISO) {
  if (!startISO || !endISO) return '';
  const ms = new Date(endISO) - new Date(startISO);
  return formatCompactDurationMs(ms);
}

export function formatJourneyDateTime(startISO, endISO) {
  if (!startISO) return null;
  const start = new Date(startISO);
  if (isNaN(start)) return null;
  const dateStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeOpts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const startStr = start.toLocaleTimeString('en-US', timeOpts);
  const end = endISO ? new Date(endISO) : null;
  if (!end || isNaN(end)) return `${dateStr} ${startStr}`;
  const endStr = end.toLocaleTimeString('en-US', timeOpts);
  return `${dateStr} ${startStr}–${endStr}`;
}

export function formatDuration(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0h 0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function calculateAcceleration(currentSpeed, previousSpeed, currentTime, previousTime) {
  if (!previousSpeed || !previousTime) return 0;
  const dSpeed = (currentSpeed - previousSpeed) * 0.44704;
  const dTime = (currentTime - previousTime) / 1000;
  if (dTime <= 0) return 0;
  const accel = dSpeed / dTime;
  return accel * 3.28084;
}

// Binary units with Postgres' labels (kB, MB, GB), so sizes read the same as
// pg_size_pretty: 278746815 -> "266 MB", 2960802541 -> "2.8 GB".
export function formatBytes(bytes) {
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDataPointCount(count) {
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + 'k';
  }
  return count.toString();
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Wind direction in degrees (where it blows from) as an 8-point compass label: 95 -> "E".
export function formatCompassDirection(degrees) {
  if (degrees == null || !Number.isFinite(Number(degrees))) return null;
  const normalized = ((Number(degrees) % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 45) % COMPASS_POINTS.length];
}
