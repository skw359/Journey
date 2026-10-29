import { useState, useEffect, useRef } from 'react';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js';
import { Link } from 'react-router-dom';
import { fetchRoutes } from '../api/journeys';
import './Wrapped.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

const MODE_COLORS = { drive: '#3498db', scooter: '#f1c40f', foot: '#2ecc71', train: '#e74c3c', metro: '#1abc9c', other: '#95a5a6' };

export default function Wrapped() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [curtainUp, setCurtainUp] = useState(false);
  const chartInnerRef = useRef(null);

  useEffect(() => {
    const load = async () => {
      try {
        const allRoutes = await fetchRoutes();
        if (allRoutes.length === 0) { setLoading(false); return; }
        allRoutes.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        const processed = processData(allRoutes);
        setData(processed);
        setTimeout(() => setCurtainUp(true), 500);
      } catch (err) { console.error(err); }
    };
    load();
  }, []);

  function processData(routes) {
    let totalMiles = 0, totalSeconds = 0, totalPhotos = 0;
    let maxDist = 0, maxDistName = '', maxSpeed = 0;
    const monthlyDistanceMap = {};
    const modeDist = { foot: 0, scooter: 0, drive: 0, train: 0, metro: 0, other: 0 };

    routes.forEach(r => {
      const dist = parseFloat(r.distance) || 0;
      totalMiles += dist;
      totalPhotos += (r.photoCount || 0);

      let dur = 0;
      if (r.startTime && r.endTime) {
        const t1 = new Date(r.startTime).getTime();
        const t2 = new Date(r.endTime).getTime();
        if (!isNaN(t1) && !isNaN(t2)) dur = (t2 - t1) / 1000;
      }
      if (!isNaN(dur) && dur > 0) totalSeconds += dur;

      const start = new Date(r.startTime);
      if (!isNaN(start.getTime())) {
        const key = `${start.getFullYear()}-${start.getMonth()}`;
        if (!monthlyDistanceMap[key]) monthlyDistanceMap[key] = 0;
        monthlyDistanceMap[key] += dist;
      }

      if (dist > maxDist) { maxDist = dist; maxDistName = r.name || 'Untitled Trip'; }
      const speed = parseFloat(r.avgSpeed) || 0;
      if (speed > maxSpeed) maxSpeed = speed;

      const m = Object.prototype.hasOwnProperty.call(modeDist, r.travelMode) ? r.travelMode : 'other';
      modeDist[m] += dist;
    });

    let dateRangeText = 'Time Unknown';
    if (routes.length > 0 && routes[0].startTime) {
      const startYear = new Date(routes[0].startTime).getFullYear();
      const endYear = new Date(routes[routes.length - 1].startTime).getFullYear();
      dateRangeText = startYear === endYear ? `${startYear}` : `${startYear} - ${endYear}`;
    }

    const chartLabels = [], chartData = [];
    const firstDate = new Date(routes[0].startTime);
    const lastDate = new Date(routes[routes.length - 1].startTime);
    let current = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1);
    const end = new Date(lastDate.getFullYear(), lastDate.getMonth(), 1);
    while (current <= end) {
      const key = `${current.getFullYear()}-${current.getMonth()}`;
      const monthName = current.toLocaleString('default', { month: 'short' });
      const yearShort = current.getFullYear().toString().substr(2);
      chartLabels.push(`${monthName} '${yearShort}`);
      chartData.push(monthlyDistanceMap[key] || 0);
      current.setMonth(current.getMonth() + 1);
    }

    const earthPct = (totalMiles / 24901) * 100;

    const modes = Object.keys(modeDist).filter(m => modeDist[m] > 0).sort((a, b) => modeDist[b] - modeDist[a]);

    return {
      totalMiles, totalSeconds, totalPhotos, totalCount: routes.length,
      maxDist, maxDistName, maxSpeed, dateRangeText, earthPct,
      chartLabels, chartData, modeDist, modes, totalDistCalc: totalMiles || 1,
    };
  }

  const chartInnerWidth = data?.chartLabels?.length > 12
    ? `${Math.max(100, data.chartLabels.length * 6)}%`
    : '100%';

  return (
    <div className="wrapped-page">
      <div className={`wrapped-loading${curtainUp ? ' curtain-up' : ''}`}>
        <h1>Loading your journey...</h1>
      </div>

      {data && (
        <div className="wrapped-container">
          <header className="wrapped-header animate-in">
            <div className="overline">Life in Motion</div>
            <h1 className="wrapped-title">ALL TIME<br />WRAPPED</h1>
            <div className="subtitle">{data.dateRangeText}</div>
          </header>

          <div className="grid">
            <div className="card animate-in delay-1">
              <div className="stat-label">Total Distance</div>
              <div className="stat-value">{data.totalMiles.toLocaleString(undefined, { maximumFractionDigits: 1 })}</div>
              <div className="stat-label">Miles</div>
            </div>
            <div className="card animate-in delay-2">
              <div className="stat-label">Total Time</div>
              <div className="stat-value">{(data.totalSeconds / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })}</div>
              <div className="stat-label">Hours</div>
            </div>
            <div className="card animate-in delay-3">
              <div className="stat-label">Journeys</div>
              <div className="stat-value">{data.totalCount}</div>
              <div className="stat-label">Trips</div>
            </div>
          </div>

          <h2 className="section-title animate-in">The Highlights</h2>
          <div className="highlight-grid animate-in">
            <div className="highlight-card">
              <div className="highlight-info">
                <h3>The Long Haul</h3>
                <p>Your longest single journey</p>
                <p style={{ fontSize: '0.8rem', marginTop: 5, opacity: 0.7 }}>{data.maxDistName}</p>
              </div>
              <div className="highlight-val">{data.maxDist.toFixed(2)} mi</div>
            </div>
            <div className="highlight-card">
              <div className="highlight-info"><h3>Need for Speed</h3><p>Highest avg speed reached</p></div>
              <div className="highlight-val">{data.maxSpeed.toFixed(1)} mph</div>
            </div>
            <div className="highlight-card">
              <div className="highlight-info"><h3>Memory Maker</h3><p>Photos taken on trips</p></div>
              <div className="highlight-val">{data.totalPhotos}</div>
            </div>
          </div>

          <h2 className="section-title animate-in">Month by Month</h2>
          <div className="chart-scroll-wrapper animate-in">
            <div className="chart-container-inner" ref={chartInnerRef} style={{ width: chartInnerWidth }}>
              <Bar
                data={{
                  labels: data.chartLabels,
                  datasets: [{ label: 'Miles', data: data.chartData, backgroundColor: '#1DB954', borderRadius: 5, barPercentage: 0.7 }],
                }}
                options={{
                  responsive: true, maintainAspectRatio: false,
                  plugins: { legend: { display: false } },
                  scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#b3b3b3' } },
                    x: { grid: { display: false }, ticks: { color: '#b3b3b3', maxRotation: 0, autoSkip: false } },
                  },
                }}
              />
            </div>
          </div>

          <h2 className="section-title animate-in">How You Moved</h2>
          <div className="animate-in">
            {data.modes.map(mode => {
              const pct = (data.modeDist[mode] / data.totalDistCalc * 100).toFixed(1);
              return (
                <div key={mode} className="mode-row">
                  <div style={{ width: 60, fontWeight: 'bold' }}>{mode.charAt(0).toUpperCase() + mode.slice(1)}</div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${pct}%`, backgroundColor: MODE_COLORS[mode] || '#fff' }} />
                  </div>
                  <div style={{ width: 80, textAlign: 'right', color: 'var(--text-muted)' }}>{data.modeDist[mode].toFixed(1)} mi</div>
                </div>
              );
            })}
          </div>

          <div className="footer animate-in">
            <p style={{ marginBottom: 20 }}>
              You've traveled <span style={{ color: 'var(--accent-1)' }}>{data.earthPct.toFixed(4)}</span>% of the way around the Earth!
            </p>
            <button className="share-btn" onClick={() => alert('Screenshot this page to share your Journey Wrapped!')}>Share Wrapped</button>
            <p style={{ marginTop: 20 }}><Link to="/journeys" style={{ color: '#666', textDecoration: 'none' }}>Back to Dashboard</Link></p>
          </div>
        </div>
      )}
    </div>
  );
}
