import Layer from 'ol/layer/Layer';
import VectorLayer from 'ol/layer/Vector';
import { Style, Stroke } from 'ol/style';
import { asArray } from 'ol/color';
import { getWidth } from 'ol/extent';
import { douglasPeucker } from 'ol/geom/flat/simplify';
import { getUid } from 'ol/util';
import { unByKey } from 'ol/Observable';

// Draws every journey of a vector source on the GPU.
//
// OL's canvas renderer re-strokes every line in view as one huge path on each
// frame of a pan or zoom, and over a dense area that takes the browser
// 50-125 ms per frame. OL's own WebGL vector layer avoids that, but rebuilds
// and re-uploads every line whenever the view stops moving, and draws every
// point of every line however far out the map is zoomed. This layer uploads
// each journey once, so moving the map only changes a few shader uniforms,
// and keeps coarser copies of the lines to draw when zoomed out.

// Map units per pixel at zoom 0 in Web Mercator.
const RESOLUTION_Z0 = 156543.03392804097;

// Each coarser copy is simplified (Douglas-Peucker, as OL's canvas renderer
// does on every redraw) to stay within half a pixel of the full line at the
// zoom listed here, and is only drawn at that zoom or further out, where it
// looks the same as the full line. Ordered finest to coarsest.
const LEVEL_ZOOMS = [16, 14, 12, 10, 8, 6, 4];
const LEVEL_TOLERANCES = [0, ...LEVEL_ZOOMS.map((z) => (0.5 * RESOLUTION_Z0) / 2 ** z)];
// Each copy is simplified from the next finer one rather than the full line,
// so their errors add up; each tolerance is 4x the last, so three quarters of
// each keeps the sum (3/4 * (1 + 1/4 + 1/16 + ...)) within the copy's own.
const SIMPLIFY_SHARE = 0.75;

// Rebuild a level from scratch once more than this share of its vertices
// belong to journeys that have since been replaced or removed.
const MAX_DEAD_SHARE = 0.5;
const MIN_CAPACITY = 1 << 16;
const COLOR_TEXTURE_WIDTH = 1024;
// Points the CPU-side staging area starts with, and keeps between uploads.
const STAGING_POINTS = 4096;
const STAGING_KEEP_POINTS = 1 << 15;

// Positions are split into a float32 high part and the remainder, and the
// view center likewise, so the shader can subtract them without the rounding
// error that would otherwise make lines wobble at street level: Web Mercator
// coordinates run to 2e7 m and a float32 alone only resolves those to ~1 m.
const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec4 a_start;
layout(location = 1) in vec4 a_end;
layout(location = 2) in float a_startId;
layout(location = 3) in float a_endId;

uniform vec4 u_center;
uniform vec2 u_rotation;
uniform float u_pixelsPerUnit;
uniform vec2 u_halfSize;
uniform float u_halfWidth;
uniform sampler2D u_colors;

flat out vec2 v_start;
flat out vec2 v_end;
flat out vec4 v_color;
out vec2 v_position;

// Device pixels from the view center, y up; ol's coordinateToPixelTransform.
vec2 toPixels(vec4 point) {
  vec2 d = (point.xy - u_center.xy) + (point.zw - u_center.zw);
  return vec2(
    u_rotation.x * d.x + u_rotation.y * d.y,
    u_rotation.x * d.y - u_rotation.y * d.x
  ) * u_pixelsPerUnit;
}

void main() {
  vec2 start = toPixels(a_start);
  vec2 end = toPixels(a_end);
  vec2 along = end - start;
  float len = length(along);
  // Instances also span the gap from one journey to the next and the points of
  // replaced journeys (id -1); those, and zero-length steps, draw nothing.
  if (a_startId != a_endId || a_startId < 0.0 || len == 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 dir = along / len;
  vec2 normal = vec2(-dir.y, dir.x);
  // A quad around the segment, a pixel wider than the line for the soft edge.
  float reach = u_halfWidth + 1.0;
  vec2 corner = (gl_VertexID < 2 ? start - dir * reach : end + dir * reach)
    + normal * (gl_VertexID % 2 == 0 ? -reach : reach);
  int id = int(a_startId);
  v_color = texelFetch(u_colors, ivec2(id % ${COLOR_TEXTURE_WIDTH}, id / ${COLOR_TEXTURE_WIDTH}), 0);
  v_start = start;
  v_end = end;
  v_position = corner;
  gl_Position = vec4(corner / u_halfSize, 0.0, 1.0);
}
`;

// Coverage from the distance to the segment gives each segment rounded ends,
// so consecutive segments meet in round joins with round caps at the ends,
// matching the canvas lines.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

flat in vec2 v_start;
flat in vec2 v_end;
flat in vec4 v_color;
in vec2 v_position;

uniform float u_halfWidth;

out vec4 fragColor;

void main() {
  vec2 toPoint = v_position - v_start;
  vec2 along = v_end - v_start;
  float t = clamp(dot(toPoint, along) / dot(along, along), 0.0, 1.0);
  float coverage = clamp(u_halfWidth + 0.5 - length(toPoint - along * t), 0.0, 1.0);
  if (coverage == 0.0) discard;
  fragColor = vec4(v_color.rgb, 1.0) * (v_color.a * coverage);
}
`;

const EMPTY_SPAN = { start: 0, count: 0 };

function compileProgram(gl) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`Journey line shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Journey line shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

// One level of detail: every journey's points at one tolerance, back to back,
// in a GPU buffer pair that only grows. Writes are staged on the CPU and sent
// in one go per frame.
class Level {
  constructor(tolerance) {
    this.tolerance = tolerance;
    this.used = 0;
    this.dead = 0;
    this.capacity = 0;
    this.positions = null;
    this.ids = null;
    this.vao = null;
    this.stagedPositions = new Float32Array(STAGING_POINTS * 4);
    this.stagedIds = new Float32Array(STAGING_POINTS);
    this.staged = 0;
  }

  // Loading every journey at once stages them all together; once they are on
  // the GPU, don't keep that much memory around for later, smaller updates.
  releaseStaging() {
    this.staged = 0;
    if (this.stagedIds.length <= STAGING_KEEP_POINTS) return;
    this.stagedPositions = new Float32Array(STAGING_POINTS * 4);
    this.stagedIds = new Float32Array(STAGING_POINTS);
  }

  // Appends a line's points to the staging area. Returns where they will land
  // in the buffer.
  stage(flat, stride, id) {
    const n = flat.length / stride;
    if (n < 2) return EMPTY_SPAN;
    this.reserve(this.staged + n);
    const positions = this.stagedPositions;
    const ids = this.stagedIds;
    let out = this.staged;
    for (let i = 0; i < flat.length; i += stride) {
      const x = flat[i];
      const y = flat[i + 1];
      const xHi = Math.fround(x);
      const yHi = Math.fround(y);
      const o = out * 4;
      positions[o] = xHi;
      positions[o + 1] = yHi;
      positions[o + 2] = x - xHi;
      positions[o + 3] = y - yHi;
      ids[out++] = id;
    }
    const span = { start: this.used + this.staged, count: out - this.staged };
    this.staged = out;
    return span;
  }

  reserve(vertices) {
    if (vertices <= this.stagedIds.length) return;
    const size = Math.max(vertices, this.stagedIds.length * 2);
    const positions = new Float32Array(size * 4);
    positions.set(this.stagedPositions.subarray(0, this.staged * 4));
    const ids = new Float32Array(size);
    ids.set(this.stagedIds.subarray(0, this.staged));
    this.stagedPositions = positions;
    this.stagedIds = ids;
  }
}

/**
 * Renders the LineString features of a vector source with WebGL2, coloured by
 * a feature property. Width and opacity can change without touching the
 * geometry. Has no hit detection of its own: test the source's geometry.
 */
class RouteLinesLayer extends Layer {
  /**
   * @param {Object} options
   * @param {import('ol/source/Vector').default} options.source
   * @param {WebGL2RenderingContext} options.gl Context of `options.canvas`.
   * @param {HTMLCanvasElement} options.canvas
   * @param {WebGLProgram} options.program From compileProgram(gl).
   * @param {number} [options.lineWidth=3] Width in CSS pixels.
   * @param {number} [options.opacity=1]
   * @param {string} [options.colorProperty='color'] Feature property holding a CSS color.
   * @param {string} [options.defaultColor='#02d87f'] For features without that property.
   */
  constructor({ source, gl, canvas, program, lineWidth = 3, opacity = 1, colorProperty = 'color', defaultColor = '#02d87f' }) {
    super({ source, opacity });
    this.gl_ = gl;
    this.canvas_ = canvas;
    this.lineWidth_ = lineWidth;
    this.colorProperty_ = colorProperty;
    this.defaultColor_ = defaultColor;

    this.container_ = document.createElement('div');
    this.container_.className = 'ol-layer atlas-route-lines';
    Object.assign(this.container_.style, { position: 'absolute', width: '100%', height: '100%', pointerEvents: 'none' });
    Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0' });
    this.container_.appendChild(canvas);

    this.levels_ = LEVEL_TOLERANCES.map((tolerance) => new Level(tolerance));
    // Features by uid in the order they were added, which is the draw order.
    this.entries_ = new Map();
    // Features to (re)write at the next render; null marks a removal.
    this.pending_ = new Map();
    this.cleared_ = false;
    this.colorsDirty_ = true;
    this.nextIndex_ = 0;

    this.initGl_(program);
    for (const feature of source.getFeatures()) this.pending_.set(getUid(feature), feature);
    this.sourceKeys_ = [
      source.on('addfeature', (e) => this.pending_.set(getUid(e.feature), e.feature)),
      source.on('changefeature', (e) => this.handleFeatureChange_(e.feature)),
      source.on('removefeature', (e) => this.pending_.set(getUid(e.feature), null)),
      source.on('clear', () => { this.cleared_ = true; this.pending_.clear(); }),
      // Colours are set silently and announced with one source.changed().
      source.on('change', () => { this.colorsDirty_ = true; }),
    ];

    this.onContextLost_ = (e) => e.preventDefault();
    this.onContextRestored_ = () => {
      this.initGl_(compileProgram(this.gl_));
      this.cleared_ = true;
      for (const feature of this.getSource().getFeatures()) this.pending_.set(getUid(feature), feature);
      this.changed();
    };
    canvas.addEventListener('webglcontextlost', this.onContextLost_);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored_);
  }

  /** @param {number} width Line width in CSS pixels. */
  setLineWidth(width) {
    if (width === this.lineWidth_) return;
    this.lineWidth_ = width;
    this.changed();
  }

  handleFeatureChange_(feature) {
    const uid = getUid(feature);
    const entry = this.entries_.get(uid);
    const geometry = feature.getGeometry();
    // Property changes re-colour; only a new or edited geometry is re-sent.
    if (entry && !this.pending_.has(uid) && entry.geometry === geometry && geometry?.getRevision() === entry.revision) {
      this.colorsDirty_ = true;
      return;
    }
    this.pending_.set(uid, feature);
  }

  // Sets up the GL objects; also after a lost context comes back, when every
  // earlier object is gone with it.
  initGl_(program) {
    const gl = this.gl_;
    this.program_ = program;
    this.uniforms_ = {};
    for (const name of ['u_center', 'u_rotation', 'u_pixelsPerUnit', 'u_halfSize', 'u_halfWidth', 'u_colors']) {
      this.uniforms_[name] = gl.getUniformLocation(this.program_, name);
    }
    this.colorTexture_ = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture_);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const level of this.levels_) {
      level.positions = null;
      level.ids = null;
      level.vao = null;
      level.capacity = 0;
      level.used = 0;
      level.dead = 0;
      level.staged = 0;
    }
  }

  // Points a level's vertex array at its buffers. Instance i draws the segment
  // from point i to point i + 1, so the "end" attributes read the same buffers
  // one point further on.
  bindLevel_(level) {
    const gl = this.gl_;
    if (!level.vao) level.vao = gl.createVertexArray();
    gl.bindVertexArray(level.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, level.positions);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, level.ids);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 4, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 4, 4);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  // Makes room for `vertices` points, copying what the level already holds
  // into the larger buffers on the GPU.
  growLevel_(level, vertices) {
    const gl = this.gl_;
    if (vertices <= level.capacity) return;
    const capacity = Math.max(vertices, Math.ceil(level.capacity * 1.5), MIN_CAPACITY);
    for (const [key, bytesPerVertex] of [['positions', 16], ['ids', 4]]) {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer);
      gl.bufferData(gl.COPY_WRITE_BUFFER, capacity * bytesPerVertex, gl.STATIC_DRAW);
      if (level[key]) {
        if (level.used) {
          gl.bindBuffer(gl.COPY_READ_BUFFER, level[key]);
          gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, level.used * bytesPerVertex);
        }
        gl.deleteBuffer(level[key]);
      }
      level[key] = buffer;
    }
    level.capacity = capacity;
    this.bindLevel_(level);
  }

  // Applies everything the source did since the last frame.
  flush_() {
    if (this.cleared_) {
      this.cleared_ = false;
      for (const level of this.levels_) {
        level.used = 0;
        level.dead = 0;
      }
      this.entries_.clear();
      this.nextIndex_ = 0;
      this.colorsDirty_ = true;
    }
    if (this.pending_.size) {
      const dead = this.levels_.map(() => []);
      for (const [uid, feature] of this.pending_) {
        let entry = this.entries_.get(uid);
        if (entry) {
          entry.spans.forEach((span, i) => { if (span.count) dead[i].push(span); });
          if (!feature) {
            this.entries_.delete(uid);
            continue;
          }
        } else if (feature) {
          entry = { feature, index: this.nextIndex_++, spans: [], geometry: null, revision: -1 };
          this.entries_.set(uid, entry);
        } else {
          continue;
        }
        this.stageEntry_(entry);
      }
      this.pending_.clear();
      this.colorsDirty_ = true;
      this.commit_(dead);
    }
    if (this.levels_.some((level) => level.used > MIN_CAPACITY && level.dead > level.used * MAX_DEAD_SHARE)) {
      this.rebuild_();
    }
    if (this.colorsDirty_) {
      this.colorsDirty_ = false;
      this.uploadColors_();
    }
  }

  stageEntry_(entry) {
    const geometry = entry.feature.getGeometry();
    entry.geometry = geometry;
    entry.revision = geometry ? geometry.getRevision() : -1;
    if (!geometry || geometry.getType() !== 'LineString') {
      entry.spans = this.levels_.map(() => EMPTY_SPAN);
      return;
    }
    let flat = geometry.getFlatCoordinates();
    let stride = geometry.getStride();
    entry.spans = this.levels_.map((level, i) => {
      if (i > 0) {
        const simplified = [];
        simplified.length = douglasPeucker(flat, 0, flat.length, stride, (SIMPLIFY_SHARE * level.tolerance) ** 2, simplified, 0);
        flat = simplified;
        stride = 2;
      }
      return level.stage(flat, stride, entry.index);
    });
  }

  // Sends staged points to the GPU and stops drawing the points of journeys
  // that were replaced or removed.
  commit_(deadByLevel) {
    const gl = this.gl_;
    this.levels_.forEach((level, i) => {
      if (level.staged) {
        this.growLevel_(level, level.used + level.staged);
        gl.bindBuffer(gl.ARRAY_BUFFER, level.positions);
        gl.bufferSubData(gl.ARRAY_BUFFER, level.used * 16, level.stagedPositions, 0, level.staged * 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, level.ids);
        gl.bufferSubData(gl.ARRAY_BUFFER, level.used * 4, level.stagedIds, 0, level.staged);
        level.used += level.staged;
        level.releaseStaging();
      }
      const dead = deadByLevel?.[i];
      if (!dead?.length) return;
      // Neighbouring journeys usually change together, so merge their runs.
      dead.sort((a, b) => a.start - b.start);
      gl.bindBuffer(gl.ARRAY_BUFFER, level.ids);
      let runStart = dead[0].start;
      let runEnd = runStart;
      const flushRun = () => {
        const count = runEnd - runStart;
        if (count) gl.bufferSubData(gl.ARRAY_BUFFER, runStart * 4, new Float32Array(count).fill(-1));
      };
      for (const span of dead) {
        if (span.start > runEnd) {
          flushRun();
          runStart = span.start;
        }
        runEnd = Math.max(runEnd, span.start + span.count);
        level.dead += span.count;
      }
      flushRun();
    });
  }

  // Rewrites every level from the live journeys alone, reclaiming the space
  // of replaced ones. Keeps their original draw order.
  rebuild_() {
    for (const level of this.levels_) {
      level.used = 0;
      level.dead = 0;
    }
    for (const entry of this.entries_.values()) this.stageEntry_(entry);
    this.commit_(null);
  }

  uploadColors_() {
    const gl = this.gl_;
    const height = Math.max(1, Math.ceil(this.nextIndex_ / COLOR_TEXTURE_WIDTH));
    const data = new Uint8Array(COLOR_TEXTURE_WIDTH * height * 4);
    for (const entry of this.entries_.values()) {
      const color = asArray(entry.feature.get(this.colorProperty_) || this.defaultColor_);
      const o = entry.index * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = Math.round((color[3] ?? 1) * 255);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture_);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, COLOR_TEXTURE_WIDTH, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  // The coarsest level still within half a device pixel of the full lines.
  pickLevel_(resolution, pixelRatio) {
    const allowed = (0.5 * resolution) / pixelRatio;
    for (let i = this.levels_.length - 1; i > 0; i--) {
      if (this.levels_[i].tolerance <= allowed) return this.levels_[i];
    }
    return this.levels_[0];
  }

  /**
   * @param {import('ol/Map').FrameState} frameState
   * @return {HTMLElement}
   * @override
   */
  render(frameState) {
    const gl = this.gl_;
    const canvas = this.canvas_;
    const layerState = frameState.layerStatesArray[frameState.layerIndex];
    this.container_.style.opacity = String(layerState.opacity);
    if (gl.isContextLost()) return this.container_;

    this.flush_();

    const [cssWidth, cssHeight] = frameState.size;
    const pixelRatio = frameState.pixelRatio;
    const width = Math.round(cssWidth * pixelRatio);
    const height = Math.round(cssHeight * pixelRatio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const { center, resolution, rotation, projection } = frameState.viewState;
    const level = this.pickLevel_(resolution, pixelRatio);
    if (level.used < 2) return this.container_;

    const u = this.uniforms_;
    gl.useProgram(this.program_);
    gl.uniform2f(u.u_rotation, Math.cos(rotation), Math.sin(rotation));
    gl.uniform1f(u.u_pixelsPerUnit, pixelRatio / resolution);
    gl.uniform2f(u.u_halfSize, width / 2, height / 2);
    gl.uniform1f(u.u_halfWidth, (this.lineWidth_ * pixelRatio) / 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture_);
    gl.uniform1i(u.u_colors, 0);
    gl.bindVertexArray(level.vao);

    // Like the canvas renderer, repeat the journeys on every copy of the world
    // in view. Shifting the center (in float64, here) keeps the shader's
    // numbers small.
    if (projection.canWrapX() && this.getSource().getWrapX()) {
      const projectionExtent = projection.getExtent();
      const worldWidth = getWidth(projectionExtent);
      const firstWorld = Math.floor((frameState.extent[0] - projectionExtent[0]) / worldWidth);
      const lastWorld = Math.floor((frameState.extent[2] - projectionExtent[0]) / worldWidth);
      for (let world = firstWorld; world <= lastWorld; world++) {
        this.drawWorld_(level, center[0] - world * worldWidth, center[1]);
      }
    } else {
      this.drawWorld_(level, center[0], center[1]);
    }
    gl.bindVertexArray(null);
    return this.container_;
  }

  drawWorld_(level, x, y) {
    const gl = this.gl_;
    const xHi = Math.fround(x);
    const yHi = Math.fround(y);
    gl.uniform4f(this.uniforms_.u_center, xHi, yHi, x - xHi, y - yHi);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, level.used - 1);
  }

  /** @override */
  disposeInternal() {
    unByKey(this.sourceKeys_);
    const gl = this.gl_;
    this.canvas_.removeEventListener('webglcontextlost', this.onContextLost_);
    this.canvas_.removeEventListener('webglcontextrestored', this.onContextRestored_);
    if (!gl.isContextLost()) {
      for (const level of this.levels_) {
        gl.deleteBuffer(level.positions);
        gl.deleteBuffer(level.ids);
        gl.deleteVertexArray(level.vao);
      }
      gl.deleteTexture(this.colorTexture_);
      gl.deleteProgram(this.program_);
    }
    // Browsers cap how many contexts can be alive at once; free this one now
    // rather than whenever the canvas is garbage collected.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    super.disposeInternal();
  }
}

// Where WebGL2 is unavailable, the canvas renderer the GPU layer replaced.
function createCanvasRouteLayer({ source, lineWidth = 3, opacity = 1, colorProperty = 'color', defaultColor = '#02d87f' }) {
  let width = lineWidth;
  // ol calls the style fn once per feature per layer re-render, so cache by the
  // only inputs that vary instead of allocating two objects per route per redraw.
  const styleCache = new Map();
  const layer = new VectorLayer({
    source,
    opacity,
    style: (feature) => {
      const color = feature.get(colorProperty) || defaultColor;
      const key = `${color}|${width}`;
      let style = styleCache.get(key);
      if (!style) {
        style = new Style({ stroke: new Stroke({ color, width }) });
        styleCache.set(key, style);
      }
      return style;
    },
  });
  layer.setLineWidth = (next) => {
    if (next === width) return;
    width = next;
    layer.changed();
  };
  return layer;
}

/**
 * A layer drawing the LineString features of `source`, on the GPU when the
 * browser supports WebGL2 and with OL's canvas renderer otherwise. Either way
 * it has `setLineWidth(width)`, and is released with `dispose()`.
 *
 * @param {Object} options
 * @param {import('ol/source/Vector').default} options.source
 * @param {number} [options.lineWidth=3] Width in CSS pixels.
 * @param {number} [options.opacity=1]
 * @param {string} [options.colorProperty='color'] Feature property holding a CSS color.
 * @param {string} [options.defaultColor='#02d87f'] For features without that property.
 * @return {import('ol/layer/Layer').default & { setLineWidth: (width: number) => void }}
 */
export function createRouteLinesLayer(options) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (gl) {
    try {
      return new RouteLinesLayer({ ...options, gl, canvas, program: compileProgram(gl) });
    } catch (err) {
      console.error(err);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
  return createCanvasRouteLayer(options);
}
