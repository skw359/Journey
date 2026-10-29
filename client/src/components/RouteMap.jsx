import { useEffect, useRef, useCallback, useState } from 'react';
import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import { Style, Stroke, Circle as CircleStyle, Fill } from 'ol/style';
import { fromLonLat, toLonLat } from 'ol/proj';
import { boundingExtent } from 'ol/extent';
import Overlay from 'ol/Overlay';
import FullScreen from 'ol/control/FullScreen';
import { defaults as defaultControls } from 'ol/control';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom';
import MouseWheelZoom from 'ol/interaction/MouseWheelZoom';
import { defaults as defaultInteractions } from 'ol/interaction';
import { X } from 'lucide-react';

import { useTheme } from '../context/ThemeContext';
import { useUnits } from '../context/UnitsContext';
import { TILE_ATTRIBUTION } from '../utils/mapUtils';
import { formatTime, calculateAcceleration } from '../utils/formatters';
import { douglasPeucker, getToleranceForZoom, shouldShowHover } from '../utils/simplify';
import { speedToColor } from '../utils/speedColors';
import { createBuildingProbe } from '../utils/buildingProbe';
import { createRouteMeasure } from '../utils/routeMeasure';
import { isZoomWheel, ZOOM_MODIFIER_LABEL } from '../utils/wheelZoom';
import WeatherBadge from './WeatherBadge';
import './RouteMeasure.css';

const SIMPLIFICATION_THRESHOLD = 5000;

// How far from the line (in screen pixels) a measuring click still snaps to it.
const MEASURE_SNAP_PX = 22;
const MEASURE_SNAP_TOUCH_PX = 36;
const MEASURE_MODE_KEY = 'measureMode';

function readMeasureMode() {
  try {
    return localStorage.getItem(MEASURE_MODE_KEY) === 'air' ? 'air' : 'route';
  } catch {
    return 'route';
  }
}

function measureSnapPx(evt) {
  return evt.originalEvent?.pointerType === 'touch' ? MEASURE_SNAP_TOUCH_PX : MEASURE_SNAP_PX;
}

// The map heads a scrolling page, so a plain wheel scrolls the page and
// Ctrl/⌘ + wheel (or pinch) zooms. Fullscreen has no page behind it to
// scroll, so any wheel zooms there.
function wheelZoomCondition(mapBrowserEvent) {
  return isZoomWheel(mapBrowserEvent.originalEvent) || Boolean(document.fullscreenElement);
}

function syncMeasureActive(map, measure, active) {
  measure.setActive(active);
  map.getInteractions().forEach((interaction) => {
    if (interaction instanceof DoubleClickZoom) interaction.setActive(!active);
  });
  map.getTargetElement().style.cursor = active ? 'crosshair' : '';
}

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

function buildTooltipContent(route, i, units) {
  const startTime = route.profileTimeMs[0];
  const time = route.profileTimeMs[i];
  const speed = route.profileSpeedMph[i] || 0;
  const distance = route.profileDistMi[i] || 0;
  const elevation = route.profileElevM?.[i] ?? null;
  const acceleration = i > 0
    ? calculateAcceleration(speed, route.profileSpeedMph[i - 1], time, route.profileTimeMs[i - 1])
    : 0;
  const displaySpeed = units.convertSpeed(speed) ?? 0;
  const displayDistance = units.convertDistance(distance) ?? 0;
  const displayElevation = elevation !== null ? units.convertElevation(elevation) : null;
  const displayAcceleration = units.convertAcceleration(acceleration) ?? 0;

  return `
    <div class="tooltip-row"><span class="tooltip-label">Time:</span><span class="tooltip-value">${formatTime(time, startTime)}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">Speed:</span><span class="tooltip-value">${displaySpeed.toFixed(1)} ${units.speedUnit}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">Distance:</span><span class="tooltip-value">${displayDistance.toFixed(2)} ${units.distanceUnit}</span></div>
    ${displayElevation !== null ? `<div class="tooltip-row"><span class="tooltip-label">Elevation:</span><span class="tooltip-value">${Math.round(displayElevation)} ${units.elevationUnit}</span></div>` : ''}
    <div class="tooltip-row"><span class="tooltip-label">Acceleration:</span><span class="tooltip-value">${displayAcceleration.toFixed(2)} ${units.accelerationUnit}</span></div>
  `;
}

export default function RouteMap({
  route,
  sidebarCollapsed,
  onViewportChange,
  weather,
  fullscreen,
  measureActive = false,
  onMeasureActiveChange,
}) {
  const { tileUrl } = useTheme();
  const {
    isMetric,
    convertSpeed,
    convertDistance,
    convertElevation,
    convertAcceleration,
    speedUnit,
    distanceUnit,
    elevationUnit,
    accelerationUnit,
  } = useUnits();
  const [heatmapEnabled, setHeatmapEnabled] = useState(false);
  const [measureMode, setMeasureMode] = useState(readMeasureMode);
  const [measureInfo, setMeasureInfo] = useState({ count: 0, routeMi: null, airMi: null });
  const [measureMiss, setMeasureMiss] = useState(false);
  const [wheelHintVisible, setWheelHintVisible] = useState(false);
  const wheelHintTimerRef = useRef(null);
  const measureRef = useRef(null);
  const measureActiveRef = useRef(measureActive);
  const measureModeRef = useRef(measureMode);
  const measureLabelRef = useRef(null);
  const measureBarRef = useRef(null);
  const measureMissTimerRef = useRef(null);
  // Points survive the map being rebuilt (it is, whenever the theme changes).
  const measurePointsStashRef = useRef([]);
  const onMeasureActiveChangeRef = useRef(onMeasureActiveChange);
  const heatmapEnabledRef = useRef(false);
  const heatmapInitedRef = useRef(false);
  const mapRef = useRef(null);
  const tooltipRef = useRef(null);
  const buildingPopupRef = useRef(null);
  const buildingProbeRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const tileLayerRef = useRef(null);
  const routeSourceRef = useRef(null);
  const routeLayerRef = useRef(null);
  const routeFadeSourceRef = useRef(null);
  const routeFadeLayerRef = useRef(null);
  const fadeAnimationRef = useRef(null);
  const hoverSourceRef = useRef(null);
  const markerSourceRef = useRef(null);
  const tooltipOverlayRef = useRef(null);
  const routeRef = useRef(null);
  const debounceRef = useRef(null);
  const onViewportChangeRef = useRef(onViewportChange);
  const lastRouteIdRef = useRef(null);
  const unitFormatterRef = useRef({
    convertSpeed,
    convertDistance,
    convertElevation,
    convertAcceleration,
    speedUnit,
    distanceUnit,
    elevationUnit,
    accelerationUnit,
  });

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    onMeasureActiveChangeRef.current = onMeasureActiveChange;
  }, [onMeasureActiveChange]);

  useEffect(() => {
    unitFormatterRef.current = {
      convertSpeed,
      convertDistance,
      convertElevation,
      convertAcceleration,
      speedUnit,
      distanceUnit,
      elevationUnit,
      accelerationUnit,
    };
  }, [convertSpeed, convertDistance, convertElevation, convertAcceleration, speedUnit, distanceUnit, elevationUnit, accelerationUnit]);

  const emitViewportChange = useCallback(() => {
    const cb = onViewportChangeRef.current;
    const map = mapInstanceRef.current;
    if (!cb || !map) return;
    const view = map.getView();
    const extent = view.calculateExtent(map.getSize());
    const sw = toLonLat([extent[0], extent[1]]);
    const ne = toLonLat([extent[2], extent[3]]);
    cb({
      zoom: Math.round(view.getZoom()),
      bounds: `${sw[1]},${sw[0]},${ne[1]},${ne[0]}`,
    });
  }, []);

  const renderRouteLayers = useCallback((currentRoute, options = {}) => {
    const map = mapInstanceRef.current;
    const targetSource = options.targetSource || routeSourceRef.current;
    const hoverSource = hoverSourceRef.current;
    const buildHover = options.buildHover !== false;
    if (!map || !targetSource || !hoverSource) return;
    targetSource.clear();
    if (buildHover) hoverSource.clear();
    if (!currentRoute?.coordinates?.length) return;

    const coords = currentRoute.coordinates;
    const hasProfile = currentRoute.profileTimeMs && currentRoute.profileSpeedMph && currentRoute.profileDistMi;
    const isLarge = coords.length > SIMPLIFICATION_THRESHOLD;
    const zoom = map.getView().getZoom();
    const heatmap = heatmapEnabledRef.current && hasProfile;
    const topSpeed = currentRoute.topSpeed || 1;

    const addSegment = (a, b, color) => {
      const f = new Feature({ geometry: new LineString([lonLat(a), lonLat(b)]) });
      f.set('color', color);
      targetSource.addFeature(f);
    };

    const addPolyline = (pts, color) => {
      const f = new Feature({ geometry: new LineString(pts.map(lonLat)) });
      f.set('color', color);
      targetSource.addFeature(f);
    };

    const addHover = (a, b, idx) => {
      if (!buildHover) return;
      const f = new Feature({ geometry: new LineString([lonLat(a), lonLat(b)]) });
      f.set('hoverIdx', idx);
      hoverSource.addFeature(f);
    };

    if (!hasProfile) {
      let renderCoords = coords;
      if (isLarge) {
        const tolerance = getToleranceForZoom(zoom);
        if (tolerance) {
          const { simplified } = douglasPeucker(coords, tolerance);
          renderCoords = simplified;
        }
      }
      addPolyline(renderCoords, '#02d87f');
    } else if (!isLarge) {
      for (let i = 0; i < coords.length - 1; i++) {
        const segColor = heatmap ? speedToColor((currentRoute.profileSpeedMph[i] || 0) / topSpeed) : '#02d87f';
        addSegment(coords[i], coords[i + 1], segColor);
        if (i < currentRoute.profileTimeMs.length) addHover(coords[i], coords[i + 1], i);
      }
    } else {
      const tolerance = getToleranceForZoom(zoom);
      const showHover = shouldShowHover(zoom);

      const extent = map.getView().calculateExtent(map.getSize());
      const sw = toLonLat([extent[0], extent[1]]);
      const ne = toLonLat([extent[2], extent[3]]);
      const south = sw[1], west = sw[0], north = ne[1], east = ne[0];
      const latBuffer = (north - south) * 0.1;
      const lngBuffer = (east - west) * 0.1;
      const inBounds = (c) =>
        c[0] >= south - latBuffer && c[0] <= north + latBuffer &&
        c[1] >= west - lngBuffer && c[1] <= east + lngBuffer;

      if (tolerance) {
        const { simplified, indices } = douglasPeucker(coords, tolerance);
        if (heatmap) {
          for (let i = 0; i < simplified.length - 1; i++) {
            addSegment(
              simplified[i],
              simplified[i + 1],
              speedToColor((currentRoute.profileSpeedMph[indices[i]] || 0) / topSpeed),
            );
          }
        } else {
          addPolyline(simplified, '#02d87f');
        }
      } else if (heatmap) {
        for (let i = 0; i < coords.length - 1; i++) {
          if (!inBounds(coords[i]) && !inBounds(coords[i + 1])) continue;
          addSegment(coords[i], coords[i + 1], speedToColor((currentRoute.profileSpeedMph[i] || 0) / topSpeed));
        }
      } else {
        addPolyline(coords, '#02d87f');
      }

      if (showHover) {
        for (let i = 0; i < coords.length - 1; i++) {
          if (!inBounds(coords[i]) && !inBounds(coords[i + 1])) continue;
          if (i < currentRoute.profileTimeMs.length) addHover(coords[i], coords[i + 1], i);
        }
      }
    }
  }, []);

  const cancelFade = useCallback(() => {
    if (fadeAnimationRef.current) {
      cancelAnimationFrame(fadeAnimationRef.current);
      fadeAnimationRef.current = null;
    }
    const routeLayer = routeLayerRef.current;
    const fadeLayer = routeFadeLayerRef.current;
    if (routeLayer) routeLayer.setOpacity(1);
    if (fadeLayer) fadeLayer.setOpacity(0);
    routeFadeSourceRef.current?.clear();
  }, []);

  useEffect(() => {
    heatmapEnabledRef.current = heatmapEnabled;
    if (!heatmapInitedRef.current) {
      heatmapInitedRef.current = true;
      return;
    }
    const map = mapInstanceRef.current;
    const currentRoute = routeRef.current;
    const mainSource = routeSourceRef.current;
    const fadeSource = routeFadeSourceRef.current;
    const routeLayer = routeLayerRef.current;
    const fadeLayer = routeFadeLayerRef.current;
    if (!map || !currentRoute?.coordinates?.length || !mainSource || !fadeSource || !routeLayer || !fadeLayer) return;

    if (mainSource.getFeatures().length === 0) {
      renderRouteLayers(currentRoute);
      return;
    }

    cancelFade();
    renderRouteLayers(currentRoute, { targetSource: fadeSource, buildHover: false });
    fadeLayer.setOpacity(0);
    routeLayer.setOpacity(1);

    const start = performance.now();
    const duration = 250;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      routeLayer.setOpacity(1 - t);
      fadeLayer.setOpacity(t);
      if (t < 1) {
        fadeAnimationRef.current = requestAnimationFrame(tick);
      } else {
        fadeAnimationRef.current = null;
        const routeNow = routeRef.current;
        if (routeNow?.coordinates?.length) {
          renderRouteLayers(routeNow);
        } else {
          mainSource.clear();
        }
        fadeSource.clear();
        routeLayer.setOpacity(1);
        fadeLayer.setOpacity(0);
      }
    };
    fadeAnimationRef.current = requestAnimationFrame(tick);
  }, [heatmapEnabled, renderRouteLayers, cancelFade]);

  useEffect(() => {
    if (mapInstanceRef.current) return;

    const tileLayer = new TileLayer({ source: buildXYZ(tileUrl) });
    tileLayerRef.current = tileLayer;

    const routeSource = new VectorSource();
    routeSourceRef.current = routeSource;
    const routeLayer = new VectorLayer({
      source: routeSource,
      style: (feature) => new Style({
        stroke: new Stroke({ color: feature.get('color') || '#02d87f', width: 4 }),
      }),
    });
    routeLayerRef.current = routeLayer;

    const routeFadeSource = new VectorSource();
    routeFadeSourceRef.current = routeFadeSource;
    const routeFadeLayer = new VectorLayer({
      source: routeFadeSource,
      style: (feature) => new Style({
        stroke: new Stroke({ color: feature.get('color') || '#02d87f', width: 4 }),
      }),
      opacity: 0,
    });
    routeFadeLayerRef.current = routeFadeLayer;

    const hoverSource = new VectorSource();
    hoverSourceRef.current = hoverSource;
    const hoverLayer = new VectorLayer({
      source: hoverSource,
      style: new Style({ stroke: new Stroke({ color: 'rgba(255,255,255,0.001)', width: 20 }) }),
    });

    const markerSource = new VectorSource();
    markerSourceRef.current = markerSource;
    const markerLayer = new VectorLayer({
      source: markerSource,
      style: (feature) => new Style({
        image: new CircleStyle({
          radius: feature.get('radius') || 8,
          fill: new Fill({ color: feature.get('fillColor') || '#02d87f' }),
          stroke: new Stroke({ color: '#ffffff', width: 2 }),
        }),
      }),
    });

    const tooltipOverlay = new Overlay({
      element: tooltipRef.current,
      offset: [0, -16],
      positioning: 'bottom-center',
      stopEvent: false,
    });
    tooltipOverlayRef.current = tooltipOverlay;

    const buildingProbe = createBuildingProbe(buildingPopupRef.current);
    buildingProbeRef.current = buildingProbe;

    const measure = createRouteMeasure({
      labelElement: measureLabelRef.current,
      onChange: setMeasureInfo,
    });
    measureRef.current = measure;

    const map = new Map({
      target: mapRef.current,
      // The building outline goes directly above the basemap so it can never
      // cover the route line the user came here to look at.
      layers: [tileLayer, buildingProbe.layer, routeLayer, routeFadeLayer, hoverLayer, markerLayer, measure.layer],
      view: new View({ center: fromLonLat([-98.5795, 39.8283]), zoom: 4 }),
      controls: defaultControls().extend([new FullScreen()]),
      interactions: defaultInteractions({ mouseWheelZoom: false }).extend([
        new MouseWheelZoom({ condition: wheelZoomCondition }),
      ]),
      overlays: [tooltipOverlay, buildingProbe.overlay, measure.overlay],
    });
    mapInstanceRef.current = map;
    map.addInteraction(measure.interaction);

    measure.setMode(measureModeRef.current);
    if (routeRef.current) measure.setRoute(routeRef.current);
    if (measureActiveRef.current) {
      syncMeasureActive(map, measure, true);
      measure.setPoints(measurePointsStashRef.current);
    }

    const tooltipEl = tooltipRef.current;
    map.on('pointermove', (evt) => {
      if (measureActiveRef.current) {
        tooltipEl.style.display = 'none';
        if (!evt.dragging) {
          map.getTargetElement().style.cursor = measure.hover(map, evt.coordinate, evt.pixel, measureSnapPx(evt));
        }
        return;
      }
      if (evt.dragging) {
        tooltipEl.style.display = 'none';
        return;
      }
      let foundContent = null;
      let foundCoord = null;
      map.forEachFeatureAtPixel(evt.pixel, (feature) => {
        const html = feature.get('tooltipHtml');
        if (html) {
          foundContent = html;
          const geom = feature.getGeometry();
          if (geom?.getType() === 'Point') foundCoord = geom.getCoordinates();
          return true;
        }
        const idx = feature.get('hoverIdx');
        if (typeof idx === 'number') {
          const r = routeRef.current;
          if (r) {
            foundContent = buildTooltipContent(r, idx, unitFormatterRef.current);
            return true;
          }
        }
        return false;
      }, { hitTolerance: 3 });

      if (foundContent) {
        tooltipEl.innerHTML = foundContent;
        tooltipEl.style.display = 'block';
        tooltipOverlay.setPosition(foundCoord || evt.coordinate);
      } else {
        tooltipEl.style.display = 'none';
      }
    });

    // Click-to-identify. The route's own markers and hover segments already
    // own their clicks, so only a click on bare map asks the geocoder what
    // building is there. Bound to 'singleclick', not 'click', so a
    // double-click-to-zoom does not also fire a lookup.
    const onSingleClick = (evt) => {
      if (measureActiveRef.current) return;
      let hitOwnFeature = false;
      map.forEachFeatureAtPixel(evt.pixel, (feature) => {
        if (feature.get('tooltipHtml') || typeof feature.get('hoverIdx') === 'number') {
          hitOwnFeature = true;
          return true;
        }
        return false;
      }, {
        hitTolerance: 3,
        // Without this the outline drawn by a previous probe would count as a
        // hit and block the next one.
        layerFilter: (layer) => layer !== buildingProbe.layer,
      });

      if (hitOwnFeature) {
        buildingProbe.clear();
        return;
      }
      buildingProbe.probe(evt.coordinate);
    };
    map.on('singleclick', onSingleClick);

    // Measuring listens to 'click' rather than 'singleclick' so points land
    // without the double-click delay; double-click zoom is switched off while
    // measuring so two quick clicks cannot place A and B on the same spot.
    const onMeasureClick = (evt) => {
      if (!measureActiveRef.current) return;
      const result = measure.click(map, evt.coordinate, evt.pixel, measureSnapPx(evt));
      clearTimeout(measureMissTimerRef.current);
      setMeasureMiss(result === 'miss');
      if (result === 'miss') {
        measureMissTimerRef.current = setTimeout(() => setMeasureMiss(false), 1600);
      }
    };
    map.on('click', onMeasureClick);

    const viewportEl = map.getViewport();
    const onViewportLeave = () => measure.clearHover();
    viewportEl.addEventListener('mouseleave', onViewportLeave);

    // A plain upward wheel with the page already at the top can't scroll
    // anywhere: it's someone trying to zoom in, so say how. Gestures that
    // began while the page was still scrolling (coasting back up from the
    // details) are left alone.
    const scroller = mapRef.current?.closest('.journey-stage');
    let lastScrollAt = 0;
    let lastWheelAt = 0;
    let wheelGestureScrolling = false;
    const onScrollerScroll = () => { lastScrollAt = performance.now(); };
    scroller?.addEventListener('scroll', onScrollerScroll, { passive: true });
    const onViewportWheel = (e) => {
      const now = performance.now();
      if (now - lastWheelAt > 200) {
        wheelGestureScrolling = Boolean(scroller) && (scroller.scrollTop > 0 || now - lastScrollAt < 200);
      }
      lastWheelAt = now;
      if (wheelGestureScrolling || e.deltaY >= 0 || isZoomWheel(e) || document.fullscreenElement) return;
      setWheelHintVisible(true);
      clearTimeout(wheelHintTimerRef.current);
      wheelHintTimerRef.current = setTimeout(() => setWheelHintVisible(false), 1500);
    };
    viewportEl.addEventListener('wheel', onViewportWheel, { passive: true });

    const onViewChange = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const currentRoute = routeRef.current;
        if (currentRoute?.coordinates?.length > SIMPLIFICATION_THRESHOLD) {
          renderRouteLayers(currentRoute);
        }
        emitViewportChange();
      }, 200);
    };
    map.on('moveend', onViewChange);

    return () => {
      clearTimeout(debounceRef.current);
      if (fadeAnimationRef.current) {
        cancelAnimationFrame(fadeAnimationRef.current);
        fadeAnimationRef.current = null;
      }
      map.un('singleclick', onSingleClick);
      map.un('click', onMeasureClick);
      viewportEl.removeEventListener('mouseleave', onViewportLeave);
      viewportEl.removeEventListener('wheel', onViewportWheel);
      scroller?.removeEventListener('scroll', onScrollerScroll);
      clearTimeout(wheelHintTimerRef.current);
      clearTimeout(measureMissTimerRef.current);
      buildingProbe.destroy();
      buildingProbeRef.current = null;
      measurePointsStashRef.current = measure.getPoints();
      measure.destroy();
      measureRef.current = null;
      map.setTarget(null);
      mapInstanceRef.current = null;
    };
  }, [emitViewportChange, renderRouteLayers, tileUrl]);

  useEffect(() => {
    if (!tileLayerRef.current) return;
    tileLayerRef.current.setSource(buildXYZ(tileUrl));
  }, [tileUrl]);

  useEffect(() => {
    const currentRoute = routeRef.current;
    if (!currentRoute?.coordinates?.length) return;
    renderRouteLayers(currentRoute);
  }, [renderRouteLayers, speedUnit, distanceUnit, elevationUnit, accelerationUnit]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    const timer = setTimeout(() => map.updateSize(), 350);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);

  useEffect(() => {
    measureRef.current?.setRoute(route);
  }, [route]);

  useEffect(() => {
    measureActiveRef.current = measureActive;
    const map = mapInstanceRef.current;
    const measure = measureRef.current;
    if (!map || !measure) return;
    syncMeasureActive(map, measure, measureActive);
    if (measureActive) {
      if (tooltipRef.current) tooltipRef.current.style.display = 'none';
      buildingProbeRef.current?.clear();
    }
  }, [measureActive]);

  useEffect(() => {
    measureModeRef.current = measureMode;
    measureRef.current?.setMode(measureMode);
    try {
      localStorage.setItem(MEASURE_MODE_KEY, measureMode);
    } catch {
      // Private windows can refuse storage; the choice just won't persist.
    }
  }, [measureMode]);

  useEffect(() => {
    if (!measureActive) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onMeasureActiveChangeRef.current?.(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [measureActive]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const markerSource = markerSourceRef.current;
    if (!map || !markerSource) return;

    cancelFade();
    markerSource.clear();
    routeSourceRef.current?.clear();
    hoverSourceRef.current?.clear();
    if (tooltipRef.current) tooltipRef.current.style.display = 'none';
    // The map is about to fly somewhere else; a popup anchored to the old view
    // would drift off to a building the user is no longer looking at.
    buildingProbeRef.current?.clear();

    if (!route?.coordinates?.length) return;

    if (route.startCoord) {
      const f = new Feature({ geometry: new Point(lonLat(route.startCoord)) });
      f.set('fillColor', '#02d87f');
      f.set('radius', 8);
      f.set('tooltipHtml', `
        <div style="color: var(--accent-primary); font-weight: 500; margin-bottom: 8px; border-bottom: 1px solid var(--bg-tertiary); padding-bottom: 4px;">Journey Start</div>
        <div class="tooltip-row"><span class="tooltip-label">Journey:</span><span class="tooltip-value">${route.name}</span></div>
        <div class="tooltip-row"><span class="tooltip-label">Date:</span><span class="tooltip-value">${route.date}</span></div>
      `);
      markerSource.addFeature(f);
    }

    if (route.endCoord && JSON.stringify(route.endCoord) !== JSON.stringify(route.startCoord)) {
      const f = new Feature({ geometry: new Point(lonLat(route.endCoord)) });
      f.set('fillColor', '#ff4444');
      f.set('radius', 8);
      f.set('tooltipHtml', `
        <div style="color: var(--accent-danger); font-weight: 500; margin-bottom: 8px; border-bottom: 1px solid var(--bg-tertiary); padding-bottom: 4px;">Journey End</div>
        <div class="tooltip-row"><span class="tooltip-label">Journey:</span><span class="tooltip-value">${route.name}</span></div>
        <div class="tooltip-row"><span class="tooltip-label">Date:</span><span class="tooltip-value">${route.date}</span></div>
      `);
      markerSource.addFeature(f);
    }

    if (route.waypoints?.length > 0) {
      route.waypoints.forEach((wp, idx) => {
        const f = new Feature({ geometry: new Point(fromLonLat([wp.lon, wp.lat])) });
        f.set('fillColor', '#4A90E2');
        f.set('radius', 6);
        const displayName = wp.label?.trim() || wp.note?.trim() || `Saved Spot ${idx + 1}`;
        f.set('tooltipHtml', `<div style="color:#4A90E2; font-weight:600;">${displayName}</div>`);
        markerSource.addFeature(f);
      });
    }

    const isNewRouteSelection = lastRouteIdRef.current !== route.id;
    if (isNewRouteSelection) {
      const projected = route.coordinates.map(lonLat);
      const extent = boundingExtent(projected);
      const stageEl = mapRef.current?.closest('.journey-stage');
      const topOverlayEl = stageEl?.querySelector('.journey-top-content');
      const fadeEl = stageEl?.querySelector('.journey-hero-fade');
      const sidebarEl = document.querySelector('.route-list-container.floating:not(.collapsed)');
      const mapRect = mapRef.current?.getBoundingClientRect();

      const topPad = topOverlayEl ? Math.ceil(topOverlayEl.getBoundingClientRect().height) + 24 : 50;
      // The upper part of the fade into the details is still mostly see-through
      const bottomPad = fadeEl ? Math.ceil(fadeEl.getBoundingClientRect().height * 0.6) + 40 : 90;
      const leftPad = (sidebarEl && mapRect)
        ? Math.max(50, Math.ceil(sidebarEl.getBoundingClientRect().right - mapRect.left) + 20)
        : 50;

      map.getView().fit(extent, { padding: [topPad, 50, bottomPad, leftPad], duration: 0 });
    }
    lastRouteIdRef.current = route.id;

    renderRouteLayers(route);

    setTimeout(() => {
      map.updateSize();
      emitViewportChange();
    }, 100);
  }, [route, emitViewportChange, renderRouteLayers, cancelFade]);

  const hasSpeedData = route?.profileSpeedMph;

  const formatMeasured = (miles) => {
    const value = convertDistance(miles);
    if (value == null) return '--';
    if (isMetric && value < 1) return `${Math.round(value * 1000)} m`;
    if (!isMetric && value < 0.1) return `${Math.round(value * 5280)} ft`;
    // Hundredths for everyday distances; tenths beyond 100 so a whole-journey
    // measurement reads the same as the journey's own distance stat
    // (toFixed rather than toLocaleString, to round exactly the way it does).
    const fixed = value.toFixed(value < 100 ? 2 : 1).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${fixed} ${distanceUnit}`;
  };
  const clickVerb = window.matchMedia?.('(pointer: coarse)').matches ? 'Tap' : 'Click';
  const measured = measureInfo.count === 2;
  const measuredMi = measureMode === 'air' ? measureInfo.airMi : measureInfo.routeMi;
  let measureStatus;
  if (measureMiss) measureStatus = `${clickVerb} on the route line`;
  else if (measureInfo.count === 0) {
    measureStatus = route?.isFullResolution === false
      ? 'Loading full track…'
      : `${clickVerb} the route to set point A`;
  } else if (measureInfo.count === 1) measureStatus = `Now ${clickVerb.toLowerCase()} point B`;
  else measureStatus = 'Drag A or B to adjust';

  return (
    <div className={`map-container${fullscreen ? ' fullscreen' : ''}`}>
      <div id="map" ref={mapRef} />
      <div
        ref={tooltipRef}
        className="route-tooltip"
        style={{ display: 'none', pointerEvents: 'none', position: 'absolute' }}
      />
      <div ref={buildingPopupRef} className="building-popup" style={{ display: 'none' }} />
      <div ref={measureLabelRef} className="measure-label" aria-live="polite">
        {measureActive && measured && (
          <>
            <span className="measure-label-value">{formatMeasured(measuredMi)}</span>
            <span className="measure-label-caption">{measureMode === 'air' ? 'straight line' : 'along route'}</span>
          </>
        )}
      </div>
      {measureActive && (
        <div ref={measureBarRef} className="measure-bar" role="toolbar" aria-label="Measure distance">
          <div className={`measure-bar-status${measureMiss ? ' is-miss' : ''}`}>
            <span className={`measure-step${measureInfo.count >= 1 ? ' done' : ''}`} aria-hidden="true">A</span>
            <span className={`measure-step${measureInfo.count >= 2 ? ' done' : ''}`} aria-hidden="true">B</span>
            <span className="measure-bar-text">{measureStatus}</span>
          </div>
          <div className="measure-mode-toggle" role="radiogroup" aria-label="Distance type">
            <button
              type="button"
              role="radio"
              aria-checked={measureMode === 'route'}
              className={`measure-mode-btn${measureMode === 'route' ? ' active' : ''}`}
              onClick={() => setMeasureMode('route')}
              title="Distance actually traveled along the recorded journey"
            >
              <span className="measure-mode-name">Along route</span>
              {measured && <span className="measure-mode-value">{formatMeasured(measureInfo.routeMi)}</span>}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={measureMode === 'air'}
              className={`measure-mode-btn${measureMode === 'air' ? ' active' : ''}`}
              onClick={() => setMeasureMode('air')}
              title="Straight-line (air) distance between the two points"
            >
              <span className="measure-mode-name">Straight line</span>
              {measured && <span className="measure-mode-value">{formatMeasured(measureInfo.airMi)}</span>}
            </button>
          </div>
          <button
            type="button"
            className="measure-bar-close"
            onClick={() => onMeasureActiveChange?.(false)}
            aria-label="Stop measuring"
            title="Stop measuring (Esc)"
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className={`map-wheel-hint${wheelHintVisible ? ' visible' : ''}`} aria-hidden="true">
        Use {ZOOM_MODIFIER_LABEL} + scroll to zoom the map
      </div>
      {(weather || hasSpeedData) && (
        <WeatherBadge
          weather={weather}
          startTime={route?.startTime}
          lat={route?.startCoord?.[0]}
          lon={route?.startCoord?.[1]}
          overlay
          routeId={route?.id}
          hasSpeedData={hasSpeedData}
          heatmapEnabled={heatmapEnabled}
          onToggleHeatmap={() => setHeatmapEnabled(prev => !prev)}
        />
      )}
    </div>
  );
}
