import VectorTileLayer from 'ol/layer/VectorTile';
import VectorTileSource from 'ol/source/VectorTile';
import CanvasVectorTileLayerRenderer from 'ol/renderer/canvas/VectorTileLayer';
import MVT from 'ol/format/MVT';
import {
  reset as resetTransform,
  scale as scaleTransform,
  translate as translateTransform,
} from 'ol/transform';
import { getUid } from 'ol/util';
import { applyStyle, applyBackground } from 'ol-mapbox-style';
import { PALETTES, BASEMAP_PROPERTY, BASEMAP_ATTRIBUTION } from './basemapTheme';

// Vector basemap: OpenFreeMap's free, keyless OpenMapTiles data drawn with
// our own style, so it stays sharp at any pixel ratio. The server's CSP
// (connect-src) must allow this host.
//
// This module is shared by the page and the basemap worker, so it must not
// touch the DOM. Maps get their layer from basemap.js.
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

export { BASEMAP_ATTRIBUTION, BASEMAP_PROPERTY, basemapBackground, basemapThemeKey } from './basemapTheme';

const FONT = ['Montserrat Medium'];
const FONT_BOLD = ['Montserrat SemiBold'];
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];

const zoomLinear = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];
const roadClass = (...classes) => ['match', ['get', 'class'], classes, true, false];

function roadLayers(p) {
  // Casings first, then fills, so junctions read as one continuous surface.
  const minor = roadClass('minor', 'service', 'track');
  const major = roadClass('primary', 'secondary', 'tertiary');
  const motorway = roadClass('motorway', 'trunk');
  const notTunnel = ['!=', ['get', 'brunnel'], 'tunnel'];

  const minorWidth = zoomLinear(12, 0.5, 14, 2, 16, 6, 18, 16, 20, 40);
  const majorWidth = zoomLinear(8, 0.6, 12, 2, 14, 4, 16, 10, 18, 24, 20, 60);
  const motorwayWidth = zoomLinear(5, 0.6, 9, 1.6, 12, 3, 14, 5.5, 16, 12, 18, 28, 20, 70);
  // ["zoom"] must stay at the top of an interpolate, so widen each stop instead of adding.
  const caseOf = (w) => [...w.slice(0, 3), ...w.slice(3).map((v, i) => (i % 2 ? v + 1.5 : v))];

  const line = (id, filter, color, width, minzoom = 0, extra = {}) => ({
    id,
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    minzoom,
    filter: ['all', filter, ...(extra.tunnel ? [] : [notTunnel])],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': width, ...(extra.paint || {}) },
  });

  return [
    line('road-tunnel', ['==', ['get', 'brunnel'], 'tunnel'], p.roadTunnel, majorWidth, 12, { tunnel: true, paint: { 'line-opacity': 0.6 } }),
    line('road-path', roadClass('path'), p.path, zoomLinear(15, 0.75, 18, 2), 15, { paint: { 'line-dasharray': [2, 1.5] } }),
    line('road-minor-case', minor, p.roadMinorCase, caseOf(minorWidth), 13),
    line('road-major-case', major, p.roadMajorCase, caseOf(majorWidth), 9),
    line('road-motorway-case', motorway, p.motorwayCase, caseOf(motorwayWidth), 6),
    line('road-minor', minor, p.roadMinor, minorWidth, 12),
    line('road-major', major, p.roadMajor, majorWidth, 8),
    line('road-motorway', motorway, p.motorway, motorwayWidth, 5),
    line('rail', roadClass('rail', 'transit'), p.rail, zoomLinear(12, 0.6, 18, 2), 12, { paint: { 'line-dasharray': [3, 2] } }),
  ];
}

function buildStyle(theme) {
  const p = PALETTES[theme] || PALETTES.dark;
  const halo = { 'text-halo-color': p.labelHalo, 'text-halo-width': 1.4, 'text-halo-blur': 0.4 };

  return {
    version: 8,
    name: `journey-${theme}`,
    sources: {
      openmaptiles: { type: 'vector', url: TILEJSON_URL, attribution: BASEMAP_ATTRIBUTION },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.land } },
      {
        id: 'landuse-urban',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        filter: roadClass('residential', 'suburb', 'neighbourhood', 'quarter'),
        paint: { 'fill-color': p.urban },
      },
      {
        id: 'landuse-special',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        paint: {
          'fill-color': [
            'match', ['get', 'class'],
            ['commercial', 'retail'], p.commercial,
            ['industrial', 'railway', 'garages'], p.industrial,
            'hospital', p.hospital,
            ['school', 'university', 'college', 'kindergarten'], p.school,
            ['stadium', 'pitch', 'playground'], p.sports,
            'cemetery', p.cemetery,
            'zoo', p.grass,
            'transparent',
          ],
        },
      },
      {
        id: 'landcover',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landcover',
        paint: {
          'fill-color': [
            'match', ['get', 'class'],
            'wood', p.wood,
            'grass', p.grass,
            'farmland', p.farmland,
            'sand', p.sand,
            'ice', p.ice,
            'wetland', p.wetland,
            'transparent',
          ],
          'fill-opacity': zoomLinear(4, 0.6, 10, 1),
        },
      },
      {
        id: 'park',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'park',
        paint: { 'fill-color': p.park, 'fill-opacity': zoomLinear(4, 0.5, 9, 1) },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'waterway',
        minzoom: 8,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.waterLine, 'line-width': zoomLinear(8, 0.5, 13, 1.5, 18, 6) },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': p.water },
      },
      {
        id: 'aeroway-area',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'aeroway',
        minzoom: 10,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': p.aeroway },
      },
      {
        id: 'aeroway-runway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'aeroway',
        minzoom: 10,
        filter: ['match', ['get', 'class'], ['runway', 'taxiway'], true, false],
        paint: {
          'line-color': ['match', ['get', 'class'], 'runway', p.runway, p.taxiway],
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, ['match', ['get', 'class'], 'runway', 2, 0.5], 16, ['match', ['get', 'class'], 'runway', 40, 8]],
        },
      },
      {
        id: 'building',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-color': p.building,
          'fill-outline-color': p.buildingLine,
          'fill-opacity': zoomLinear(14, 0, 15, 1),
        },
      },
      ...roadLayers(p),
      {
        id: 'boundary-state',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': p.boundaryState, 'line-width': zoomLinear(3, 0.6, 10, 1.4), 'line-dasharray': [3, 2] },
      },
      {
        id: 'boundary-country',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], ['!=', ['get', 'disputed'], 1]],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': p.boundary, 'line-width': zoomLinear(2, 0.8, 10, 2) },
      },
      ...['Point', 'LineString'].map((geom) => ({
        id: `water-name-${geom}`,
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water_name',
        filter: ['==', ['geometry-type'], geom],
        layout: {
          'text-field': NAME,
          'text-font': FONT,
          'text-size': ['match', ['get', 'class'], 'ocean', 14, 'sea', 13, 12],
          'text-letter-spacing': 0.05,
          'symbol-placement': geom === 'Point' ? 'point' : 'line',
          'text-max-width': 6,
        },
        paint: { 'text-color': p.waterLabel, ...halo },
      })),
      {
        id: 'waterway-name',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'waterway',
        minzoom: 13,
        layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 11, 'symbol-placement': 'line' },
        paint: { 'text-color': p.waterLabel, ...halo },
      },
      {
        id: 'road-name',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'transportation_name',
        minzoom: 13,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'], true, false],
        layout: {
          'text-field': NAME,
          'text-font': FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 12.5],
          'symbol-placement': 'line',
          'text-rotation-alignment': 'map',
          'symbol-spacing': 320,
        },
        paint: {
          'text-color': ['match', ['get', 'class'], ['motorway', 'trunk'], p.labelHighway, p.labelRoad],
          ...halo,
        },
      },
      {
        id: 'park-name',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'poi',
        minzoom: 14,
        filter: ['match', ['get', 'class'], ['park'], true, false],
        layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 11, 'text-max-width': 8 },
        paint: { 'text-color': p.parkLabel, ...halo },
      },
      {
        id: 'place-minor',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 11,
        filter: ['match', ['get', 'class'], ['suburb', 'neighbourhood', 'quarter', 'hamlet'], true, false],
        layout: {
          'text-field': NAME,
          'text-font': FONT,
          'text-size': 11,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.08,
          'text-max-width': 8,
        },
        paint: { 'text-color': p.labelMinor, ...halo },
      },
      {
        id: 'place-town',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 8,
        filter: ['match', ['get', 'class'], ['town', 'village'], true, false],
        layout: {
          'text-field': NAME,
          'text-font': FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 14],
          'text-max-width': 8,
        },
        paint: { 'text-color': p.labelCity, ...halo },
      },
      {
        id: 'place-city',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 4,
        filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': NAME,
          'text-font': FONT_BOLD,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 14, 12, 17],
          'text-max-width': 8,
        },
        paint: { 'text-color': p.labelCity, ...halo },
      },
      {
        id: 'place-state',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 4,
        maxzoom: 8,
        filter: ['==', ['get', 'class'], 'state'],
        layout: {
          'text-field': NAME,
          'text-font': FONT,
          'text-size': 11,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
        },
        paint: { 'text-color': p.labelState, ...halo },
      },
      {
        id: 'place-country',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        maxzoom: 7,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': NAME,
          'text-font': FONT_BOLD,
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 6, 15],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.1,
          'text-max-width': 7,
        },
        paint: { 'text-color': p.labelCountry, ...halo },
      },
    ],
  };
}

// Bounds tile canvases on HiDPI screens (3 = 1536px for a 512px tile).
const MAX_TILE_PIXEL_RATIO = 3;

// OpenLayers draws a tile image at a whole-number pixel ratio, so at the
// fractional zooms fit() lands on (most first views) tiles were upscaled up
// to 2x and looked blurry. Draw them at exactly the ratio they're shown at.
// Mirrors ol 10.9's renderTileImage_ with only the pixel ratio changed.
class SharpVectorTileLayerRenderer extends CanvasVectorTileLayerRenderer {
  renderTileImage_(tile, frameState) {
    const layer = this.getLayer();
    const replayState = tile.getReplayState(layer);
    const executorGroups = tile.executorGroups[getUid(layer)];
    replayState.renderedTileRevision = layer.getRevision();

    const tileCoord = tile.wrappedTileCoord;
    const z = tileCoord[0];
    const source = layer.getSource();
    const projection = frameState.viewState.projection;
    const tileGrid = source.getTileGridForProjection(projection);
    const tileResolution = tileGrid.getResolution(tile.tileCoord[0]);
    const renderPixelRatio = (frameState.pixelRatio / tile.wantedResolution) * tileResolution;
    const pixelRatio = Math.min(renderPixelRatio, MAX_TILE_PIXEL_RATIO);
    const context = tile.getContext();
    const size = source.getTilePixelSize(z, pixelRatio, projection);
    context.canvas.width = size[0];
    context.canvas.height = size[1];
    const renderScale = pixelRatio / renderPixelRatio;
    if (renderScale !== 1) {
      const canvasTransform = scaleTransform(resetTransform(this.tmpTransform_), renderScale, renderScale);
      context.setTransform.apply(context, canvasTransform);
    }
    const tileExtent = tileGrid.getTileCoordExtent(tileCoord, this.tempExtent);
    const pixelScale = renderPixelRatio / tileGrid.getResolution(z);
    const transform = resetTransform(this.tmpTransform_);
    scaleTransform(transform, pixelScale, -pixelScale);
    translateTransform(transform, -tileExtent[0], -tileExtent[3]);
    for (const executorGroup of executorGroups) {
      executorGroup.execute(
        context,
        [context.canvas.width * renderScale, context.canvas.height * renderScale],
        transform,
        0,
        true,
        ['Polygon', 'LineString'], // what 'hybrid' render mode bakes into tiles
        null,
      );
    }
    replayState.renderedTileResolution = tile.wantedResolution;
  }
}

class SharpVectorTileLayer extends VectorTileLayer {
  createRenderer() {
    return new SharpVectorTileLayerRenderer(this, { cacheSize: this.cacheSize_ });
  }
}

// The basemap as an ordinary OpenLayers layer. The worker renders this same
// layer; the page uses it directly when a worker can't be used.
export function createVectorBasemapLayer(theme) {
  const style = buildStyle(theme);
  // Decode only the tile layers the style draws. OpenMapTiles also ships house
  // numbers, peaks and airport labels, which would cost parse and render time
  // for nothing. ol-mapbox-style keeps a source's own format and fills in the
  // URLs and tile grid from the TileJSON.
  const sourceLayers = [...new Set(style.layers.map((l) => l['source-layer']).filter(Boolean))];
  const source = new VectorTileSource({
    state: 'loading',
    format: new MVT({ layerName: 'mvt:layer', layers: sourceLayers }),
  });
  const layer = new SharpVectorTileLayer({ declutter: true, source, properties: { [BASEMAP_PROPERTY]: true } });
  applyBackground(layer, style);
  applyStyle(layer, style, { updateSource: true })
    .then(() => source.setState('ready'))
    .catch(() => source.setState('error'));
  return layer;
}

export function applyVectorBasemapTheme(layer, theme) {
  const style = buildStyle(theme);
  applyBackground(layer, style);
  return applyStyle(layer, style, { updateSource: false });
}
