import Layer from 'ol/layer/Layer';
import Source from 'ol/source/Source';
import { unByKey } from 'ol/Observable';
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_PROPERTY,
  basemapBackground,
  createVectorBasemapLayer,
  applyVectorBasemapTheme,
} from './basemapStyle';
import BasemapWorker from './basemap.worker.js?worker';

// The basemap is drawn in a worker (basemap.worker.js) so that placing labels
// and drawing tiles never blocks panning, zooming or the rest of the page.
// Browsers without OffscreenCanvas, or a worker that fails, get the same layer
// drawn on the main thread instead.

function workerRenderingSupported() {
  try {
    return typeof Worker !== 'undefined'
      && typeof ImageBitmapRenderingContext !== 'undefined'
      && typeof OffscreenCanvas !== 'undefined'
      && typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function'
      && !!new OffscreenCanvas(1, 1).getContext('2d');
  } catch {
    return false;
  }
}

// Once a worker has failed, later maps go straight to the main thread.
let useWorker = workerRenderingSupported();

export function createBasemapLayer(theme) {
  return useWorker ? new WorkerBasemapLayer(theme) : createVectorBasemapLayer(theme);
}

export function applyBasemapTheme(layer, theme) {
  if (layer instanceof WorkerBasemapLayer) {
    layer.setTheme(theme);
    return Promise.resolve();
  }
  return applyVectorBasemapTheme(layer, theme);
}

export function isBasemapLayer(layer) {
  return layer.get(BASEMAP_PROPERTY) === true;
}

class WorkerBasemapLayer extends Layer {
  constructor(theme) {
    super({
      source: new Source({ attributions: BASEMAP_ATTRIBUTION }),
      properties: { [BASEMAP_PROPERTY]: true },
    });
    this.theme_ = theme;
    this.worker_ = null;
    this.fallback_ = null;
    this.mapTargetKey_ = null;
    this.lastViewKey_ = '';
    // The view the map is showing now, and the view the current bitmap was drawn for.
    this.currentView_ = null;
    this.renderedView_ = null;

    // Not "ol-layer", so the layers above never try to draw into this canvas.
    this.container_ = document.createElement('div');
    this.container_.className = 'ol-layer-basemap';
    Object.assign(this.container_.style, {
      position: 'absolute',
      width: '100%',
      height: '100%',
      backgroundColor: basemapBackground(theme),
    });
    this.transformContainer_ = document.createElement('div');
    Object.assign(this.transformContainer_.style, {
      position: 'absolute',
      width: '100%',
      height: '100%',
      transformOrigin: '0 0',
    });
    this.canvas_ = document.createElement('canvas');
    Object.assign(this.canvas_.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: 'top left',
      display: 'none',
    });
    this.bitmapContext_ = this.canvas_.getContext('bitmaprenderer');
    this.transformContainer_.appendChild(this.canvas_);
    this.container_.appendChild(this.transformContainer_);

    // The worker lives as long as the map has a target; every map here is
    // torn down with setTarget(null).
    this.on('change:map', () => {
      unByKey(this.mapTargetKey_);
      this.mapTargetKey_ = null;
      const map = this.getMapInternal();
      if (!map) {
        this.stopWorker_();
        return;
      }
      this.mapTargetKey_ = map.on('change:target', () => {
        if (!map.getTargetElement()) this.stopWorker_();
      });
    });
  }

  setTheme(theme) {
    this.theme_ = theme;
    if (this.fallback_) applyVectorBasemapTheme(this.fallback_, theme);
    else this.worker_?.postMessage({ type: 'theme', theme });
  }

  render(frameState) {
    if (this.fallback_) return null;
    if (!this.worker_) this.startWorker_();

    const viewState = frameState.viewState;
    this.currentView_ = {
      center: viewState.center.slice(),
      resolution: viewState.resolution,
      rotation: viewState.rotation,
      size: frameState.size.slice(),
    };
    // Until the worker catches up, move the last bitmap to where the map is now.
    this.updateTransform_();
    this.postView_(frameState);
    return this.container_;
  }

  postView_(frameState) {
    const viewState = frameState.viewState;
    const view = {
      viewState: {
        center: viewState.center.slice(),
        resolution: viewState.resolution,
        rotation: viewState.rotation,
        zoom: viewState.zoom,
        nextCenter: viewState.nextCenter?.slice(),
        nextResolution: viewState.nextResolution,
        nextRotation: viewState.nextRotation,
      },
      extent: frameState.extent.slice(),
      nextExtent: frameState.nextExtent?.slice(),
      size: frameState.size.slice(),
      pixelRatio: frameState.pixelRatio,
      viewHints: frameState.viewHints.slice(),
      coordinateToPixelTransform: frameState.coordinateToPixelTransform.slice(),
      pixelToCoordinateTransform: frameState.pixelToCoordinateTransform.slice(),
    };
    // The map also re-renders for changes in the layers above; skip those.
    const key = JSON.stringify(view);
    if (key === this.lastViewKey_) return;
    this.lastViewKey_ = key;
    this.worker_?.postMessage({ type: 'view', view });
  }

  startWorker_() {
    let worker;
    try {
      worker = new BasemapWorker();
    } catch (error) {
      this.fallBack_(error);
      return;
    }
    worker.onmessage = ({ data }) => this.handleMessage_(data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.fallBack_(event.message || 'worker error');
    };
    worker.postMessage({ type: 'init', theme: this.theme_ });
    this.worker_ = worker;
    this.lastViewKey_ = '';
  }

  stopWorker_() {
    this.worker_?.terminate();
    this.worker_ = null;
    this.renderedView_ = null;
    this.canvas_.style.display = 'none';
  }

  handleMessage_(data) {
    if (data.type === 'frame') {
      this.showFrame_(data);
    } else if (data.type === 'failed') {
      this.fallBack_(data.reason);
    } else if (data.type === 'fontsUnavailable') {
      // Only worth giving up the worker if the page itself has the label font.
      document.fonts.load('500 12px Montserrat').then((faces) => {
        if (faces.length) this.fallBack_('the worker could not load the label font');
      }, () => {});
    }
  }

  showFrame_({ bitmap, transform, background, view }) {
    if (!bitmap) {
      this.canvas_.style.display = 'none';
      this.renderedView_ = null;
      return;
    }
    const canvas = this.canvas_;
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    this.bitmapContext_.transferFromImageBitmap(bitmap);
    canvas.style.transform = transform;
    canvas.style.display = '';
    if (background) this.container_.style.backgroundColor = background;
    this.renderedView_ = view;
    this.updateTransform_();
  }

  // Maps the bitmap, drawn for renderedView_, onto the map as it is now.
  updateTransform_() {
    const now = this.currentView_;
    const then = this.renderedView_;
    if (!now || !then) return;
    const scale = then.resolution / now.resolution;
    const turn = now.rotation - then.rotation;
    const a = scale * Math.cos(turn);
    const b = scale * Math.sin(turn);
    // Where the bitmap's centre now sits, relative to the map's centre, in pixels.
    const dx = then.center[0] - now.center[0];
    const dy = then.center[1] - now.center[1];
    const cos = Math.cos(now.rotation);
    const sin = Math.sin(now.rotation);
    const cx = now.size[0] / 2 + (dx * cos + dy * sin) / now.resolution;
    const cy = now.size[1] / 2 + (dx * sin - dy * cos) / now.resolution;
    const hx = then.size[0] / 2;
    const hy = then.size[1] / 2;
    const e = cx - (a * hx - b * hy);
    const f = cy - (b * hx + a * hy);
    this.transformContainer_.style.transform = `matrix(${a}, ${b}, ${-b}, ${a}, ${e}, ${f})`;
  }

  fallBack_(reason) {
    if (this.fallback_) return;
    console.warn('[basemap] drawing the basemap on the main thread instead of a worker:', reason);
    useWorker = false;
    this.stopWorker_();
    const fallback = createVectorBasemapLayer(this.theme_);
    this.fallback_ = fallback;
    // Not mid-render: this can be reached from render().
    queueMicrotask(() => {
      const layers = this.getMapInternal()?.getLayers();
      const index = layers ? layers.getArray().indexOf(this) : -1;
      if (index >= 0) layers.setAt(index, fallback);
    });
  }

  disposeInternal() {
    unByKey(this.mapTargetKey_);
    this.stopWorker_();
    super.disposeInternal();
  }
}
