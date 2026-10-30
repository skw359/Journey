// Heatmap cell weights in 0..1: log-scaled visit counts, normalized to the 95th percentile
// of the cells in view, so a few very busy cells don't wash out the rest and most cells
// don't all saturate at the maximum.
export function heatmapWeights(counts) {
  if (counts.length === 0) return [];
  const sorted = [...counts].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))];
  const top = Math.log1p(Math.max(p95, 1));
  return counts.map((count) => Math.min(1, Math.log1p(Math.max(count, 0)) / top));
}
