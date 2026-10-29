import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useUnits } from '../context/UnitsContext';
import { formatCompactDurationMs } from '../utils/formatters';
import { reverseGeocode } from '../api/geocode';
import { Line, Bar } from 'react-chartjs-2';
import { Chart as ChartJS, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Filler, Legend, BarElement } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import USStateMap from '../components/USStateMap';
import './FunStats.css';

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Filler, Legend, BarElement, zoomPlugin);

function formatHour(h) {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function formatMonth(monthStr) {
  const [y, m] = monthStr.split('-');
  const date = new Date(Number(y), Number(m) - 1);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatShortMonth(monthStr) {
  const [y, m] = monthStr.split('-');
  const date = new Date(Number(y), Number(m) - 1);
  return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatSigned(value, digits = 1) {
  if (!Number.isFinite(value)) return '--';
  if (value > 0) return `+${value.toFixed(digits)}`;
  return value.toFixed(digits);
}

function getAccentRgba(alpha = 1) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = raw;
  const hex = ctx.fillStyle; // normalised to #rrggbb
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function createTempChartOptions(timeline, expanded = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: {
        top: expanded ? 16 : 12,
        right: expanded ? 16 : 12,
        bottom: expanded ? 8 : 4,
        left: expanded ? 8 : 4,
      },
    },
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        labels: {
          padding: expanded ? 20 : 14,
          color: 'rgba(255,255,255,0.6)',
          font: { size: expanded ? 12 : 11 },
        },
      },
      tooltip: {
        callbacks: {
          title: (items) => {
            const idx = items[0]?.dataIndex;
            if (idx != null && timeline[idx]) {
              return timeline[idx].name;
            }
            return items[0]?.label;
          },
        },
      },
      zoom: {
        pan: {
          enabled: true,
          mode: 'x',
          threshold: 2,
        },
        zoom: {
          wheel: { enabled: true, speed: 0.1 },
          pinch: { enabled: true },
          drag: {
            enabled: true,
            backgroundColor: getAccentRgba(0.15),
            borderColor: getAccentRgba(0.5),
            borderWidth: 1,
            modifierKey: 'shift',
          },
          mode: 'x',
        },
      },
    },
    scales: {
      x: {
        ticks: {
          maxTicksLimit: expanded ? 14 : 8,
          color: 'rgba(255,255,255,0.5)',
          font: { size: expanded ? 12 : 11 },
          maxRotation: 0,
          padding: expanded ? 8 : 6,
        },
        grid: { display: false },
      },
      y: {
        ticks: {
          color: 'rgba(255,255,255,0.5)',
          font: { size: expanded ? 12 : 11 },
          callback: (value) => `${value}\u00B0`,
          padding: expanded ? 10 : 8,
          maxTicksLimit: expanded ? 10 : 7,
        },
        grid: { color: 'rgba(255,255,255,0.06)' },
        grace: '10%',
      },
    },
  };
}

const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',DC:'D.C.',FL:'Florida',GA:'Georgia',HI:'Hawaii',
  ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',
  LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',
  NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',
  OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
};

const BACKFILL_POLL_MS = 3000;

// The backfill job lives on the server; this only mirrors it, so a reload or a
// second tab picks up a run already in progress.
function useGeoBackfill(kind, onFinished) {
  const [status, setStatus] = useState(null);
  const running = Boolean(status?.job);
  const onFinishedRef = useRef(onFinished);
  const wasRunningRef = useRef(false);

  useEffect(() => { onFinishedRef.current = onFinished; }, [onFinished]);

  const request = useCallback((path, method = 'GET') => (
    fetch(`/api/routes/${path}`, { method, credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(s => { if (s && typeof s.total === 'number') setStatus(s); })
      .catch(() => {})
  ), []);

  useEffect(() => { request(`${kind}-status`); }, [kind, request]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => request(`${kind}-status`), BACKFILL_POLL_MS);
    return () => clearInterval(timer);
  }, [kind, running, request]);

  useEffect(() => {
    if (wasRunningRef.current && !running) onFinishedRef.current?.();
    wasRunningRef.current = running;
  }, [running]);

  const start = useCallback(() => request(`backfill-${kind}`, 'POST'), [kind, request]);
  const stop = useCallback(() => request(`backfill-${kind}/stop`, 'POST'), [kind, request]);
  const reindex = useCallback(() => {
    if (!window.confirm(`This will recompute ${kind} for all routes. Continue?`)) return;
    fetch(`/api/routes/reindex-${kind}`, { method: 'POST', credentials: 'include' })
      .then(r => { if (r.ok) start(); })
      .catch(() => {});
  }, [kind, start]);

  return { status, running, start, stop, reindex };
}

function GeoBackfillStatus({ kind, backfill }) {
  const { status, running, start, stop, reindex } = backfill;
  if (!status) return null;
  const label = kind === 'cities' ? 'Cities' : 'Places';
  const { job } = status;

  if (!running && status.remaining === 0) {
    return (
      <button className="funstats-reindex-btn" onClick={reindex}>
        Reindex {label}
      </button>
    );
  }

  const current = job?.current;
  const partial = current?.points > 0 ? current.pointsDone / current.points : 0;
  const pct = status.total > 0 ? Math.min(100, (status.processed + partial) / status.total * 100) : 0;

  let detail = null;
  if (job?.stopping) {
    detail = 'Stopping…';
  } else if (job?.retryInMs != null) {
    detail = `Geocoder unreachable, retrying in ${Math.max(1, Math.ceil(job.retryInMs / 1000))}s`;
  } else if (current) {
    detail = `${current.name || 'Untitled journey'} · ${current.pointsDone.toLocaleString()} / ${current.points.toLocaleString()} points`;
  }

  return (
    <div className="funstats-backfill">
      <div className="funstats-backfill-status">
        {running && <span className="funstats-backfill-spinner" />}
        {running
          ? `Geocoding ${kind}: ${status.processed.toLocaleString()} / ${status.total.toLocaleString()} routes processed`
          : `${status.remaining.toLocaleString()} route${status.remaining !== 1 ? 's' : ''} not yet geocoded`
        }
      </div>
      <div className="funstats-challenge-bar-wrap">
        <div className="funstats-challenge-bar" style={{ width: `${pct}%` }} />
      </div>
      {running && (
        <>
          {detail && <div className="funstats-backfill-detail">{detail}</div>}
          <div className="funstats-backfill-note">Runs on the server, so it keeps going if you close this page.</div>
          {!job.stopping && (
            <button className="funstats-reindex-btn" onClick={stop}>Stop</button>
          )}
        </>
      )}
      {!running && (
        <button className="funstats-backfill-btn" onClick={start}>
          Compute {label}
        </button>
      )}
    </div>
  );
}

export default function FunStats() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isTempChartExpanded, setIsTempChartExpanded] = useState(false);
  const [tempChartClosing, setTempChartClosing] = useState(false);
  const { convertDistance, convertSpeed, convertTemperature, distanceUnit, speedUnit, temperatureUnit } = useUnits();

  const openTempChart = () => { setTempChartClosing(false); setIsTempChartExpanded(true); };
  const closeTempChart = useCallback(() => {
    setTempChartClosing(true);
    setTimeout(() => { setIsTempChartExpanded(false); setTempChartClosing(false); }, 250);
  }, []);
  const handleTempChartKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openTempChart();
    }
  };

  const [geoLabels, setGeoLabels] = useState(new Map());
  const geoCacheRef = useRef(new Map());
  const expandedTempChartRef = useRef(null);

  useEffect(() => {
    fetch('/api/fun-stats', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Failed to load stats'); return r.json(); })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const reloadStats = useCallback(() => {
    fetch('/api/fun-stats', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(stats => { if (stats) setData(stats); })
      .catch(() => {});
  }, []);

  const citiesBackfill = useGeoBackfill('cities', reloadStats);
  const placesBackfill = useGeoBackfill('places', reloadStats);

  useEffect(() => {
    if (!data) return;

    const coords = [];
    if (data.furthestPointCoord) coords.push(data.furthestPointCoord);
    if (data.extremePoints) {
      for (const key of ['north', 'south', 'east', 'west']) {
        if (data.extremePoints[key]) coords.push(data.extremePoints[key]);
      }
    }
    if (data.clusters) {
      for (const c of data.clusters) coords.push([c.lat, c.lon]);
    }

    if (coords.length === 0) return;

    const unique = new Map();
    for (const [lat, lon] of coords) {
      const key = `${lat},${lon}`;
      if (!unique.has(key) && !geoCacheRef.current.has(key)) unique.set(key, [lat, lon]);
    }

    if (unique.size === 0) {
      setGeoLabels(new Map(geoCacheRef.current));
      return;
    }

    Promise.allSettled(
      [...unique.entries()].map(async ([key, [lat, lon]]) => {
        const geo = await reverseGeocode(lat, lon);
        return [key, geo];
      })
    ).then(results => {
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const [key, geo] = r.value;
          geoCacheRef.current.set(key, geo);
        }
      }
      setGeoLabels(new Map(geoCacheRef.current));
    });
  }, [data]);

  useEffect(() => {
    if (!isTempChartExpanded) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeTempChart();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTempChartExpanded, closeTempChart]);

  const ct = (f) => convertTemperature(f);
  const tempTimeline = useMemo(() => data?.weather?.tempTimeline ?? [], [data]);

  // Temperature timeline chart data
  const tempChartData = useMemo(() => {
    if (!tempTimeline.length) return null;
    return {
      labels: tempTimeline.map(t => {
        const d = new Date(t.date + 'T00:00:00');
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }),
      datasets: [
        {
          label: `Temperature (${temperatureUnit})`,
          data: tempTimeline.map(t => Number(convertTemperature(t.temp)?.toFixed(1))),
          borderColor: getAccentRgba(0.9),
          backgroundColor: getAccentRgba(0.1),
          fill: true,
          tension: 0.3,
          pointRadius: tempTimeline.length > 60 ? 0 : 2,
          pointHoverRadius: 4,
          borderWidth: 1.5,
        },
        ...(tempTimeline.some(t => t.feelsLike != null) ? [{
          label: `Feels Like (${temperatureUnit})`,
          data: tempTimeline.map(t => t.feelsLike != null ? Number(convertTemperature(t.feelsLike)?.toFixed(1)) : null),
          borderColor: 'rgba(100, 180, 255, 0.7)',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 1,
          borderDash: [4, 3],
        }] : []),
      ],
    };
  }, [tempTimeline, temperatureUnit, convertTemperature]);

  const tempChartOptions = useMemo(() => createTempChartOptions(tempTimeline), [tempTimeline]);
  const expandedTempChartOptions = useMemo(() => createTempChartOptions(tempTimeline, true), [tempTimeline]);

  // Comfort zone: max bucket for bar scaling
  const tempBucketMax = data?.weather?.tempBuckets?.length > 0
    ? Math.max(...data.weather.tempBuckets.map(b => b.count))
    : 1;

  if (loading) {
    return (
      <div id="main-app" className="settings-page">
        <main className="funstats-main">
          <div className="funstats-container">
            <div className="funstats-loading"><div className="funstats-spinner" /></div>
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div id="main-app" className="settings-page">
        <main className="funstats-main">
          <div className="funstats-container">
            <div className="funstats-empty"><h2>Error</h2><p>{error}</p></div>
          </div>
        </main>
      </div>
    );
  }

  if (!data || data.empty) {
    return (
      <div id="main-app" className="settings-page">
        <main className="funstats-main">
          <div className="funstats-container">
            <div className="funstats-empty"><h2>No Data Yet</h2><p>Record some journeys to see your fun stats!</p></div>
          </div>
        </main>
      </div>
    );
  }

  const cd = (miles) => convertDistance(miles);
  const cs = (mph) => convertSpeed(mph);
  const seasonLabel = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const modeLabel = (m) => m === 'drive' ? 'Driving' : m === 'scooter' ? 'Scooter' : m === 'train' ? 'Train' : m === 'metro' ? 'Metro' : 'Walking';
  const habitInsights = data.habitInsights || {};
  const routineExplorerIndex = habitInsights.routineExplorer?.index;
  const routineExplorerLabel = !Number.isFinite(routineExplorerIndex)
    ? 'Balanced'
    : routineExplorerIndex >= 10
      ? 'Routine'
      : routineExplorerIndex <= -10
        ? 'Explorer'
        : 'Balanced';
  const predictableWeekdayHour = Number.isFinite(habitInsights.mostPredictableWeekday?.avgStartHour)
    ? ((Math.round(habitInsights.mostPredictableWeekday.avgStartHour) % 24) + 24) % 24
    : null;

  const geoName = (lat, lon) => {
    const geo = geoLabels.get(`${lat},${lon}`);
    if (!geo) return null;
    const place = geo.place_name && geo.place_name !== 'unknown' ? geo.place_name : null;
    const city = geo.city && geo.city !== 'unknown' ? geo.city : null;
    const sc = geo.state_code || geo.country_code || null;
    if (place && city) return `${place}, ${city}`;
    if (city && sc) return `${city}, ${sc}`;
    if (city) return city;
    if (place) return place;
    return null;
  };

  const geoCity = (lat, lon) => {
    const geo = geoLabels.get(`${lat},${lon}`);
    if (!geo) return null;
    const city = geo.city && geo.city !== 'unknown' ? geo.city : null;
    const sc = geo.state_code || geo.country_code || null;
    if (city && sc) return `${city}, ${sc}`;
    if (city) return city;
    return null;
  };

  // Monthly chart max for bar scaling
  const chartMax = data.monthlyChart?.length > 0
    ? Math.max(...data.monthlyChart.map(m => m.distanceMiles))
    : 1;
  const monthlyChartWidth = data?.monthlyChart?.length
    ? `max(100%, ${data.monthlyChart.length * 32}px)`
    : '100%';

  // Activity heatmap: build 52-week grid from today
  const heatmapWeeks = [];
  if (data.activityHeatmap) {
    const today = new Date();
    for (let w = 51; w >= 0; w--) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(today);
        date.setDate(date.getDate() - (w * 7 + (6 - d)));
        const key = date.toISOString().slice(0, 10);
        week.push({ date: key, count: data.activityHeatmap[key] || 0 });
      }
      heatmapWeeks.push(week);
    }
  }

  const heatColor = (count) => {
    if (count === 0) return 'var(--bg-tertiary)';
    if (count === 1) return 'rgba(2, 216, 127, 0.3)';
    if (count === 2) return 'rgba(2, 216, 127, 0.5)';
    if (count <= 4) return 'rgba(2, 216, 127, 0.7)';
    return 'rgba(2, 216, 127, 0.9)';
  };

  // Next 3 locked achievements for progress bars
  const nextAchievements = (data.achievementProgress || [])
    .filter(a => !a.unlocked && a.current > 0)
    .sort((a, b) => (b.current / b.target) - (a.current / a.target))
    .slice(0, 4);

  return (
    <div id="main-app" className="settings-page">
      <main className="funstats-main">
        <div className="funstats-container">

          {/* Level & Spirit Animal header */}
          <section className="funstats-panel funstats-hero">
            <div className="funstats-hero-row">
              {data.spiritAnimal && (
                <div className="funstats-spirit">
                  <span className="funstats-spirit-icon">{
                    { hawk: '\uD83E\uDD85', fox: '\uD83E\uDD8A', bear: '\uD83D\uDC3B', dolphin: '\uD83D\uDC2C',
                      wolf: '\uD83D\uDC3A', owl: '\uD83E\uDD89', eagle: '\uD83E\uDD85', hummingbird: '\uD83D\uDC26' }[data.spiritAnimal.key]
                  }</span>
                  <div className="funstats-spirit-info">
                    <span className="funstats-spirit-name">{data.spiritAnimal.name}</span>
                    <span className="funstats-spirit-trait">{data.spiritAnimal.trait}</span>
                  </div>
                </div>
              )}
              {data.level && (
                <div className="funstats-level">
                  <div className="funstats-level-header">
                    <span className="funstats-level-name">{data.level.name}</span>
                    <span className="funstats-level-xp">{data.level.xp.toLocaleString()} XP</span>
                  </div>
                  {data.level.nextLevelXp && (
                    <div className="funstats-level-bar-wrap">
                      <div className="funstats-level-bar"
                        style={{ width: `${Math.min(100, ((data.level.xp - data.level.currentLevelXp) / (data.level.nextLevelXp - data.level.currentLevelXp)) * 100)}%` }}
                      />
                    </div>
                  )}
                  {data.level.nextLevelName && (
                    <span className="funstats-level-next">Next: {data.level.nextLevelName}</span>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Travel Profile */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">Travel Profile</h2>
            <div className="funstats-profile-grid">
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Total Distance</span>
                <span className="funstats-profile-value">{cd(data.totalDistance)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Total Journeys</span>
                <span className="funstats-profile-value">{data.totalRoutes.toLocaleString()}</span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Time Traveled</span>
                <span className="funstats-profile-value">{data.totalTimeMs > 0 ? formatCompactDurationMs(data.totalTimeMs) : '--'}</span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Avg Speed</span>
                <span className="funstats-profile-value">{cs(data.avgSpeed)?.toFixed(1) ?? '--'}<span className="unit">{speedUnit}</span></span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Top Speed</span>
                <span className="funstats-profile-value">{cs(data.topSpeed)?.toFixed(0) ?? '--'}<span className="unit">{speedUnit}</span></span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Avg Journey</span>
                <span className="funstats-profile-value">{cd(data.avgJourneyDistanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Per Week</span>
                <span className="funstats-profile-value">{data.journeysPerWeek.toFixed(1)}<span className="unit">journeys</span></span>
              </div>
            </div>
          </section>

          {/* How Far Is That? */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">How Far Is That?</h2>
            <div className="funstats-stat-grid">
              <div className="funstats-stat-card">
                <h4>Around the Earth</h4>
                <div className="value">{data.funComparisons.earthLaps >= 1 ? `${data.funComparisons.earthLaps.toFixed(1)}x` : `${(data.funComparisons.earthLaps * 100).toFixed(1)}%`}</div>
                <div className="sub">of Earth's circumference</div>
              </div>
              <div className="funstats-stat-card">
                <h4>To the Moon</h4>
                <div className="value">{data.funComparisons.moonPercent.toFixed(2)}%</div>
                <div className="sub">of the way there</div>
              </div>
              <div className="funstats-stat-card">
                <h4>Data Points</h4>
                <div className="value">{data.totalDataPoints.toLocaleString()}</div>
                <div className="sub">GPS coordinates recorded</div>
              </div>
            </div>
          </section>

          {/* States Visited */}
          {data.statesVisited?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">States Visited</h2>
              <div className="funstats-states-count">{data.statesVisited.length} <span>/ 50 states</span></div>
              <USStateMap visitedStates={data.statesVisited} />
            </section>
          )}

          {/* Cities Passed Through */}
          {(data.citiesPassed?.length > 0 || citiesBackfill.running || citiesBackfill.status?.remaining > 0) && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Cities Passed Through</h2>
              {data.citiesPassed?.length > 0 && (
                <div className="funstats-states-count">{data.citiesPassed.length} <span>cities</span></div>
              )}
              <GeoBackfillStatus kind="cities" backfill={citiesBackfill} />
            </section>
          )}

          {/* Unique Places */}
          {(data.uniquePlaces?.length > 0 || placesBackfill.running || placesBackfill.status?.remaining > 0) && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Unique Places</h2>
              {data.uniquePlaces?.length > 0 && (
                <div className="funstats-states-count">{data.uniquePlaces.length} <span>unique places you&apos;ve visited</span></div>
              )}
              <GeoBackfillStatus kind="places" backfill={placesBackfill} />
            </section>
          )}

          {/* Monthly Distance Chart */}
          {data.monthlyChart?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Distance Over Time</h2>
              {data.yoyComparison && (
                <div className="funstats-yoy">
                  {data.yoyComparison.changePercent >= 0
                    ? <span className="funstats-yoy-up">+{data.yoyComparison.changePercent}% vs last year</span>
                    : <span className="funstats-yoy-down">{data.yoyComparison.changePercent}% vs last year</span>
                  }
                </div>
              )}
              {data.monthlyChallenge && (
                <div className="funstats-challenge">
                  <span className="funstats-challenge-label">Monthly challenge: beat last month's {cd(data.monthlyChallenge.targetMiles)?.toFixed(0)} {distanceUnit}</span>
                  <div className="funstats-challenge-bar-wrap">
                    <div className="funstats-challenge-bar" style={{ width: `${data.monthlyChallenge.percent}%` }} />
                  </div>
                  <span className="funstats-challenge-pct">{data.monthlyChallenge.percent}%{data.monthlyChallenge.beatLastMonth ? ' — Done!' : ''}</span>
                </div>
              )}
              <div className="funstats-barchart-scroll">
                <div className="funstats-barchart" style={{ width: monthlyChartWidth }}>
                  {data.monthlyChart.map((m) => (
                    <div key={m.month} className="funstats-bar-col" title={`${formatShortMonth(m.month)}: ${cd(m.distanceMiles)?.toFixed(0)} ${distanceUnit}`}>
                      <div className="funstats-bar" style={{ height: `${Math.max(2, (m.distanceMiles / chartMax) * 100)}%` }} />
                      <span className="funstats-bar-label">{formatShortMonth(m.month)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Temperature Over Time */}
          {tempChartData && tempTimeline.length > 2 && (
            <section className="funstats-panel">
              <div className="funstats-panel-heading">
                <h2 className="funstats-panel-title">Temperature Over Time</h2>
                <button
                  type="button"
                  className="funstats-chart-expand-button"
                  onClick={openTempChart}
                >
                  Expand
                </button>
              </div>
              <div
                className="funstats-temp-chart-wrap funstats-temp-chart-wrap--interactive"
                role="button"
                tabIndex={0}
                onClick={openTempChart}
                onKeyDown={handleTempChartKeyDown}
                aria-label="Open a larger view of the temperature graph"
              >
                <Line data={tempChartData} options={tempChartOptions} />
              </div>
              <div className="funstats-temp-chart-hint">Tap or click the graph for a larger view.</div>
            </section>
          )}

          {/* Weather Overview */}
          {data.weather && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Weather</h2>
              <div className="funstats-weather-summary">
                {data.weather.journeysWithWeather} of {data.totalRoutes} journeys have weather data
              </div>
              <div className="funstats-stat-grid">
                <div className="funstats-stat-card">
                  <h4>Avg Temperature</h4>
                  <div className="value">{ct(data.weather.avgTemp)?.toFixed(1) ?? '--'}<span className="unit">{temperatureUnit}</span></div>
                </div>
                {data.weather.hottestJourney && (
                  <div className="funstats-stat-card">
                    <h4>Hottest Journey</h4>
                    <div className="value">{ct(data.weather.hottestJourney.temp)?.toFixed(1) ?? '--'}<span className="unit">{temperatureUnit}</span></div>
                    <div className="sub">{data.weather.hottestJourney.name || formatDate(data.weather.hottestJourney.date)}</div>
                  </div>
                )}
                {data.weather.coldestJourney && (
                  <div className="funstats-stat-card">
                    <h4>Coldest Journey</h4>
                    <div className="value">{ct(data.weather.coldestJourney.temp)?.toFixed(1) ?? '--'}<span className="unit">{temperatureUnit}</span></div>
                    <div className="sub">{data.weather.coldestJourney.name || formatDate(data.weather.coldestJourney.date)}</div>
                  </div>
                )}
                <div className="funstats-stat-card">
                  <h4>Temperature Range</h4>
                  <div className="value">{ct(data.weather.tempRange.min)?.toFixed(0)}° – {ct(data.weather.tempRange.max)?.toFixed(0)}°</div>
                  <div className="sub">{(ct(data.weather.tempRange.max) - ct(data.weather.tempRange.min))?.toFixed(0)}° spread</div>
                </div>
                {data.weather.biggestFeelsLikeDiff && (
                  <div className="funstats-stat-card">
                    <h4>Biggest Feels-Like Gap</h4>
                    <div className="value">{ct(data.weather.biggestFeelsLikeDiff.temp)?.toFixed(0)}° felt like {ct(data.weather.biggestFeelsLikeDiff.feelsLike)?.toFixed(0)}°</div>
                    <div className="sub">{data.weather.biggestFeelsLikeDiff.name || formatDate(data.weather.biggestFeelsLikeDiff.date)}</div>
                  </div>
                )}
                {data.weather.avgWindSpeed != null && (
                  <div className="funstats-stat-card">
                    <h4>Avg Wind Speed</h4>
                    <div className="value">{data.weather.avgWindSpeed}<span className="unit">mph</span></div>
                  </div>
                )}
                {data.weather.windiestJourney && data.weather.windiestJourney.windSpeed > 0 && (
                  <div className="funstats-stat-card">
                    <h4>Windiest Journey</h4>
                    <div className="value">{data.weather.windiestJourney.windSpeed.toFixed(1)}<span className="unit">mph</span></div>
                    <div className="sub">{data.weather.windiestJourney.name || formatDate(data.weather.windiestJourney.date)}</div>
                  </div>
                )}
              </div>
            </section>
          )}


          {/* Weather Conditions Breakdown */}
          {data.weather?.conditions?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Weather Conditions</h2>
              <div className="funstats-conditions-list">
                {data.weather.conditions.map(c => (
                  <div key={c.condition} className="funstats-condition-row">
                    <span className="funstats-condition-label">{c.condition}</span>
                    <div className="funstats-condition-bar-wrap">
                      <div
                        className="funstats-condition-bar"
                        style={{ width: `${(c.count / data.weather.conditions[0].count) * 100}%` }}
                      />
                    </div>
                    <span className="funstats-condition-count">{c.count}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Comfort Zone */}
          {data.weather?.tempBuckets?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Comfort Zone</h2>
              <div className="funstats-temp-histogram">
                {data.weather.tempBuckets.map(b => (
                  <div key={b.rangeStart} className="funstats-temp-bucket" title={`${ct(b.rangeStart)?.toFixed(0)}°–${ct(b.rangeStart + 10)?.toFixed(0)}°: ${b.count} journeys`}>
                    <div className="funstats-temp-bucket-bar" style={{ height: `${Math.max(4, (b.count / tempBucketMax) * 100)}%` }} />
                    <span className="funstats-temp-bucket-label">{ct(b.rangeStart)?.toFixed(0)}°</span>
                  </div>
                ))}
              </div>
              <div className="funstats-temp-histogram-sub">Temperature ranges you travel in most</div>
            </section>
          )}

          {/* Temperature by Season */}
          {data.weather?.seasonAvgTemps && Object.values(data.weather.seasonAvgTemps).some(v => v != null) && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Temperature by Season</h2>
              <div className="funstats-stat-grid">
                {[['Spring', 'spring'], ['Summer', 'summer'], ['Fall', 'fall'], ['Winter', 'winter']].map(([label, key]) => {
                  const avg = data.weather.seasonAvgTemps[key];
                  if (avg == null) return null;
                  return (
                    <div key={key} className="funstats-stat-card">
                      <h4>{label}</h4>
                      <div className="value">{ct(avg)?.toFixed(1) ?? '--'}<span className="unit">{temperatureUnit}</span></div>
                      <div className="sub">avg temperature</div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Activity Heatmap */}
          {heatmapWeeks.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Activity</h2>
              <div className="funstats-heatmap-scroll">
                <div className="funstats-heatmap">
                  {heatmapWeeks.map((week, wi) => (
                    <div key={wi} className="funstats-heatmap-col">
                      {week.map((day) => (
                        <div
                          key={day.date}
                          className="funstats-heatmap-cell"
                          style={{ background: heatColor(day.count) }}
                          title={`${day.date}: ${day.count} journeys`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Exploration */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">Exploration</h2>
            <div className="funstats-stat-grid">
              <div className="funstats-stat-card">
                <h4>Exploration Score</h4>
                <div className="value">{data.explorationScore.toFixed(1)}%</div>
                <div className="sub">Unique area coverage</div>
              </div>
              <div className="funstats-stat-card">
                <h4>Coverage Radius</h4>
                <div className="value">{cd(data.coverageRadiusMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                <div className="sub">Max range from home</div>
              </div>
              <div className="funstats-stat-card">
                <h4>Furthest Point</h4>
                <div className="value">{cd(data.furthestPointMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                {data.furthestPointCoord && <div className="sub">{geoCity(data.furthestPointCoord[0], data.furthestPointCoord[1]) || `${data.furthestPointCoord[0].toFixed(4)}, ${data.furthestPointCoord[1].toFixed(4)}`}</div>}
              </div>
              <div className="funstats-stat-card">
                <h4>Route Diversity</h4>
                <div className="value">{data.routeDiversity.toFixed(1)}%</div>
                <div className="sub">Unique route pairs</div>
              </div>
              {data.favoriteDirection && (
                <div className="funstats-stat-card">
                  <h4>Favorite Direction</h4>
                  <div className="value">{data.favoriteDirection.direction}</div>
                  <div className="sub">{data.favoriteDirection.count} journeys headed this way</div>
                </div>
              )}
              {data.newTerritory && data.newTerritory.newCellsThisMonth > 0 && (
                <div className="funstats-stat-card">
                  <h4>New Territory</h4>
                  <div className="value">{data.newTerritory.newCellsThisMonth}</div>
                  <div className="sub">New locations this month</div>
                </div>
              )}
            </div>
          </section>

          {/* Extreme Points */}
          {data.extremePoints && (data.extremePoints.north || data.extremePoints.south) && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Extreme Points</h2>
              <div className="funstats-stat-grid">
                {[['Northernmost', 'north'], ['Southernmost', 'south'], ['Easternmost', 'east'], ['Westernmost', 'west']].map(([label, key]) => {
                  const pt = data.extremePoints[key];
                  if (!pt) return null;
                  const name = geoCity(pt[0], pt[1]);
                  return (
                    <div key={key} className="funstats-stat-card">
                      <h4>{label}</h4>
                      <div className="value" style={{ fontSize: '1rem' }}>{name || `${pt[0].toFixed(4)}, ${pt[1].toFixed(4)}`}</div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Speed Distribution Chart */}
          {data.speedPercentiles && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Speed Distribution</h2>
              <div style={{ height: 220, position: 'relative' }}>
                <Bar
                  data={{
                    labels: ['25th %ile', 'Median', '75th %ile', '95th %ile'],
                    datasets: [{
                      label: `Avg Speed (${speedUnit})`,
                      data: ['p25', 'p50', 'p75', 'p95'].map(k => cs(data.speedPercentiles[k])?.toFixed(1) ?? 0),
                      backgroundColor: [
                        getAccentRgba(0.4),
                        getAccentRgba(0.6),
                        getAccentRgba(0.8),
                        getAccentRgba(1),
                      ],
                      borderColor: getAccentRgba(1),
                      borderWidth: 1,
                      borderRadius: 4,
                    }],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      legend: { display: false },
                      tooltip: {
                        callbacks: {
                          label: (ctx) => `${ctx.parsed.y} ${speedUnit}`,
                        },
                      },
                    },
                    scales: {
                      x: {
                        ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 11 } },
                        grid: { display: false },
                      },
                      y: {
                        ticks: {
                          color: 'rgba(255,255,255,0.5)',
                          font: { size: 11 },
                          callback: (v) => `${v} ${speedUnit}`,
                        },
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        beginAtZero: true,
                      },
                    },
                  }}
                />
              </div>
            </section>
          )}

          {/* Habits & Patterns */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">Habits & Patterns</h2>
            <div className="funstats-stat-grid">
              {data.timeOfDay?.[0]?.count > 0 && (
                <div className="funstats-stat-card">
                  <h4>Time of Day</h4>
                  <div className="value">{data.timeOfDay[0].name}</div>
                  <div className="sub">{data.timeOfDay.filter(t => t.count > 0).map(t => `${t.name}: ${t.count}`).join(', ')}</div>
                </div>
              )}
              <div className="funstats-stat-card">
                <h4>Weekday vs Weekend</h4>
                <div className="value">{data.weekendPercent}% weekend</div>
                <div className="sub">{data.weekdayCount} weekday, {data.weekendCount} weekend</div>
              </div>
              {data.peakDayOfWeek && (
                <div className="funstats-stat-card">
                  <h4>Most Active Day</h4>
                  <div className="value">{data.peakDayOfWeek.day}</div>
                  <div className="sub">{data.peakDayOfWeek.count} journeys</div>
                </div>
              )}
              {data.peakHour && (
                <div className="funstats-stat-card">
                  <h4>Peak Hour</h4>
                  <div className="value">{formatHour(data.peakHour.hour)}</div>
                  <div className="sub">{data.peakHour.count} journeys</div>
                </div>
              )}
              {data.favoriteSeason?.count > 0 && (
                <div className="funstats-stat-card">
                  <h4>Favorite Season</h4>
                  <div className="value">{seasonLabel(data.favoriteSeason.season)}</div>
                  <div className="sub">{data.favoriteSeason.count} journeys, {cd(data.favoriteSeason.distanceMiles)?.toFixed(0) ?? '--'} {distanceUnit}</div>
                </div>
              )}
              {data.longestStreak > 0 && (
                <div className="funstats-stat-card">
                  <h4>Longest Streak</h4>
                  <div className="value">{data.longestStreak} days</div>
                  <div className="sub">{data.longestStreakStart && data.longestStreakEnd ? `${formatDate(data.longestStreakStart)} – ${formatDate(data.longestStreakEnd)}` : ''}</div>
                </div>
              )}
              {data.currentStreak > 0 && (
                <div className="funstats-stat-card">
                  <h4>Current Streak</h4>
                  <div className="value">{data.currentStreak} days</div>
                  <div className="sub">Keep it going!</div>
                </div>
              )}
              {data.busiestDay && (
                <div className="funstats-stat-card">
                  <h4>Busiest Day</h4>
                  <div className="value">{data.busiestDay.count} journeys</div>
                  <div className="sub">{formatDate(data.busiestDay.date)}</div>
                </div>
              )}
              {data.longestBreak && (
                <div className="funstats-stat-card">
                  <h4>Longest Break</h4>
                  <div className="value">{formatCompactDurationMs(data.longestBreak.durationMs)}</div>
                  <div className="sub">Your longest hiatus</div>
                </div>
              )}
              {habitInsights.startTimeConsistencyHours != null && (
                <div className="funstats-stat-card">
                  <h4>Start-Time Consistency</h4>
                  <div className="value">{habitInsights.startTimeConsistencyHours.toFixed(1)}h</div>
                  <div className="sub">Lower means more routine start times</div>
                </div>
              )}
              {habitInsights.commuteWindow && (
                <div className="funstats-stat-card">
                  <h4>Commute Window</h4>
                  <div className="value">{habitInsights.commuteWindow.percent}%</div>
                  <div className="sub">{habitInsights.commuteWindow.count} weekday journeys in 6-9 AM or 4-7 PM</div>
                </div>
              )}
              {habitInsights.routineExplorer && (
                <div className="funstats-stat-card">
                  <h4>Routine vs Explorer</h4>
                  <div className="value">{routineExplorerLabel}</div>
                  <div className="sub">
                    {`Index ${formatSigned(habitInsights.routineExplorer.index)} (${habitInsights.routineExplorer.repeatedRouteRate}% repeat vs ${habitInsights.routineExplorer.newTerritoryRate}% new territory)`}
                  </div>
                </div>
              )}
              {habitInsights.activeDays30 && (
                <div className="funstats-stat-card">
                  <h4>Active Days / 30</h4>
                  <div className="value">{habitInsights.activeDays30.current} / 30</div>
                  <div className="sub">{`${formatSigned(habitInsights.activeDays30.delta, 0)} vs previous 30 days`}</div>
                </div>
              )}
              {habitInsights.burstiness && (
                <div className="funstats-stat-card">
                  <h4>Burstiness Score</h4>
                  <div className="value">{habitInsights.burstiness.percent}%</div>
                  <div className="sub">{habitInsights.burstiness.top10JourneyCount} journeys on your top 10 busiest days</div>
                </div>
              )}
              {habitInsights.medianGapDays != null && (
                <div className="funstats-stat-card">
                  <h4>Median Gap</h4>
                  <div className="value">{habitInsights.medianGapDays.toFixed(1)} days</div>
                  <div className="sub">Typical gap between active days</div>
                </div>
              )}
              {habitInsights.modeSwitch?.transitions > 0 && (
                <div className="funstats-stat-card">
                  <h4>Mode Switch Rate</h4>
                  <div className="value">{habitInsights.modeSwitch.percent}%</div>
                  <div className="sub">{habitInsights.modeSwitch.switches} switches across {habitInsights.modeSwitch.transitions} transitions</div>
                </div>
              )}
              {habitInsights.weekendDistanceBias && (
                <div className="funstats-stat-card">
                  <h4>Weekend Distance Bias</h4>
                  <div className="value">{formatSigned(habitInsights.weekendDistanceBias.biasPercent)}%</div>
                  <div className="sub">{habitInsights.weekendDistanceBias.distancePercent}% weekend distance vs {habitInsights.weekendDistanceBias.tripPercent}% weekend trips</div>
                </div>
              )}
              {habitInsights.mostPredictableWeekday && (
                <div className="funstats-stat-card">
                  <h4>Most Predictable Weekday</h4>
                  <div className="value">{habitInsights.mostPredictableWeekday.day}</div>
                  <div className="sub">
                    {predictableWeekdayHour != null
                      ? `${formatHour(predictableWeekdayHour)} starts, spread ${habitInsights.mostPredictableWeekday.stdDevHours.toFixed(1)}h`
                      : `${habitInsights.mostPredictableWeekday.sampleCount} journeys`}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Travel Modes */}
          {data.modeCounts && (data.modeCounts.drive + data.modeCounts.scooter + data.modeCounts.foot + (data.modeCounts.train || 0) + (data.modeCounts.metro || 0) > 0) && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Travel Modes</h2>
              <div className="funstats-stat-grid">
                {['drive', 'scooter', 'foot', 'train', 'metro'].filter(m => data.modeCounts[m] > 0).map(m => (
                  <div key={m} className="funstats-stat-card">
                    <h4>{modeLabel(m)}</h4>
                    <div className="value">{data.modeCounts[m]}</div>
                    <div className="sub">{cd(data.modeDistances[m])?.toFixed(1) ?? '--'} {distanceUnit} · {((data.modeCounts[m] / data.totalRoutes) * 100).toFixed(0)}%</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Elevation */}
          {data.elevation && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Elevation</h2>
              <div className="funstats-stat-grid">
                <div className="funstats-stat-card">
                  <h4>Total Gain</h4>
                  <div className="value">{data.elevation.totalGainFt.toLocaleString()}<span className="unit">ft</span></div>
                </div>
                <div className="funstats-stat-card">
                  <h4>Total Loss</h4>
                  <div className="value">{data.elevation.totalLossFt.toLocaleString()}<span className="unit">ft</span></div>
                </div>
                {data.elevation.peakElevationFt != null && (
                  <div className="funstats-stat-card">
                    <h4>Peak Elevation</h4>
                    <div className="value">{data.elevation.peakElevationFt.toLocaleString()}<span className="unit">ft</span></div>
                  </div>
                )}
                {data.elevation.totalGainFt > 0 && (
                  <div className="funstats-stat-card">
                    <h4>Everests Climbed</h4>
                    <div className="value">{(data.elevation.totalGainFt / 29032).toFixed(1)}x</div>
                    <div className="sub">29,032 ft each</div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Superlatives */}
          {data.superlatives?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Journey Superlatives</h2>
              <div className="funstats-stat-grid">
                {data.superlatives.map((s, i) => (
                  <div key={i} className="funstats-stat-card">
                    <h4>{s.title}</h4>
                    <div className="value" style={{ fontSize: '0.95rem' }}>{s.desc}</div>
                    <div className="sub">{s.detail}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Achievement Progress */}
          {nextAchievements.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Next Up</h2>
              <div className="funstats-progress-list">
                {nextAchievements.map(a => {
                  const pct = Math.min(100, (a.current / a.target) * 100);
                  return (
                    <div key={a.key} className="funstats-progress-item">
                      <div className="funstats-progress-header">
                        <span className="funstats-progress-title">{a.title}</span>
                        <span className="funstats-progress-nums">{Math.round(a.current)} / {a.target} {a.unit}</span>
                      </div>
                      <div className="funstats-progress-bar-wrap">
                        <div className="funstats-progress-bar" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Records */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">Records</h2>
            <div className="funstats-stat-grid">
              {data.longestByDistance && (
                <div className="funstats-stat-card">
                  <h4>Longest Journey</h4>
                  <div className="value">{cd(data.longestByDistance.distanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{data.longestByDistance.name || data.longestByDistance.date}</div>
                </div>
              )}
              {data.shortestByDistance && (
                <div className="funstats-stat-card">
                  <h4>Shortest Journey</h4>
                  <div className="value">{cd(data.shortestByDistance.distanceMiles)?.toFixed(2) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{data.shortestByDistance.name || data.shortestByDistance.date}</div>
                </div>
              )}
              {data.longestByTime && (
                <div className="funstats-stat-card">
                  <h4>Longest by Time</h4>
                  <div className="value">{formatCompactDurationMs(data.longestByTime.durationMs)}</div>
                  <div className="sub">{data.longestByTime.name || data.longestByTime.date}</div>
                </div>
              )}
              {data.fastestByAvgSpeed && (
                <div className="funstats-stat-card">
                  <h4>Fastest Avg Speed</h4>
                  <div className="value">{cs(data.fastestByAvgSpeed.avgSpeedMph)?.toFixed(1) ?? '--'}<span className="unit">{speedUnit}</span></div>
                  <div className="sub">{data.fastestByAvgSpeed.name || data.fastestByAvgSpeed.date}</div>
                </div>
              )}
              {data.mostProductiveDay && (
                <div className="funstats-stat-card">
                  <h4>Best Day</h4>
                  <div className="value">{cd(data.mostProductiveDay.distanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{formatDate(data.mostProductiveDay.date)}</div>
                </div>
              )}
              {data.mostProductiveMonth && (
                <div className="funstats-stat-card">
                  <h4>Best Month</h4>
                  <div className="value">{cd(data.mostProductiveMonth.distanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{formatMonth(data.mostProductiveMonth.month)}</div>
                </div>
              )}
              {data.mostProductiveWeek && (
                <div className="funstats-stat-card">
                  <h4>Best Week</h4>
                  <div className="value">{cd(data.mostProductiveWeek.distanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{formatDate(data.mostProductiveWeek.startDate)} – {formatDate(data.mostProductiveWeek.endDate)}</div>
                </div>
              )}
            </div>
          </section>


          {/* Most Visited Locations */}
          {data.clusters?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Most Visited Locations</h2>
              <ul className="funstats-cluster-list">
                {data.clusters.map((c, i) => {
                  const name = geoName(c.lat, c.lon);
                  return (
                    <li key={i} className="funstats-cluster-item">
                      <span className="funstats-cluster-rank">{i + 1}</span>
                      <div className="funstats-cluster-info">
                        <div className="funstats-cluster-coord">{name || `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`}</div>
                        <div className="funstats-cluster-visits">{c.visitCount} departure{c.visitCount !== 1 ? 's' : ''}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {isTempChartExpanded && tempChartData && (
            <div
              className={`funstats-chart-modal-backdrop${tempChartClosing ? ' funstats-chart-modal-backdrop--closing' : ''}`}
              role="presentation"
              onClick={closeTempChart}
            >
              <div
                className="funstats-chart-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="funstats-temp-chart-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="funstats-chart-modal-header">
                  <div>
                    <h2 id="funstats-temp-chart-title" className="funstats-chart-modal-title">
                      Temperature Over Time
                    </h2>
                    <p className="funstats-chart-modal-subtitle">
                      Scroll to zoom. Drag to pan. Shift+drag to select a range.
                    </p>
                  </div>
                  <div className="funstats-chart-modal-actions">
                    <button
                      type="button"
                      className="funstats-chart-modal-close"
                      onClick={() => expandedTempChartRef.current?.resetZoom()}
                    >
                      Reset Zoom
                    </button>
                    <button
                      type="button"
                      className="funstats-chart-modal-close"
                      onClick={closeTempChart}
                      aria-label="Close expanded temperature graph"
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div className="funstats-chart-modal-body">
                  <Line ref={expandedTempChartRef} data={tempChartData} options={expandedTempChartOptions} />
                </div>
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
