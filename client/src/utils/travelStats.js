// Client-side aggregation of route objects into travel stats.
// Mirrors the server aggregation in server/routes/maps.js (the /alltime-map-data
// handler, ~lines 145-228) so filtered numbers stay consistent with the
// all-time numbers the server produces. Keep the rounding/format logic here in
// sync with that handler.

function formatTotalTime(ms) {
  if (ms <= 0) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return { days, hours: hours % 24, minutes: minutes % 60 };
}

/**
 * Aggregate already-filtered client route objects into travel stats.
 * The caller is responsible for any date/bounds filtering; this function does
 * NOT filter — it only sums whatever routes it is given.
 *
 * Each route may have: distance (string|null), startTime (ISO string|null),
 * endTime (ISO string|null), travelMode (string), coordinates (array of [lat, lon]).
 *
 * @param {Array} routes
 * @returns {{
 *   totalRoutes: number,
 *   totalDistance: number,
 *   totalTime: ({days:number, hours:number, minutes:number}|null),
 *   totalPoints: number,
 *   modeDistances: { drive: number, scooter: number, foot: number, train: number, metro: number, flight: number }
 * }}
 */
export function computeFilteredStats(routes) {
  const list = Array.isArray(routes) ? routes : [];

  let totalDistance = 0;
  let totalTimeMs = 0;
  let totalPoints = 0;
  const modeDistances = { drive: 0, scooter: 0, foot: 0, train: 0, metro: 0, flight: 0 };

  for (const route of list) {
    const dist = Number(route.distance) || 0;
    totalDistance += dist;

    const mode = route.travelMode;
    if (Object.prototype.hasOwnProperty.call(modeDistances, mode)) {
      modeDistances[mode] += dist;
    }

    if (route.startTime && route.endTime) {
      const startMs = new Date(route.startTime).getTime();
      const endMs = new Date(route.endTime).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        totalTimeMs += endMs - startMs;
      }
    }

    totalPoints += route.coordinates?.length || 0;
  }

  return {
    totalRoutes: list.length,
    totalDistance: Number(totalDistance.toFixed(1)),
    totalTime: formatTotalTime(totalTimeMs),
    totalPoints,
    modeDistances: {
      drive: Number(modeDistances.drive.toFixed(1)),
      scooter: Number(modeDistances.scooter.toFixed(1)),
      foot: Number(modeDistances.foot.toFixed(1)),
      train: Number(modeDistances.train.toFixed(1)),
      metro: Number(modeDistances.metro.toFixed(1)),
      flight: Number(modeDistances.flight.toFixed(1)),
    },
  };
}
