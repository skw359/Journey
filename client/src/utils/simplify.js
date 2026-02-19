function perpendicularDistance(point, lineStart, lineEnd) {
  const [px, py] = point;
  const [sx, sy] = lineStart;
  const [ex, ey] = lineEnd;

  const dx = ex - sx;
  const dy = ey - sy;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    const ddx = px - sx;
    const ddy = py - sy;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }

  const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lengthSq));
  const projX = sx + t * dx;
  const projY = sy + t * dy;
  const ddx = px - projX;
  const ddy = py - projY;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

export function douglasPeucker(points, tolerance) {
  if (points.length <= 2) {
    return { simplified: [...points], indices: points.map((_, i) => i) };
  }

  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIdx), tolerance);

    const simplified = [...left.simplified, ...right.simplified.slice(1)];
    const indices = [...left.indices, ...right.indices.slice(1).map(i => i + maxIdx)];
    return { simplified, indices };
  }

  return {
    simplified: [points[0], points[points.length - 1]],
    indices: [0, points.length - 1],
  };
}

export function getToleranceForZoom(zoom) {
  if (zoom >= 16) return null;
  if (zoom >= 14) return 0.0001;
  if (zoom >= 11) return 0.0003;
  return 0.001;
}

export function shouldShowHover(zoom) {
  return zoom >= 11;
}
