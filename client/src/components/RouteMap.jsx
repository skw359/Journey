import { useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-fullscreen';
import 'leaflet-fullscreen/dist/leaflet.fullscreen.css';
import { useTheme } from '../context/ThemeContext';
import { useUnits } from '../context/UnitsContext';
import { TILE_ATTRIBUTION } from '../utils/mapUtils';
import { formatTime, calculateAcceleration } from '../utils/formatters';
import { douglasPeucker, getToleranceForZoom, shouldShowHover } from '../utils/simplify';

const SIMPLIFICATION_THRESHOLD = 5000;

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

export default function RouteMap({ route, sidebarCollapsed, onViewportChange }) {
  const { tileUrl } = useTheme();
  const {
    convertSpeed,
    convertDistance,
    convertElevation,
    convertAcceleration,
    speedUnit,
    distanceUnit,
    elevationUnit,
    accelerationUnit,
  } = useUnits();
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const tileLayerRef = useRef(null);
  const markerLayersRef = useRef([]);
  const routeLayersRef = useRef([]);
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

  const emitViewportChange = useCallback((map) => {
    const cb = onViewportChangeRef.current;
    if (!cb || !map) return;
    const bounds = map.getBounds();
    cb({
      zoom: map.getZoom(),
      bounds: `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`,
    });
  }, []);

  const clearRouteLayers = useCallback((map) => {
    routeLayersRef.current.forEach(l => map.removeLayer(l));
    routeLayersRef.current = [];
  }, []);

  const renderRouteLayers = useCallback((map, currentRoute) => {
    clearRouteLayers(map);
    if (!currentRoute?.coordinates?.length) return;

    const layers = [];
    const coords = currentRoute.coordinates;
    const hasProfile = currentRoute.profileTimeMs && currentRoute.profileSpeedMph && currentRoute.profileDistMi;
    const isLarge = coords.length > SIMPLIFICATION_THRESHOLD;
    const zoom = map.getZoom();

    if (!hasProfile) {
      let renderCoords = coords;
      if (isLarge) {
        const tolerance = getToleranceForZoom(zoom);
        if (tolerance) {
          const { simplified } = douglasPeucker(coords, tolerance);
          renderCoords = simplified;
        }
      }
      const line = L.polyline(renderCoords, {
        color: '#02d87f', weight: 4, opacity: 0.9, className: 'visual-route-segment', pane: 'routePane',
      }).addTo(map);
      layers.push(line);
    } else if (!isLarge) {
      for (let i = 0; i < coords.length - 1; i++) {
        const line = L.polyline([coords[i], coords[i + 1]], {
          color: '#02d87f', weight: 4, opacity: 0.9, className: 'visual-route-segment', pane: 'routePane',
        }).addTo(map);
        layers.push(line);

        if (i < currentRoute.profileTimeMs.length) {
          const hover = L.polyline([coords[i], coords[i + 1]], {
            color: 'white', weight: 20, opacity: 0, className: 'interactive-hover-segment', pane: 'routePane',
          }).addTo(map);
          hover.bindTooltip(buildTooltipContent(currentRoute, i, unitFormatterRef.current), {
            permanent: false, direction: 'top', offset: [0, -10], opacity: 0.95, className: 'route-tooltip',
          });
          layers.push(hover);
        }
      }
    } else {
      const tolerance = getToleranceForZoom(zoom);
      const showHover = shouldShowHover(zoom);

      if (!showHover) {
        let renderCoords = coords;
        if (tolerance) {
          const { simplified } = douglasPeucker(coords, tolerance);
          renderCoords = simplified;
        }
        const line = L.polyline(renderCoords, {
          color: '#02d87f', weight: 4, opacity: 0.9, className: 'visual-route-segment', pane: 'routePane',
        }).addTo(map);
        layers.push(line);
      } else {
        let renderCoords = coords;
        if (tolerance) {
          const { simplified } = douglasPeucker(coords, tolerance);
          renderCoords = simplified;
        }

        const line = L.polyline(renderCoords, {
          color: '#02d87f', weight: 4, opacity: 0.9, className: 'visual-route-segment', pane: 'routePane',
        }).addTo(map);
        layers.push(line);

        const mapBounds = map.getBounds();
        const latBuffer = (mapBounds.getNorth() - mapBounds.getSouth()) * 0.1;
        const lngBuffer = (mapBounds.getEast() - mapBounds.getWest()) * 0.1;
        const bufferedBounds = L.latLngBounds(
          [mapBounds.getSouth() - latBuffer, mapBounds.getWest() - lngBuffer],
          [mapBounds.getNorth() + latBuffer, mapBounds.getEast() + lngBuffer]
        );

        for (let i = 0; i < coords.length - 1; i++) {
          const curr = coords[i];
          const next = coords[i + 1];

          if (!bufferedBounds.contains(L.latLng(curr[0], curr[1])) &&
              !bufferedBounds.contains(L.latLng(next[0], next[1]))) {
            continue;
          }

          if (i < currentRoute.profileTimeMs.length) {
            const hover = L.polyline([curr, next], {
              color: 'white', weight: 20, opacity: 0, className: 'interactive-hover-segment', pane: 'routePane',
            }).addTo(map);
            hover.bindTooltip(buildTooltipContent(currentRoute, i, unitFormatterRef.current), {
              permanent: false, direction: 'top', offset: [0, -10], opacity: 0.95, className: 'route-tooltip',
            });
            layers.push(hover);
          }
        }
      }
    }

    routeLayersRef.current = layers;
  }, [clearRouteLayers]);

  useEffect(() => {
    if (mapInstanceRef.current) return;

    const map = L.map(mapRef.current, { fullscreenControl: true }).setView([39.8283, -98.5795], 4);
    mapInstanceRef.current = map;

    tileLayerRef.current = L.tileLayer(tileUrl, {
      attribution: TILE_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);

    map.createPane('routePane');
    map.getPane('routePane').style.zIndex = 420;
    map.createPane('waypointPane');
    map.getPane('waypointPane').style.zIndex = 650;

    const onViewChange = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const currentRoute = routeRef.current;
        if (currentRoute?.coordinates?.length > SIMPLIFICATION_THRESHOLD) {
          renderRouteLayers(map, currentRoute);
        }
        emitViewportChange(map);
      }, 200);
    };

    map.on('zoomend', onViewChange);
    map.on('moveend', onViewChange);

    return () => {
      clearTimeout(debounceRef.current);
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [emitViewportChange, renderRouteLayers]);

  useEffect(() => {
    if (tileLayerRef.current) {
      tileLayerRef.current.setUrl(tileUrl);
    }
  }, [tileUrl]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const currentRoute = routeRef.current;
    if (!map || !currentRoute?.coordinates?.length) return;
    renderRouteLayers(map, currentRoute);
  }, [renderRouteLayers, speedUnit, distanceUnit, elevationUnit, accelerationUnit]);

  useEffect(() => {
    if (mapInstanceRef.current) {
      const timer = setTimeout(() => {
        mapInstanceRef.current.invalidateSize();
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    markerLayersRef.current.forEach(l => map.removeLayer(l));
    markerLayersRef.current = [];
    clearRouteLayers(map);

    if (!route?.coordinates?.length) return;

    const markers = [];

    if (route.startCoord) {
      const startMarker = L.circleMarker(route.startCoord, {
        radius: 8, fillColor: '#02d87f', color: '#ffffff', weight: 2, fillOpacity: 0.9, pane: 'routePane',
      });
      startMarker.bindTooltip(`
        <div style="color: var(--accent-primary); font-weight: 500; margin-bottom: 8px; border-bottom: 1px solid var(--bg-tertiary); padding-bottom: 4px;">Journey Start</div>
        <div style="display:flex; justify-content:space-between; margin:2px 0;"><span class="tooltip-label">Journey:</span><span class="tooltip-value">${route.name}</span></div>
        <div style="display:flex; justify-content:space-between; margin:2px 0;"><span class="tooltip-label">Date:</span><span class="tooltip-value">${route.date}</span></div>
      `, { className: 'route-tooltip' });
      startMarker.addTo(map);
      markers.push(startMarker);
    }

    if (route.endCoord && JSON.stringify(route.endCoord) !== JSON.stringify(route.startCoord)) {
      const endMarker = L.circleMarker(route.endCoord, {
        radius: 8, fillColor: '#ff4444', color: '#ffffff', weight: 2, fillOpacity: 0.9, pane: 'routePane',
      });
      endMarker.bindTooltip(`
        <div style="color: var(--accent-danger); font-weight: 500; margin-bottom: 8px; border-bottom: 1px solid var(--bg-tertiary); padding-bottom: 4px;">Journey End</div>
        <div style="display:flex; justify-content:space-between; margin:2px 0;"><span class="tooltip-label">Journey:</span><span class="tooltip-value">${route.name}</span></div>
        <div style="display:flex; justify-content:space-between; margin:2px 0;"><span class="tooltip-label">Date:</span><span class="tooltip-value">${route.date}</span></div>
      `, { className: 'route-tooltip' });
      endMarker.addTo(map);
      markers.push(endMarker);
    }

    if (route.waypoints?.length > 0) {
      route.waypoints.forEach((wp, idx) => {
        const wpMarker = L.circleMarker([wp.lat, wp.lon], {
          radius: 6, fillColor: '#4A90E2', color: '#ffffff', weight: 2, fillOpacity: 0.9, pane: 'waypointPane',
        });
        const displayName = wp.label?.trim() || wp.note?.trim() || `Saved Spot ${idx + 1}`;
        wpMarker.bindTooltip(`<div style="color:#4A90E2; font-weight:600;">${displayName}</div>`, {
          className: 'route-tooltip', direction: 'top',
        });
        wpMarker.addTo(map);
        markers.push(wpMarker);
      });
    }

    markerLayersRef.current = markers;
    const isNewRouteSelection = lastRouteIdRef.current !== route.id;
    if (isNewRouteSelection) {
      const bounds = L.latLngBounds(route.coordinates);
      map.fitBounds(bounds, { padding: [50, 50] });
    }
    lastRouteIdRef.current = route.id;

    renderRouteLayers(map, route);

    setTimeout(() => {
      map.invalidateSize();
      emitViewportChange(map);
    }, 100);
  }, [route, clearRouteLayers, emitViewportChange, renderRouteLayers]);

  return (
    <div className="map-container">
      <div id="map" ref={mapRef} />
    </div>
  );
}
