// Draws the vector basemap off the main thread. The page posts the view of
// each map frame; this renders it with the same OpenLayers layer the page
// would use, into an OffscreenCanvas, and posts the result back as a bitmap.
// Label placement, tile decoding and tile drawing all happen here instead of
// blocking the page.
import TileQueue, { getTilePriority } from 'ol/TileQueue';
import ViewHint from 'ol/ViewHint';
import { inView } from 'ol/layer/Layer';
import { get as getProjection } from 'ol/proj';
import { createVectorBasemapLayer, applyVectorBasemapTheme } from './basemapStyle';

// The labels' family and weights (App.css loads the same family for the page).
// A worker can't use the page's fonts, so it loads its own copies.
const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600&display=swap';
// Past this, draw with whatever font is available rather than show nothing.
const FONT_WAIT_MS = 3000;

// ~60 frames a second is all the page can show.
const MIN_FRAME_INTERVAL_MS = 16;
// Parallel tile loads, as OpenLayers' own map allows.
const MAX_TILES_LOADING = 16;

const projection = getProjection('EPSG:3857');

// Draw tile images on this thread's CPU. On the GPU, filling thousands of
// paths competes with the page's own canvases for the browser's GPU process
// and stalls the main thread for hundreds of ms. OpenLayers creates tile
// canvases at 1x1; the frame they're composited into stays on the GPU, so
// handing it to the page stays cheap.
const getContext = OffscreenCanvas.prototype.getContext;
OffscreenCanvas.prototype.getContext = function (type, options) {
  if (type === '2d' && this.width === 1 && this.height === 1) {
    options = { ...options, willReadFrequently: true };
  }
  return getContext.call(this, type, options);
};

let layer = null;
let view = null; // latest view from the page
let frameState = null; // last frame rendered; the tile queue ranks tiles by it
let frameIndex = 0;
let fontsReady = false;
let dirty = false;
let timer = null;
let lastFrameAt = -Infinity;

const tileQueue = new TileQueue(
  (tile, sourceKey, center, resolution) => getTilePriority(frameState, tile, sourceKey, center, resolution),
  () => requestFrame(),
);

function fail(error) {
  self.postMessage({ type: 'failed', reason: String(error?.stack || error) });
  self.close();
}

function requestFrame() {
  dirty = true;
  if (timer !== null) return;
  const wait = Math.max(0, lastFrameAt + MIN_FRAME_INTERVAL_MS - performance.now());
  timer = setTimeout(renderFrame, wait);
}

function loadTiles() {
  if (tileQueue.isEmpty()) return;
  const hints = frameState.viewHints;
  const moving = hints[ViewHint.ANIMATING] || hints[ViewHint.INTERACTING];
  // While the view moves, load fewer tiles at once, nearest first.
  const maxTotal = moving ? 8 : MAX_TILES_LOADING;
  const maxNew = moving ? 2 : maxTotal;
  if (tileQueue.getTilesLoading() < maxTotal) {
    if (moving) tileQueue.reprioritize();
    tileQueue.loadMoreTiles(maxTotal, maxNew);
  }
}

// One map frame, done the way OpenLayers' own map renderer does it.
function renderFrame() {
  timer = null;
  if (!dirty || !view || !layer || !fontsReady) return;
  dirty = false;
  lastFrameAt = performance.now();
  try {
    frameState = {
      ...view,
      viewState: { ...view.viewState, projection },
      animate: false,
      declutter: layer.getDeclutter() ? {} : null,
      index: frameIndex++,
      layerIndex: 0,
      layerStatesArray: [layer.getLayerState()],
      mapId: 'basemap',
      postRenderFunctions: [],
      renderTargets: {},
      tileQueue,
      time: Date.now(),
      usedTiles: {},
      wantedTiles: {},
    };
    const layerState = frameState.layerStatesArray[0];
    const sourceState = layer.getSourceState();
    let element = null;
    if (inView(layerState, frameState.viewState) && (sourceState === 'ready' || sourceState === 'undefined')) {
      element = layer.render(frameState, null);
      if (element && frameState.declutter) {
        layer.renderDeclutter(frameState, layerState);
        layer.renderDeferred(frameState);
      }
    } else {
      layer.unrender();
    }
    frameState.postRenderFunctions.forEach((fn) => fn(null, frameState));
    loadTiles();
    if (frameState.animate) requestFrame();

    const { viewState, size } = frameState;
    const rendered = { center: viewState.center, resolution: viewState.resolution, rotation: viewState.rotation, size };
    const canvas = element && (element.firstElementChild || element);
    if (!canvas) {
      self.postMessage({ type: 'frame', bitmap: null, view: rendered });
      return;
    }
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({
      type: 'frame',
      bitmap,
      transform: canvas.style.transform || '',
      background: element.style.backgroundColor || '',
      view: rendered,
    }, [bitmap]);
  } catch (error) {
    fail(error);
  }
}

async function loadFonts() {
  const css = await (await fetch(FONT_CSS_URL)).text();
  const loads = [];
  for (const [, block] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const prop = (name) => block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim();
    const family = prop('font-family')?.replace(/['"]/g, '');
    const src = prop('src');
    if (!family || !src) continue;
    const face = new FontFace(family, src, {
      style: prop('font-style') || 'normal',
      weight: prop('font-weight') || '400',
      unicodeRange: prop('unicode-range') || 'U+0-10FFFF',
    });
    self.fonts.add(face);
    loads.push(face.load());
  }
  await Promise.all(loads);
}

function startFonts() {
  if (typeof FontFace === 'undefined' || !self.fonts) {
    throw new Error('this browser cannot load fonts in a worker');
  }
  const settle = () => {
    if (fontsReady) return;
    fontsReady = true;
    requestFrame();
  };
  const timeout = setTimeout(settle, FONT_WAIT_MS);
  loadFonts().then(() => {
    clearTimeout(timeout);
    // Labels drawn before the fonts arrived used a stand-in; draw them again.
    if (fontsReady) layer?.changed();
    settle();
  }, () => {
    clearTimeout(timeout);
    // The page decides whether its own copy of the font makes this worth avoiding.
    self.postMessage({ type: 'fontsUnavailable' });
    settle();
  });
}

function init(theme) {
  startFonts();
  layer = createVectorBasemapLayer(theme);
  // Style, background and source readiness all arrive as layer changes.
  layer.on('change', requestFrame);
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'view') {
      view = data.view;
      requestFrame();
    } else if (data.type === 'theme') {
      applyVectorBasemapTheme(layer, data.theme);
    } else if (data.type === 'init') {
      init(data.theme);
    }
  } catch (error) {
    fail(error);
  }
};
