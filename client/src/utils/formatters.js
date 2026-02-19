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

export function formatDataPointCount(count) {
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + 'k';
  }
  return count.toString();
}
