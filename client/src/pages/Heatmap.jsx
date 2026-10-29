import { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import Header from '../components/Header';
import TopLoader from '../components/TopLoader';
import { useTheme } from '../context/ThemeContext';
import { useUnits } from '../context/UnitsContext';
import { TILE_ATTRIBUTION } from '../utils/mapUtils';
import { fetchAllPoints } from '../api/journeys';
import './Heatmap.css';

const GRADIENTS = {
  heat: { 0.0: 'blue', 0.25: 'lime', 0.5: 'yellow', 0.75: 'orange', 1.0: 'red' },
  green: { 0.0: 'transparent', 0.2: '#90EE90', 0.4: '#32CD32', 0.6: '#228B22', 0.8: '#006400', 1.0: '#00FF00' },
  cool: { 0.0: 'transparent', 0.25: '#00FFFF', 0.5: '#0099FF', 0.75: '#0066FF', 1.0: '#0033CC' },
  purple: { 0.0: 'transparent', 0.25: '#CC99FF', 0.5: '#9966FF', 0.75: '#6633CC', 1.0: '#FF00FF' },
  orange: { 0.0: 'transparent', 0.25: '#FFCC66', 0.5: '#FF9933', 0.75: '#FF6600', 1.0: '#CC3300' },
};

const MODE_DESCRIPTIONS = {
  density: 'Showing point density - areas with more GPS points appear hotter',
  speed: 'Showing speed intensity - faster travel speeds appear hotter',
  acceleration: 'Showing acceleration intensity - rapid speed changes appear hotter',
};

export default function Heatmap() {
  const { tileUrl } = useTheme();
  const { convertDistance, distanceUnit } = useUnits();
  const [mode, setMode] = useState('density');
  const [intensity, setIntensity] = useState(15);
  const [radius, setRadius] = useState(25);
  const [blur, setBlur] = useState(15);
  const [gradient, setGradient] = useState('heat');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [stats, setStats] = useState({ totalRoutes: 0, totalDistance: 0, totalPoints: 0 });
  const [dateRange, setDateRange] = useState({ earliest: '', latest: '' });
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const tileLayerRef = useRef(null);
  const heatLayerRef = useRef(null);
  const allDataRef = useRef([]);
  const loaderRef = useRef(null);

  const calculateAcceleration = (points) => {
    return points.map((point, i) => {
      if (i > 0 && i < points.length - 1) {
        const prevSpeed = points[i - 1][3] || 0;
        const currSpeed = points[i][3] || 0;
        const nextSpeed = points[i + 1][3] || 0;
        const dt1 = (points[i][2] - points[i - 1][2]) / 1000;
        const dt2 = (points[i + 1][2] - points[i][2]) / 1000;
        let accel = 0;
        if (dt1 > 0 && dt2 > 0) {
          accel = Math.abs(((currSpeed - prevSpeed) / dt1 + (nextSpeed - currSpeed) / dt2) / 2);
        }
        return [...point, accel];
      }
      return [...point, 0];
    });
  };

  const loadData = async () => {
    loaderRef.current?.start();
    setLoading(true);
    try {
      const data = await fetchAllPoints();
      allDataRef.current = calculateAcceleration(data.points);
      setStats(data.stats);
      if (data.dateRange.earliest) {
        setStartDate(data.dateRange.earliest.split('T')[0]);
        setDateRange(prev => ({ ...prev, earliest: data.dateRange.earliest.split('T')[0] }));
      }
      if (data.dateRange.latest) {
        setEndDate(data.dateRange.latest.split('T')[0]);
        setDateRange(prev => ({ ...prev, latest: data.dateRange.latest.split('T')[0] }));
      }
      updateHeatmap(allDataRef.current);
      if (allDataRef.current.length > 0) {
        const bounds = L.latLngBounds(allDataRef.current.map(p => [p[0], p[1]]));
        mapInstanceRef.current?.fitBounds(bounds, { padding: [50, 50] });
      }
    } catch (err) { console.error(err); }
    setLoading(false);
    loaderRef.current?.finish();
  };

  const getFilteredData = useCallback(() => {
    let data = allDataRef.current;
    if (startDate || endDate) {
      const startTime = startDate ? new Date(startDate).getTime() : 0;
      const endTime = endDate ? new Date(endDate + 'T23:59:59').getTime() : Date.now();
      data = data.filter(p => p[2] >= startTime && p[2] <= endTime);
    }
    return data;
  }, [startDate, endDate]);

  const updateHeatmap = useCallback((data) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (heatLayerRef.current) map.removeLayer(heatLayerRef.current);

    let heatPoints;
    if (mode === 'density') {
      heatPoints = data.map(p => [p[0], p[1], 1]);
    } else if (mode === 'speed') {
      const speeds = data.map(p => p[3] || 0);
      const maxSpeed = Math.max(...speeds, 1);
      heatPoints = data.map(p => [p[0], p[1], (p[3] || 0) / maxSpeed]);
    } else {
      const accels = data.map(p => p[4] || 0);
      const maxAccel = Math.max(...accels, 0.1);
      heatPoints = data.map(p => [p[0], p[1], (p[4] || 0) / maxAccel]);
    }

    heatLayerRef.current = L.heatLayer(heatPoints, {
      radius, blur, maxZoom: 18, max: intensity / 10,
      gradient: GRADIENTS[gradient],
    }).addTo(map);
  }, [mode, radius, blur, intensity, gradient]);

  const handleApplyFilters = () => {
    const data = getFilteredData();
    updateHeatmap(data);
    setStats(prev => ({ ...prev, totalPoints: data.length }));
  };

  const handleReset = () => {
    setStartDate(dateRange.earliest);
    setEndDate(dateRange.latest);
    setIntensity(15); setRadius(25); setBlur(15);
    setMode('density'); setGradient('heat');
    updateHeatmap(allDataRef.current);
  };

  useEffect(() => {
    if (mapInstanceRef.current) return;
    const map = L.map(mapRef.current).setView([39.8283, -98.5795], 5);
    mapInstanceRef.current = map;
    tileLayerRef.current = L.tileLayer(tileUrl, {
      attribution: TILE_ATTRIBUTION, subdomains: 'abcd', maxZoom: 20,
    }).addTo(map);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch once the map exists
    loadData();

    return () => { map.remove(); mapInstanceRef.current = null; };
  }, []);

  useEffect(() => {
    tileLayerRef.current?.setUrl(tileUrl);
  }, [tileUrl]);

  useEffect(() => {
    if (mapInstanceRef.current) {
      const timer = setTimeout(() => {
        mapInstanceRef.current.invalidateSize();
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (allDataRef.current.length > 0) {
      const data = getFilteredData();
      updateHeatmap(data);
    }
  }, [mode, intensity, radius, blur, gradient, updateHeatmap, getFilteredData]);

  return (
    <div id="main-app">
      <Header onToggleSidebar={() => setSidebarCollapsed(p => !p)} />
      <TopLoader ref={loaderRef} />

      <div className="heatmap-container">
        <aside className={`heatmap-sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          <h2>Heatmap Controls</h2>

          <div className="control-group">
            <label className="control-label">Heatmap Mode</label>
            <div className="mode-selector">
              {['density', 'speed', 'acceleration'].map(m => (
                <button key={m} className={`mode-button${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
            <div className="mode-info">{MODE_DESCRIPTIONS[mode]}</div>
          </div>

          <div className="control-group">
            <label className="control-label">Intensity</label>
            <div className="slider-container">
              <input type="range" className="slider" min="1" max="30" value={intensity} onChange={e => setIntensity(+e.target.value)} />
              <span className="slider-value">{intensity}</span>
            </div>
          </div>

          <div className="control-group">
            <label className="control-label">Radius</label>
            <div className="slider-container">
              <input type="range" className="slider" min="5" max="50" value={radius} onChange={e => setRadius(+e.target.value)} />
              <span className="slider-value">{radius}</span>
            </div>
          </div>

          <div className="control-group">
            <label className="control-label">Blur</label>
            <div className="slider-container">
              <input type="range" className="slider" min="5" max="30" value={blur} onChange={e => setBlur(+e.target.value)} />
              <span className="slider-value">{blur}</span>
            </div>
          </div>

          <div className="control-group">
            <label className="control-label">Color Gradient</label>
            <div className="gradient-picker">
              {Object.keys(GRADIENTS).map(g => (
                <div key={g} className={`gradient-option gradient-${g}${gradient === g ? ' selected' : ''}`} onClick={() => setGradient(g)} />
              ))}
            </div>
          </div>

          <div className="control-group">
            <label className="control-label">Date Range</label>
            <div className="date-filter">
              <input type="date" className="date-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
              <input type="date" className="date-input" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          <div className="button-group">
            <button className="btn btn-primary" onClick={handleApplyFilters}>Apply Filters</button>
            <button className="btn btn-secondary" onClick={handleReset}>Reset</button>
          </div>

          <div className="stats-container">
            <h3>Statistics</h3>
            <div className="stat-item"><span className="stat-label">Total Journeys:</span><span className="stat-value">{stats.totalRoutes}</span></div>
            <div className="stat-item">
              <span className="stat-label">Total Distance:</span>
              <span className="stat-value">{(convertDistance(stats.totalDistance) ?? 0).toFixed(1)} {distanceUnit}</span>
            </div>
            <div className="stat-item"><span className="stat-label">Points Displayed:</span><span className="stat-value">{(stats.totalPoints || 0).toLocaleString()}</span></div>
          </div>
        </aside>

        <div className="heatmap-map" ref={mapRef} />

        {loading && (
          <div className="loading-overlay">
            <div className="loading-content">
              <div className="spinner" />
              <p>Loading heatmap data...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
