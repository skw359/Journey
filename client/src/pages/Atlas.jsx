import { useState, useEffect, useRef } from 'react';
import 'ol/ol.css';
import OlMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import HeatmapLayer from 'ol/layer/Heatmap';
import XYZ from 'ol/source/XYZ';
import VectorSource from 'ol/source/Vector';
import ClusterSource from 'ol/source/Cluster';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import { Style, Stroke, Circle as CircleStyle, Fill, Text } from 'ol/style';
import { fromLonLat, toLonLat } from 'ol/proj';
import { boundingExtent, buffer as bufferExtent, containsExtent } from 'ol/extent';
import { wrapX } from 'ol/coordinate';
import { easeOut } from 'ol/easing';
import Overlay from 'ol/Overlay';
import { getUid } from 'ol/util';
import { useNavigate, useSearchParams } from 'react-router-dom';
import TopLoader from '../components/TopLoader';
import { useTheme } from '../context/ThemeContext';
import { useUnits } from '../context/UnitsContext';
import { TILE_ATTRIBUTION } from '../utils/mapUtils';
import { fetchAllTimeMapData, fetchHeatmapGrid } from '../api/journeys';
import { computeFilteredStats } from '../utils/travelStats';
import { createBuildingProbe } from '../utils/buildingProbe';
import { createRouteLinesLayer } from '../utils/routeLinesLayer';
import { escapeHtml } from '../utils/html';
import { heatmapWeights } from '../utils/heatmapWeights';
import './Atlas.css';

const HEATMAP_GRADIENT = ['#2454ff', '#2be86f', '#f4ef39', '#ff9d2e', '#ff4a2a'];

// Points per route in the initial all-routes download.
const BASE_MAX_POINTS = 100;
// Ceiling on how many coordinates a detail refresh may pull. A viewport can
// genuinely contain millions of GPS points, and JSON.parse of that blocks the
// main thread for seconds; the screen cannot resolve them anyway.
const DETAIL_POINT_BUDGET = 150000;
// Detail is only worth a request when each route gets meaningfully more points
// than the base download already provided.
const DETAIL_MIN_GAIN = 2;

// How far from a journey or marker, in pixels, the pointer may be and still hit it.
const HIT_TOLERANCE = 3;
// Antialiasing paints about half a pixel past a shape's nominal edge, and the
// pointer is on a shape wherever it is painted, as with OL's pixel hit test.
const EDGE_SOFTNESS = 0.5;
// Marker and cluster circle sizes, shared by their styles and the hit test.
const MARKER_RADIUS = 5;
const MARKER_STROKE = 1;
const CLUSTER_STROKE = 2;
const CLUSTER_MAX_RADIUS = 20;
const clusterRadius = (size) => Math.min(CLUSTER_MAX_RADIUS, 12 + Math.log(size) * 3);

function tileUrlsFromTemplate(template) {
  const cleaned = template.replace('{r}', '');
  if (!cleaned.includes('{s}')) return [cleaned];
  return ['a', 'b', 'c', 'd'].map(s => cleaned.replace('{s}', s));
}

function buildXYZ(template) {
  return new XYZ({
    urls: tileUrlsFromTemplate(template),
    attributions: TILE_ATTRIBUTION,
    maxZoom: 20,
    crossOrigin: 'anonymous',
  });
}

function lonLat(coord) {
  return fromLonLat([coord[1], coord[0]]);
}

// Padding for fitting journeys into view. The open sidebar covers the map's
// left edge, so fits keep clear of it.
function fitPadding(sidebarEl, mapEl, pad) {
  const open = sidebarEl && mapEl && !sidebarEl.classList.contains('collapsed');
  const covered = open ? sidebarEl.getBoundingClientRect().right - mapEl.getBoundingClientRect().left : 0;
  return [pad, pad, pad, pad + Math.max(0, Math.ceil(covered))];
}

// Builds a projected LineString without allocating two arrays per coordinate:
// the points go into one flat [lon, lat, ...] buffer that ol transforms in place.
function buildLineGeometry(coords) {
  const flat = new Array(coords.length * 2);
  for (let i = 0, j = 0; i < coords.length; i++) {
    flat[j++] = coords[i][1];
    flat[j++] = coords[i][0];
  }
  return new LineString(flat, 'XY').transform('EPSG:4326', 'EPSG:3857');
}

function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function formatNumber(value, options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', options);
}

export default function Atlas({ sidebarCollapsed = false }) {
  const { tileUrl } = useTheme();
  const { convertDistance, distanceUnit } = useUnits();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats, setStats] = useState({});
  const [filteredStats, setFilteredStats] = useState(null);
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
  const sidebarRef = useRef(null);
  const tooltipRef = useRef(null);
  const buildingPopupRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const tileLayerRef = useRef(null);
  const allRoutesRef = useRef([]);
  const routeFeaturesRef = useRef(new Map());
  const routeSourceRef = useRef(null);
  const routeLayerRef = useRef(null);
  const markerSourceRef = useRef(null);
  const markerLayerRef = useRef(null);
  const clusterLayerRef = useRef(null);
  const clusterSourceRef = useRef(null);
  const heatmapLayerRef = useRef(null);
  const tooltipOverlayRef = useRef(null);
  const buildingProbeRef = useRef(null);
  const loaderRef = useRef(null);
  const debounceRef = useRef(null);
  const mapModeRef = useRef(mapMode);
  const startDateRef = useRef(startDate);
  const endDateRef = useRef(endDate);
  const detailFetchSeqRef = useRef(0);
  const detailCoverageRef = useRef(null);
  const preloadedRef = useRef(false);
  const opacityRef = useRef(opacity);
  const lineWidthRef = useRef(lineWidth);
  const clusterMarkersRef = useRef(clusterMarkers);
  const renderedRoutesRef = useRef([]);
  const convertDistanceRef = useRef(convertDistance);
  const distanceUnitRef = useRef(distanceUnit);

  const formatDistance = (value, fractionDigits = 0) => {
    const converted = convertDistance(value);
    return formatNumber(converted ?? 0, { maximumFractionDigits: fractionDigits });
  };

  useEffect(() => { startDateRef.current = startDate; }, [startDate]);
  useEffect(() => { endDateRef.current = endDate; }, [endDate]);
  useEffect(() => { opacityRef.current = opacity; }, [opacity]);
  useEffect(() => { lineWidthRef.current = lineWidth; }, [lineWidth]);
  useEffect(() => { clusterMarkersRef.current = clusterMarkers; }, [clusterMarkers]);
  useEffect(() => { convertDistanceRef.current = convertDistance; }, [convertDistance]);
  useEffect(() => { distanceUnitRef.current = distanceUnit; }, [distanceUnit]);

  useEffect(() => {
    if (mapInstanceRef.current) return;

    const tileLayer = new TileLayer({ source: buildXYZ(tileUrl) });
    tileLayerRef.current = tileLayer;

    const routeSource = new VectorSource();
    routeSourceRef.current = routeSource;
    // Journeys draw on the GPU (see routeLinesLayer.js), which keeps panning
    // and zooming smooth however many are in view. It has no hit detection of
    // its own; forEachAtlasFeatureAt below tests the geometry instead.
    const routeLayer = createRouteLinesLayer({
      source: routeSource,
      lineWidth: lineWidthRef.current,
      opacity: opacityRef.current,
    });
    routeLayerRef.current = routeLayer;

    const markerSource = new VectorSource();
    markerSourceRef.current = markerSource;

    const markerStyleCache = new Map();
    const markerStyle = (feature) => {
      const color = feature.get('fillColor') || '#02d87f';
      let style = markerStyleCache.get(color);
      if (!style) {
        style = new Style({
          image: new CircleStyle({
            radius: MARKER_RADIUS,
            fill: new Fill({ color }),
            stroke: new Stroke({ color: '#ffffff', width: MARKER_STROKE }),
          }),
        });
        markerStyleCache.set(color, style);
      }
      return style;
    };

    const markerLayer = new VectorLayer({ source: markerSource, style: markerStyle, visible: false });
    markerLayerRef.current = markerLayer;

    const clusterSource = new ClusterSource({ source: markerSource, distance: 40 });
    clusterSourceRef.current = clusterSource;
    const clusterStyleCache = new Map();
    const clusterLayer = new VectorLayer({
      source: clusterSource,
      visible: true,
      style: (feature) => {
        const features = feature.get('features') || [];
        const size = features.length;
        if (size === 1) return markerStyle(features[0]);
        let style = clusterStyleCache.get(size);
        if (!style) {
          style = new Style({
            image: new CircleStyle({
              radius: clusterRadius(size),
              fill: new Fill({ color: 'rgba(2, 216, 127, 0.85)' }),
              stroke: new Stroke({ color: '#ffffff', width: CLUSTER_STROKE }),
            }),
            text: new Text({
              text: String(size),
              fill: new Fill({ color: '#ffffff' }),
              font: 'bold 12px sans-serif',
            }),
          });
          clusterStyleCache.set(size, style);
        }
        return style;
      },
    });
    clusterLayerRef.current = clusterLayer;

    const hullSource = new VectorSource();
    const hullLineStyle = new Style({
      stroke: new Stroke({ color: 'rgba(2, 216, 127, 0.9)', width: 2, lineDash: [6, 4] }),
    });
    const hullPolygonStyle = new Style({
      stroke: new Stroke({ color: 'rgba(2, 216, 127, 0.9)', width: 2 }),
      fill: new Fill({ color: 'rgba(2, 216, 127, 0.18)' }),
    });
    const hullLayer = new VectorLayer({
      source: hullSource,
      style: (feature) => (
        feature.getGeometry().getType() === 'LineString' ? hullLineStyle : hullPolygonStyle
      ),
    });

    const heatmapLayer = new HeatmapLayer({
      source: new VectorSource(),
      blur: 18,
      radius: 12,
      gradient: HEATMAP_GRADIENT,
      visible: false,
    });
    heatmapLayerRef.current = heatmapLayer;

    const tooltipOverlay = new Overlay({
      element: tooltipRef.current,
      offset: [0, -16],
      positioning: 'bottom-center',
      stopEvent: false,
    });
    tooltipOverlayRef.current = tooltipOverlay;

    const buildingProbe = createBuildingProbe(buildingPopupRef.current);
    buildingProbeRef.current = buildingProbe;

    const map = new OlMap({
      target: mapRef.current,
      // Above the basemap, below the heatmap and every journey layer, so the
      // outline never hides the data the page exists to show.
      layers: [tileLayer, buildingProbe.layer, heatmapLayer, routeLayer, hullLayer, markerLayer, clusterLayer],
      view: new View({ center: fromLonLat([-98.5795, 39.8283]), zoom: 2 }),
      overlays: [tooltipOverlay, buildingProbe.overlay],
    });
    mapInstanceRef.current = map;

    const tooltipEl = tooltipRef.current;

    // Hit testing measures against geometry rather than rendered pixels. OL's
    // canvas hit detection redrew every candidate and read it back with
    // getImageData, which over dense areas cost hundreds of milliseconds per
    // pointer move, and the GPU journey layer has no pixels to read back.
    // Calls `callback` with each journey, marker and cluster within
    // HIT_TOLERANCE pixels of `coordinate`, in the order forEachFeatureAtPixel
    // visits them: features under the pointer first (topmost layer, then
    // topmost feature), then near misses, nearest first. Returns the first
    // truthy callback result. The building probe's outline is never hit.
    const scratchPoint = [0, 0];
    const forEachAtlasFeatureAt = (coordinate, callback) => {
      const view = map.getView();
      const resolution = view.getResolution();
      if (!resolution) return undefined;
      // World copies repeat the same features, so test the original world.
      const [x, y] = wrapX(coordinate.slice(), view.getProjection());
      const under = [];
      const near = [];
      // `gapOf` gives the pixel distance from the pointer to the feature's
      // drawn edge: 0 when under it, Infinity when out of reach.
      const collect = (layer, source, reachPx, gapOf) => {
        if (!layer.getVisible()) return;
        const reach = reachPx * resolution;
        const hits = [];
        source.forEachFeatureInExtent([x - reach, y - reach, x + reach, y + reach], (feature) => {
          const gap = gapOf(feature);
          if (gap <= HIT_TOLERANCE) hits.push({ feature, gap, order: Number(getUid(feature)) });
        });
        // Features are drawn in creation order, so the highest uid is on top.
        hits.sort((a, b) => b.order - a.order);
        for (const hit of hits) (hit.gap > 0 ? near : under).push(hit);
      };
      const circleGap = (feature, radius) => {
        const [fx, fy] = feature.getGeometry().getCoordinates();
        return Math.max(0, Math.hypot(fx - x, fy - y) / resolution - radius);
      };

      const markerEdge = MARKER_RADIUS + MARKER_STROKE / 2 + EDGE_SOFTNESS;
      const clusterEdge = (size) => clusterRadius(size) + CLUSTER_STROKE / 2 + EDGE_SOFTNESS;
      collect(clusterLayer, clusterSource, clusterEdge(Infinity) + HIT_TOLERANCE, (feature) => {
        const size = feature.get('features').length;
        return circleGap(feature, size > 1 ? clusterEdge(size) : markerEdge);
      });
      collect(markerLayer, markerSource, markerEdge + HIT_TOLERANCE, (feature) => circleGap(feature, markerEdge));
      const lineEdge = lineWidthRef.current / 2 + EDGE_SOFTNESS;
      const maxSq = ((lineEdge + HIT_TOLERANCE) * resolution) ** 2;
      collect(routeLayer, routeSource, lineEdge + HIT_TOLERANCE, (feature) => {
        const sq = feature.getGeometry().closestPointXY(x, y, scratchPoint, maxSq);
        return sq < maxSq ? Math.max(0, Math.sqrt(sq) / resolution - lineEdge) : Infinity;
      });

      // Stable, so equally near features keep their layer and draw order.
      near.sort((a, b) => a.gap - b.gap);
      for (const hit of under.concat(near)) {
        const result = callback(hit.feature);
        if (result) return result;
      }
      return undefined;
    };

    // Tooltip markup is built on hover rather than stored on every feature.
    const buildTooltipHtml = (feature) => {
      const kind = feature.get('tooltipKind');
      if (kind === 'route') {
        const dist = (convertDistanceRef.current(feature.get('routeDistance')) ?? 0).toFixed(1);
        return `
          <div class="tooltip-row"><span class="tooltip-label">Journey:</span><span class="tooltip-value">${escapeHtml(feature.get('routeName'))}</span></div>
          <div class="tooltip-row"><span class="tooltip-label">Date:</span><span class="tooltip-value">${escapeHtml(feature.get('routeDate'))}</span></div>
          <div class="tooltip-row"><span class="tooltip-label">Distance:</span><span class="tooltip-value">${dist} ${escapeHtml(distanceUnitRef.current)}</span></div>
          <div class="tooltip-row"><span class="tooltip-label">Duration:</span><span class="tooltip-value">${escapeHtml(feature.get('routeDuration'))}</span></div>
        `;
      }
      if (kind === 'marker') {
        return `<div style="color:#02d87f;font-weight:600;">${escapeHtml(feature.get('routeName'))}</div>`;
      }
      return null;
    };

    // pointermove fires far faster than the screen can show the result, so
    // coalesce to at most one hit test per animation frame.
    let pointerFrame = 0;
    let pendingPointer = null;
    let lastTooltipHtml = null;
    let lastCursor = '';
    let lastHullUid = null;

    const setCursor = (value) => {
      if (value === lastCursor) return;
      lastCursor = value;
      const el = map.getTargetElement();
      if (el) el.style.cursor = value;
    };

    const hideTooltip = () => {
      if (lastTooltipHtml === null) return;
      lastTooltipHtml = null;
      tooltipEl.style.display = 'none';
    };

    const clearHull = () => {
      if (lastHullUid === null) return;
      lastHullUid = null;
      hullSource.clear();
    };

    const runHitTest = () => {
      pointerFrame = 0;
      const pending = pendingPointer;
      pendingPointer = null;
      if (!pending) return;

      if (pending.dragging) {
        hideTooltip();
        clearHull();
        return;
      }
      // Nothing in heatmap mode is hoverable, so skip hit testing outright.
      if (mapModeRef.current === 'heatmap') {
        hideTooltip();
        clearHull();
        setCursor('');
        return;
      }

      let foundFeature = null;
      let foundCoord = null;
      let isLine = false;
      let hoveredCluster = null;
      let isInteractive = false;
      forEachAtlasFeatureAt(pending.coordinate, (feature) => {
        const inner = feature.get('features');
        if (inner && inner.length > 1) {
          hoveredCluster = feature;
          isInteractive = true;
          return true;
        }
        if (feature.get('tooltipKind')) {
          foundFeature = feature;
          isLine = feature.getGeometry()?.getType() === 'LineString';
          if (!isLine) foundCoord = feature.getGeometry().getCoordinates();
          isInteractive = true;
          return true;
        }
        if (inner && inner.length === 1) {
          if (inner[0].get('tooltipKind')) {
            foundFeature = inner[0];
            foundCoord = inner[0].getGeometry().getCoordinates();
            isInteractive = true;
            return true;
          }
        }
        return false;
      });

      if (hoveredCluster) {
        // Rebuild the hull only when the hovered cluster actually changes.
        const uid = getUid(hoveredCluster);
        if (uid !== lastHullUid) {
          hullSource.clear();
          lastHullUid = uid;
          const coords = hoveredCluster.get('features').map(f => f.getGeometry().getCoordinates());
          if (coords.length >= 3) {
            const hull = convexHull(coords);
            hullSource.addFeature(new Feature({ geometry: new Polygon([[...hull, hull[0]]]) }));
          } else if (coords.length === 2) {
            hullSource.addFeature(new Feature({ geometry: new LineString(coords) }));
          }
        }
      } else {
        clearHull();
      }

      const html = foundFeature ? buildTooltipHtml(foundFeature) : null;
      if (html) {
        // Re-parsing identical markup every frame forces a needless style recalc.
        if (html !== lastTooltipHtml) {
          lastTooltipHtml = html;
          tooltipEl.innerHTML = html;
          tooltipEl.style.display = 'block';
        }
        tooltipOverlay.setPosition(isLine ? pending.coordinate : (foundCoord || pending.coordinate));
      } else {
        hideTooltip();
      }
      setCursor(isInteractive ? 'pointer' : '');
    };

    const onPointerMove = (evt) => {
      pendingPointer = { coordinate: evt.coordinate, dragging: evt.dragging };
      if (!pointerFrame) pointerFrame = requestAnimationFrame(runHitTest);
    };
    map.on('pointermove', onPointerMove);

    // What of the Atlas's own is under this coordinate?
    const hitAtlasFeature = (coordinate) => {
      let routeId = null;
      let clusterFeatures = null;
      forEachAtlasFeatureAt(coordinate, (feature) => {
        const inner = feature.get('features');
        if (inner && inner.length > 1) { clusterFeatures = inner; return true; }
        if (inner && inner.length === 1) {
          const innerId = inner[0].get('routeId');
          if (innerId) { routeId = innerId; return true; }
          return false;
        }
        const id = feature.get('routeId');
        if (id) { routeId = id; return true; }
        return false;
      });
      return { routeId, clusterFeatures };
    };

    // The pointer event of the last click a cluster or route consumed.
    // 'singleclick' fires ~250ms after 'click' for the same pointer event, by
    // which point the cluster zoom is mid-animation and re-hit-testing the
    // pixel finds bare map, so onSingleClick checks this instead.
    let consumedClick = null;

    const onMapClick = (evt) => {
      const { routeId, clusterFeatures } = hitAtlasFeature(evt.coordinate);
      consumedClick = (routeId || clusterFeatures) ? evt.originalEvent : null;

      if (clusterFeatures) {
        // clearHull() rather than hullSource.clear(), so the hover memo above
        // does not think the hull it drew for this cluster is still on screen.
        clearHull();
        buildingProbe.clear();
        const coords = clusterFeatures.map(f => f.getGeometry().getCoordinates());
        const extent = boundingExtent(coords);
        const view = map.getView();
        const currentZoom = view.getZoom();
        view.fit(extent, {
          padding: fitPadding(sidebarRef.current, mapRef.current, 60),
          duration: 300,
          maxZoom: Math.max(currentZoom + 2, 14),
        });
        return;
      }
      if (routeId) {
        buildingProbe.clear();
        navigate(`/journeys?routeId=${routeId}`);
      }
    };
    map.on('click', onMapClick);

    // Click-to-identify rides on 'singleclick' rather than 'click' so that
    // double-click-to-zoom does not also fire a geocoder lookup. Cluster and
    // route clicks keep the immediate 'click' above so their responsiveness is
    // unchanged; this only runs when the click landed on bare map.
    const onSingleClick = (evt) => {
      if (evt.originalEvent === consumedClick) return;
      const { routeId, clusterFeatures } = hitAtlasFeature(evt.coordinate);
      if (routeId || clusterFeatures) return;
      buildingProbe.probe(evt.coordinate);
    };
    map.on('singleclick', onSingleClick);

    const onMoveEnd = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (mapModeRef.current === 'heatmap') {
          loadHeatmapGrid(startDateRef.current, endDateRef.current);
        } else if (!preloadedRef.current) {
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
      if (pointerFrame) cancelAnimationFrame(pointerFrame);
      map.un('pointermove', onPointerMove);
      map.un('click', onMapClick);
      map.un('singleclick', onSingleClick);
      map.un('moveend', onMoveEnd);
      buildingProbe.destroy();
      buildingProbeRef.current = null;
      map.setTarget(null);
      // Unlike canvas layers, WebGL layers keep their GL context until disposed,
      // and browsers only allow a handful of contexts alive at once.
      routeLayer.dispose();
      heatmapLayer.dispose();
      mapInstanceRef.current = null;
    };
  }, []);

  useEffect(() => { tileLayerRef.current?.setSource(buildXYZ(tileUrl)); }, [tileUrl]);

  // Features are always built now; these toggles just flip layer visibility
  // instead of tearing down and rebuilding every geometry.
  useEffect(() => {
    routeLayerRef.current?.setVisible(showRoutes);
  }, [showRoutes]);

  useEffect(() => {
    const markerLayer = markerLayerRef.current;
    const clusterLayer = clusterLayerRef.current;
    if (!markerLayer || !clusterLayer) return;
    markerLayer.setVisible(showMarkers && !clusterMarkers);
    clusterLayer.setVisible(showMarkers && clusterMarkers);
  }, [showMarkers, clusterMarkers]);

  const clearMapLayers = () => {
    // Features are about to be replaced, so anything we fetched detail for is gone.
    detailCoverageRef.current = null;
    routeFeaturesRef.current.clear();
    routeSourceRef.current?.clear();
    markerSourceRef.current?.clear();
    heatmapLayerRef.current?.getSource()?.clear();
  };

  const loadData = async () => {
    const shouldPreload = localStorage.getItem('preloadData') === 'true';
    loaderRef.current?.start();
    try {
      preloadedRef.current = shouldPreload;
      const data = await fetchAllTimeMapData({ maxPoints: shouldPreload ? 0 : BASE_MAX_POINTS });
      allRoutesRef.current = data.routes || [];
      setStats({ ...(data.stats || {}) });

      const initialStart = data.stats?.earliestDate ? data.stats.earliestDate.split('T')[0] : '';
      const initialEnd = data.stats?.latestDate ? data.stats.latestDate.split('T')[0] : '';
      setStartDate(initialStart);
      setEndDate(initialEnd);

      if (mapModeRef.current === 'lines') {
        renderRoutes(data.routes || []);
        if (!shouldPreload) loadDetailRoutes();
      }

      if (data.bounds) {
        const sw = lonLat(data.bounds.southwest);
        const ne = lonLat(data.bounds.northeast);
        const extent = boundingExtent([sw, ne]);
        const view = mapInstanceRef.current?.getView();
        if (view) {
          requestAnimationFrame(() => {
            view.fit(extent, { padding: fitPadding(sidebarRef.current, mapRef.current, 50), duration: 150, easing: easeOut });
          });
        }
      }
    } catch (err) { console.error(err); }
    setLoading(false);
    loaderRef.current?.finish();
  };

  const loadDetailRoutes = async () => {
    const map = mapInstanceRef.current;
    if (!map || mapModeRef.current !== 'lines' || map.getView().getZoom() < 8) return;

    const view = map.getView();
    const extent = view.calculateExtent(map.getSize());

    // The server hands back a whole route when any single point falls in view,
    // so the cost scales with routes in view, not with the viewport. Spend a
    // fixed coordinate budget across them rather than asking for everything.
    const routeSource = routeSourceRef.current;
    const inView = routeSource ? routeSource.getFeaturesInExtent(extent).length : 0;
    if (inView === 0) return;
    const maxPoints = Math.floor(DETAIL_POINT_BUDGET / inView);

    // Zoomed out over dense data every route would get ~the base resolution
    // back, so the request buys nothing and costs a multi-megabyte parse.
    if (maxPoints < BASE_MAX_POINTS * DETAIL_MIN_GAIN) return;

    // Skip when the last fetch already covers this view at this detail level,
    // so nudging the map does not re-download the same routes.
    const covered = detailCoverageRef.current;
    if (covered && covered.maxPoints >= maxPoints && containsExtent(covered.extent, extent)) return;

    // Fetch a slightly larger area than the screen so small pans stay covered.
    const fetchExtent = bufferExtent(extent, (extent[2] - extent[0]) * 0.25);
    const sw = toLonLat([fetchExtent[0], fetchExtent[1]]);
    const ne = toLonLat([fetchExtent[2], fetchExtent[3]]);
    const boundsStr = `${sw[1]},${sw[0]},${ne[1]},${ne[0]}`;
    const requestSeq = ++detailFetchSeqRef.current;

    try {
      const data = await fetchAllTimeMapData({ maxPoints, bounds: boundsStr });
      if (requestSeq !== detailFetchSeqRef.current) return;
      const detailRoutes = data.routes || [];
      if (detailRoutes.length === 0) return;

      const byId = new Map();
      for (const r of allRoutesRef.current) byId.set(r.id, r);

      detailRoutes.forEach(route => {
        if (!route.coordinates?.length) return;
        // Mutate in place: rebuilding the whole array allocated a fresh object
        // per route on every pan.
        const base = byId.get(route.id);
        if (base) base.coordinates = route.coordinates;
        const existing = routeFeaturesRef.current.get(route.id);
        if (existing) {
          existing.setGeometry(buildLineGeometry(route.coordinates));
        }
      });

      detailCoverageRef.current = { extent: fetchExtent, maxPoints };
    } catch (err) {
      console.error('Failed to load detail routes:', err);
    }
  };

  const loadHeatmapGrid = async (start = startDate, end = endDate) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    setLoadingPoints(true);
    try {
      const view = map.getView();
      const extent = view.calculateExtent(map.getSize());
      const sw = toLonLat([extent[0], extent[1]]);
      const ne = toLonLat([extent[2], extent[3]]);
      const params = {
        zoom: Math.round(view.getZoom()),
        bounds: `${sw[1]},${sw[0]},${ne[1]},${ne[0]}`,
      };
      // The same instants the Lines view filters journeys by.
      if (start) params.start = new Date(start).getTime();
      if (end) params.end = new Date(`${end}T23:59:59`).getTime();
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

  // Route colors depend on the rendered set's date span, so the span is computed
  // once and reused by both the initial render and later "Color by Date" toggles.
  const dateSpanOf = (routes) => {
    let dateMin = Infinity;
    let dateMax = 0;
    for (const r of routes) {
      const t = new Date(r.startTime).getTime();
      if (t < dateMin) dateMin = t;
      if (t > dateMax) dateMax = t;
    }
    return { dateMin, dateRange: dateMax - dateMin || 1 };
  };

  const routeColor = (route, span, byDate) => {
    if (!byDate) return '#02d87f';
    const t = new Date(route.startTime).getTime();
    // Whole degrees keep it to 241 distinct colors, all of which fit in ol's
    // parsed-color cache; 1deg of hue is not distinguishable on screen.
    const hue = Math.round(((t - span.dateMin) / span.dateRange) * 240);
    return `hsl(${hue}, 80%, 55%)`;
  };

  const applyRouteColors = () => {
    const routes = renderedRoutesRef.current;
    const routeSource = routeSourceRef.current;
    if (!routeSource || !routes.length) return;
    const span = dateSpanOf(routes);
    for (const route of routes) {
      const f = routeFeaturesRef.current.get(route.id);
      // Silent: a normal set() fires propertychange, which would make the source
      // schedule a redraw once per route.
      if (f) f.set('color', routeColor(route, span, colorByDate), true);
    }
    routeSource.changed();
  };

  const renderRoutes = (routes) => {
    const map = mapInstanceRef.current;
    const routeSource = routeSourceRef.current;
    const markerSource = markerSourceRef.current;
    if (!map || !routeSource || !markerSource) return;

    // While the cluster source is attached, every markerSource mutation makes it
    // re-cluster the entire set, so filling the source is quadratic. Detach it
    // for the whole rebuild and let the re-attach below do a single pass.
    // Features are still added one at a time rather than via addFeatures(),
    // because a bulk r-tree load changes feature iteration order, which would
    // change both how markers group and the order lines overdraw each other.
    const clusterSource = clusterSourceRef.current;
    clusterSource?.setSource(null);

    try {
      clearMapLayers();
      heatmapLayerRef.current?.setVisible(false);

      renderedRoutesRef.current = routes;
      if (routes.length === 0) return;

      const span = dateSpanOf(routes);

      routes.forEach(route => {
        if (!route.coordinates?.length) return;

        const f = new Feature({ geometry: buildLineGeometry(route.coordinates) });
        f.set('color', routeColor(route, span, colorByDate));
        f.set('routeId', route.id);
        f.set('tooltipKind', 'route');
        f.set('routeName', route.name);
        f.set('routeDate', route.date);
        f.set('routeDistance', route.distance);
        f.set('routeDuration', route.duration);
        routeSource.addFeature(f);
        routeFeaturesRef.current.set(route.id, f);

        if (route.startCoord) {
          const m = new Feature({ geometry: new Point(lonLat(route.startCoord)) });
          m.set('fillColor', '#02d87f');
          m.set('tooltipKind', 'marker');
          m.set('routeName', route.name);
          markerSource.addFeature(m);
        }
        if (route.endCoord) {
          const m = new Feature({ geometry: new Point(lonLat(route.endCoord)) });
          m.set('fillColor', '#ff4444');
          markerSource.addFeature(m);
        }
      });
    } finally {
      // Re-attaching runs exactly one cluster pass over the finished set.
      clusterSource?.setSource(markerSource);
    }
  };

  const renderHeatmap = (cells) => {
    const heatmapLayer = heatmapLayerRef.current;
    if (!heatmapLayer) return;

    clearMapLayers();
    heatmapLayer.setVisible(true);

    if (cells.length === 0) return;

    const source = heatmapLayer.getSource();
    // cells: [lat, lon, journeys through the cell, GPS points in it]
    const weights = heatmapWeights(cells.map((cell) => cell[2] ?? 0));
    const features = cells.map(([lat, lon], i) => {
      const f = new Feature({ geometry: new Point(fromLonLat([lon, lat])) });
      f.set('weight', weights[i]);
      return f;
    });
    source.addFeatures(features);
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

  const recomputeFilteredStats = (start = startDate, end = endDate) => {
    const allStart = stats.earliestDate ? stats.earliestDate.split('T')[0] : '';
    const allEnd = stats.latestDate ? stats.latestDate.split('T')[0] : '';
    const isNarrowed = (start && start !== allStart) || (end && end !== allEnd);
    if (!isNarrowed) { setFilteredStats(null); return; }
    const routes = getFilteredRoutes(allRoutesRef.current, start, end);
    setFilteredStats(computeFilteredStats(routes));
  };

  const drawCurrentMode = (start = startDate, end = endDate) => {
    if (mapMode === 'heatmap') {
      loadHeatmapGrid(start, end);
      return;
    }
    renderRoutes(getFilteredRoutes(allRoutesRef.current, start, end));
    if (!preloadedRef.current) loadDetailRoutes();
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
    recomputeFilteredStats();
  };

  const handleReset = () => {
    const nextStart = stats.earliestDate ? stats.earliestDate.split('T')[0] : '';
    const nextEnd = stats.latestDate ? stats.latestDate.split('T')[0] : '';
    setStartDate(nextStart);
    setEndDate(nextEnd);
    drawCurrentMode(nextStart, nextEnd);
    setFilteredStats(null);
  };

  useEffect(() => {
    routeLayerRef.current?.setOpacity(opacity);
  }, [opacity]);

  useEffect(() => {
    routeLayerRef.current?.setLineWidth(lineWidth);
  }, [lineWidth]);

  // Recoloring rewrites one property on existing features rather than rebuilding.
  // showRoutes/showMarkers/clusterMarkers are handled by layer visibility above,
  // and distanceUnit only affects tooltips, which are now built on hover.
  useEffect(() => {
    if (loading || mapMode !== 'lines') return;
    applyRouteColors();
  }, [colorByDate]);

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

  const isFiltered = filteredStats != null;
  const displayStats = filteredStats ?? stats;

  return (
    <div id="main-app">
      <TopLoader ref={loaderRef} />

      <div className="atlas-container">
        <aside ref={sidebarRef} className={`atlas-sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          <div className="stats-overview">
            <h2>{isFiltered ? 'Filtered Travel' : 'All-Time Travel'}</h2>
            {isFiltered && <div className="stats-range-note">{startDate} – {endDate}</div>}
            <div className="stat-item"><span className="stat-label">Total Journeys</span><span className="stat-value">{formatNumber(displayStats.totalRoutes)}</span></div>
            <div className="stat-item"><span className="stat-label">Total Distance</span><span className="stat-value">{formatDistance(displayStats.totalDistance)} {distanceUnit}</span></div>
            <div className="stat-item"><span className="stat-label">Total Time</span><span className="stat-value">{formatTotalTime(displayStats.totalTime)}</span></div>
            <div className="stat-item"><span className="stat-label">Data Points</span><span className="stat-value">{formatNumber((isFiltered && preloadedRef.current) ? filteredStats.totalPoints : stats.totalPoints)}</span></div>

            <div className="stats-divider" />

            <div className="stat-item"><span className="stat-label">Total Drive</span><span className="stat-value">{formatDistance(displayStats.modeDistances?.drive)} {distanceUnit}</span></div>
            <div className="stat-item"><span className="stat-label">Total Micromobility</span><span className="stat-value">{formatDistance(displayStats.modeDistances?.scooter)} {distanceUnit}</span></div>
            <div className="stat-item"><span className="stat-label">Total Foot</span><span className="stat-value">{formatDistance(displayStats.modeDistances?.foot)} {distanceUnit}</span></div>
            <div className="stat-item"><span className="stat-label">Total Train</span><span className="stat-value">{formatDistance(displayStats.modeDistances?.train)} {distanceUnit}</span></div>
            <div className="stat-item"><span className="stat-label">Total Metro</span><span className="stat-value">{formatDistance(displayStats.modeDistances?.metro)} {distanceUnit}</span></div>
            <div className="stat-item"><span className="stat-label">Total Flight</span><span className="stat-value">{formatDistance(displayStats.modeDistances?.flight)} {distanceUnit}</span></div>
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
                  : 'Brighter areas are ones you pass through on more journeys.'}
              </p>
            </div>
          )}
        </aside>

        <div className="atlas-map" ref={mapRef} />
        <div
          ref={tooltipRef}
          className="route-tooltip"
          style={{ display: 'none', pointerEvents: 'none', position: 'absolute' }}
        />
        <div ref={buildingPopupRef} className="building-popup" style={{ display: 'none' }} />

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
