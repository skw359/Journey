import { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { useNavigate, useSearchParams } from 'react-router-dom';
import TopLoader from '../components/TopLoader';
import { useTheme } from '../context/ThemeContext';
import { TILE_ATTRIBUTION } from '../utils/mapUtils';
import { fetchAllTimeMapData, fetchHeatmapGrid } from '../api/journeys';
import './Atlas.css';

const HEATMAP_GRADIENT = {
  0.0: '#2454ff',
  0.25: '#2be86f',
  0.5: '#f4ef39',
  0.75: '#ff9d2e',
  1.0: '#ff4a2a',
};

function formatNumber(value, options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', options);
}

function formatMiles(value) {
  return formatNumber(value, {
    maximumFractionDigits: 0,
  });
}

export default function Atlas({ sidebarCollapsed = false }) {
  const { tileUrl } = useTheme();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadingText, setLoadingText] = useState('Opening the Atlas...');
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [mapMode, setMapMode] = useState(() => (searchParams.get('view') === 'heatmap' ? 'heatmap' : 'lines'));

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [showRoutes, setShowRoutes] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [clusterMarkers, setClusterMarkers] = useState(true);
  const [colorByDate, setColorByDate] = useState(false);
  const [opacity, setOpacity] = useState(0.7);
  const [lineWidth, setLineWidth] = useState(3);

  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const tileLayerRef = useRef(null);
  const allRoutesRef = useRef([]);
  const routeLayersRef = useRef(new Map());
  const clusterGroupRef = useRef(null);
  const heatLayerRef = useRef(null);
  const loaderRef = useRef(null);
  const debounceRef = useRef(null);
  const mapModeRef = useRef(mapMode);
  const startDateRef = useRef(startDate);
  const endDateRef = useRef(endDate);
  const detailFetchSeqRef = useRef(0);

  useEffect(() => { startDateRef.current = startDate; }, [startDate]);
  useEffect(() => { endDateRef.current = endDate; }, [endDate]);

  useEffect(() => {
    if (mapInstanceRef.current) return;
    const map = L.map(mapRef.current).setView([39.8283, -98.5795], 4);
    mapInstanceRef.current = map;
    tileLayerRef.current = L.tileLayer(tileUrl, {
      attribution: TILE_ATTRIBUTION, subdomains: 'abcd', maxZoom: 20,
    }).addTo(map);

    const onMoveEnd = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (mapModeRef.current === 'heatmap') {
          loadHeatmapGrid(startDateRef.current, endDateRef.current);
        } else {
          loadDetailRoutes();
        }
      }, 400);
    };
    map.on('moveend', onMoveEnd);

    loadData();

    const t1 = setTimeout(() => setLoadingText('Dusting off adventure tracks...'), 15000);
    const t2 = setTimeout(() => setLoadingText('Getting everything together...'), 25000);

    return () => {
      clearTimeout(t1); clearTimeout(t2);
      clearTimeout(debounceRef.current);
      map.off('moveend', onMoveEnd);
      map.remove(); mapInstanceRef.current = null;
    };
  }, []);

  useEffect(() => { tileLayerRef.current?.setUrl(tileUrl); }, [tileUrl]);

  useEffect(() => {
    if (mapInstanceRef.current) {
      const timer = setTimeout(() => mapInstanceRef.current.invalidateSize(), 350);
      return () => clearTimeout(timer);
    }
  }, [sidebarCollapsed]);

  const clearMapLayers = () => {
    const map = mapInstanceRef.current;
    if (!map) return;

    routeLayersRef.current.forEach(l => map.removeLayer(l));
    routeLayersRef.current.clear();
    if (clusterGroupRef.current) {
      map.removeLayer(clusterGroupRef.current);
      clusterGroupRef.current = null;
    }
    if (heatLayerRef.current) {
      map.removeLayer(heatLayerRef.current);
      heatLayerRef.current = null;
    }
  };

  const loadData = async () => {
    loaderRef.current?.start();
    try {
      const data = await fetchAllTimeMapData({ maxPoints: 100 });
      allRoutesRef.current = data.routes || [];
      setStats({ ...(data.stats || {}) });

      const initialStart = data.stats?.earliestDate ? data.stats.earliestDate.split('T')[0] : '';
      const initialEnd = data.stats?.latestDate ? data.stats.latestDate.split('T')[0] : '';
      setStartDate(initialStart);
      setEndDate(initialEnd);

      if (mapModeRef.current === 'lines') {
        renderRoutes(data.routes || []);
        loadDetailRoutes();
      }

      if (data.bounds) {
        mapInstanceRef.current?.fitBounds([
          [data.bounds.southwest[0], data.bounds.southwest[1]],
          [data.bounds.northeast[0], data.bounds.northeast[1]],
        ], { padding: [50, 50] });
      }
    } catch (err) { console.error(err); }
    setLoading(false);
    loaderRef.current?.finish();
  };

  const loadDetailRoutes = async () => {
    const map = mapInstanceRef.current;
    if (!map || mapModeRef.current !== 'lines' || map.getZoom() < 8) return;

    const bounds = map.getBounds();
    const boundsStr = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
    const requestSeq = ++detailFetchSeqRef.current;

    try {
      const data = await fetchAllTimeMapData({ maxPoints: 0, bounds: boundsStr });
      if (requestSeq !== detailFetchSeqRef.current) return;
      const detailRoutes = data.routes || [];
      if (detailRoutes.length === 0) return;

      const detailMap = new Map(detailRoutes.map(r => [r.id, r]));
      allRoutesRef.current = allRoutesRef.current.map(r =>
        detailMap.has(r.id) ? { ...r, coordinates: detailMap.get(r.id).coordinates } : r
      );

      detailRoutes.forEach(route => {
        if (!route.coordinates?.length) return;

        const existing = routeLayersRef.current.get(route.id);
        if (existing) {
          existing.setLatLngs(route.coordinates);
        }
      });
    } catch (err) {
      console.error('Failed to load detail routes:', err);
    }
  };

  const loadHeatmapGrid = async (start = startDate, end = endDate) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    setLoadingPoints(true);
    try {
      const bounds = map.getBounds();
      const params = {
        zoom: map.getZoom(),
        bounds: `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`,
      };
      if (start) params.start = start;
      if (end) params.end = `${end}T23:59:59`;
      const result = await fetchHeatmapGrid(params);
      const cells = result?.cells || [];
      setStats(prev => ({
        ...prev,
        totalPoints: result?.totalPoints ?? prev.totalPoints,
      }));
      renderHeatmap(cells);
    } catch (err) {
      console.error('Failed to load heatmap grid:', err);
    }
    setLoadingPoints(false);
  };

  const renderRoutes = (routes) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    clearMapLayers();

    if (routes.length === 0) return;

    const dateMin = routes.reduce((min, r) => {
      const t = new Date(r.startTime).getTime();
      return t < min ? t : min;
    }, Infinity);
    const dateMax = routes.reduce((max, r) => {
      const t = new Date(r.startTime).getTime();
      return t > max ? t : max;
    }, 0);
    const dateRange = dateMax - dateMin || 1;

    const getColor = (route) => {
      if (!colorByDate) return '#02d87f';
      const t = new Date(route.startTime).getTime();
      const ratio = (t - dateMin) / dateRange;
      const hue = ratio * 240;
      return `hsl(${hue}, 80%, 55%)`;
    };

    const markers = [];

    routes.forEach(route => {
      if (!route.coordinates?.length) return;

      if (showRoutes) {
        const color = getColor(route);
        const line = L.polyline(route.coordinates, {
          color, weight: lineWidth, opacity, className: 'atlas-route-line',
        }).addTo(map);

        const tooltip = `
          <div class="tooltip-row"><span class="tooltip-label">Journey:</span><span class="tooltip-value">${route.name}</span></div>
          <div class="tooltip-row"><span class="tooltip-label">Date:</span><span class="tooltip-value">${route.date}</span></div>
          <div class="tooltip-row"><span class="tooltip-label">Distance:</span><span class="tooltip-value">${parseFloat(route.distance).toFixed(1)} mi</span></div>
          <div class="tooltip-row"><span class="tooltip-label">Duration:</span><span class="tooltip-value">${route.duration}</span></div>
        `;
        line.bindTooltip(tooltip, { className: 'route-tooltip', sticky: true });
        line.on('click', () => navigate(`/journeys?routeId=${route.id}`));
        routeLayersRef.current.set(route.id, line);
      }

      if (showMarkers) {
        if (route.startCoord) {
          const m = L.circleMarker(route.startCoord, {
            radius: 5, fillColor: '#02d87f', color: '#fff', weight: 1, fillOpacity: 0.8,
          });
          m.bindTooltip(route.name, { className: 'route-tooltip' });
          markers.push(m);
        }
        if (route.endCoord) {
          const m = L.circleMarker(route.endCoord, {
            radius: 5, fillColor: '#ff4444', color: '#fff', weight: 1, fillOpacity: 0.8,
          });
          markers.push(m);
        }
      }
    });

    if (markers.length > 0) {
      if (clusterMarkers) {
        clusterGroupRef.current = L.markerClusterGroup();
        markers.forEach(m => clusterGroupRef.current.addLayer(m));
        map.addLayer(clusterGroupRef.current);
      } else {
        markers.forEach(m => { m.addTo(map); routeLayersRef.current.set(`marker-${Math.random()}`, m); });
      }
    }
  };

  const renderHeatmap = (cells) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    clearMapLayers();
    if (cells.length === 0) return;

    heatLayerRef.current = L.heatLayer(cells, {
      radius: 24,
      blur: 18,
      maxZoom: 18,
      max: 1.2,
      minOpacity: 0.35,
      gradient: HEATMAP_GRADIENT,
    }).addTo(map);
  };

  const filterByDateRange = (items, getTimestamp, start = startDate, end = endDate) => {
    if (!start && !end) return items;

    const st = start ? new Date(start).getTime() : 0;
    const et = end ? new Date(`${end}T23:59:59`).getTime() : Date.now();

    return items.filter(item => {
      const t = getTimestamp(item);
      return Number.isFinite(t) && t >= st && t <= et;
    });
  };

  const getFilteredRoutes = (routes = allRoutesRef.current, start = startDate, end = endDate) => {
    return filterByDateRange(routes, route => new Date(route.startTime).getTime(), start, end);
  };

  const drawCurrentMode = (start = startDate, end = endDate) => {
    if (mapMode === 'heatmap') {
      loadHeatmapGrid(start, end);
      return;
    }
    renderRoutes(getFilteredRoutes(allRoutesRef.current, start, end));
    loadDetailRoutes();
  };

  const handleModeChange = (nextMode) => {
    setMapMode(nextMode);
    mapModeRef.current = nextMode;

    const nextParams = new URLSearchParams(searchParams);
    if (nextMode === 'heatmap') nextParams.set('view', 'heatmap');
    else nextParams.delete('view');
    setSearchParams(nextParams, { replace: true });
  };

  const handleApply = () => {
    drawCurrentMode();
  };

  const handleReset = () => {
    const nextStart = stats.earliestDate ? stats.earliestDate.split('T')[0] : '';
    const nextEnd = stats.latestDate ? stats.latestDate.split('T')[0] : '';
    setStartDate(nextStart);
    setEndDate(nextEnd);
    drawCurrentMode(nextStart, nextEnd);
  };

  useEffect(() => {
    if (!loading && mapMode === 'lines' && allRoutesRef.current.length > 0) {
      renderRoutes(getFilteredRoutes());
      loadDetailRoutes();
    }
  }, [showRoutes, showMarkers, clusterMarkers, colorByDate, opacity, lineWidth]);

  useEffect(() => {
    if (loading) return;
    drawCurrentMode();
  }, [mapMode]);

  const formatTotalTime = (t) => {
    if (!t) return '--';
    const parts = [];
    if (t.days) parts.push(`${formatNumber(t.days)}d`);
    if (t.hours) parts.push(`${formatNumber(t.hours)}h`);
    if (t.minutes) parts.push(`${formatNumber(t.minutes)}m`);
    return parts.join(' ') || '0m';
  };

  return (
    <div id="main-app">
      <TopLoader ref={loaderRef} />

      <div className="atlas-container">
        <aside className={`atlas-sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          <div className="stats-overview">
            <h2>All-Time Travel</h2>
            <div className="stat-item"><span className="stat-label">Total Journeys</span><span className="stat-value">{formatNumber(stats.totalRoutes)}</span></div>
            <div className="stat-item"><span className="stat-label">Total Distance</span><span className="stat-value">{formatMiles(stats.totalDistance)} mi</span></div>
            <div className="stat-item"><span className="stat-label">Total Time</span><span className="stat-value">{formatTotalTime(stats.totalTime)}</span></div>
            <div className="stat-item"><span className="stat-label">Data Points</span><span className="stat-value">{formatNumber(stats.totalPoints)}</span></div>

            <div className="stats-divider" />

            <div className="stat-item"><span className="stat-label">Total Drive</span><span className="stat-value">{formatMiles(stats.modeDistances?.drive)} mi</span></div>
            <div className="stat-item"><span className="stat-label">Total Micromobility</span><span className="stat-value">{formatMiles(stats.modeDistances?.scooter)} mi</span></div>
            <div className="stat-item"><span className="stat-label">Total Foot</span><span className="stat-value">{formatMiles(stats.modeDistances?.foot)} mi</span></div>
          </div>

          <div className="controls-section">
            <h3>Date Range Filter</h3>
            <div className="control-group">
              <label>Start Date</label>
              <input type="date" className="date-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div className="control-group">
              <label>End Date</label>
              <input type="date" className="date-input" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
            <div className="button-group">
              <button className="btn btn-primary" onClick={handleApply}>Apply Filters</button>
              <button className="btn btn-secondary" onClick={handleReset}>Reset</button>
            </div>
          </div>

          {mapMode === 'lines' ? (
            <div className="controls-section">
              <h3>Display Options</h3>
              <div className="toggle-group">
                {[
                  { label: 'Show Journey Lines', checked: showRoutes, onChange: setShowRoutes },
                  { label: 'Show Start/End Markers', checked: showMarkers, onChange: setShowMarkers },
                  { label: 'Cluster Nearby Markers', checked: clusterMarkers, onChange: setClusterMarkers },
                  { label: 'Color by Date', checked: colorByDate, onChange: setColorByDate },
                ].map(t => (
                  <label key={t.label} className="toggle-item">
                    <span className="toggle-label">{t.label}</span>
                    <div className="toggle-switch">
                      <input type="checkbox" checked={t.checked} onChange={e => t.onChange(e.target.checked)} />
                      <span className="toggle-slider" />
                    </div>
                  </label>
                ))}
              </div>
              <div className="control-group">
                <label>Line Opacity</label>
                <input type="range" min="0.1" max="1" step="0.1" value={opacity} onChange={e => setOpacity(+e.target.value)} />
              </div>
              <div className="control-group">
                <label>Journey Width</label>
                <input type="range" min="1" max="8" step="1" value={lineWidth} onChange={e => setLineWidth(+e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="controls-section">
              <h3>Heatmap View</h3>
              <p className="heatmap-view-note">
                {loadingPoints
                  ? 'Loading heatmap data...'
                  : 'Heatmap highlights your most traveled areas using all-time GPS point density.'}
              </p>
            </div>
          )}
        </aside>

        <div className="atlas-map" ref={mapRef} />

        <div className="atlas-map-toggle" role="tablist" aria-label="Atlas map mode">
          <button
            type="button"
            className={`atlas-map-toggle-btn${mapMode === 'lines' ? ' active' : ''}`}
            onClick={() => handleModeChange('lines')}
            aria-pressed={mapMode === 'lines'}
          >
            Lines
          </button>
          <button
            type="button"
            className={`atlas-map-toggle-btn${mapMode === 'heatmap' ? ' active' : ''}`}
            onClick={() => handleModeChange('heatmap')}
            aria-pressed={mapMode === 'heatmap'}
          >
            Heatmap
          </button>
        </div>

        {loading && (
          <div className="loading-overlay">
            <div className="loading-spinner" />
            <div className="loading-text-el">{loadingText}</div>
          </div>
        )}
      </div>
    </div>
  );
}
