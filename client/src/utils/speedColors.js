const stops = [
  { t: 0.0, r: 0x00, g: 0xc8, b: 0x53 },
  { t: 0.5, r: 0x29, g: 0x79, b: 0xff },
  { t: 1.0, r: 0xff, g: 0x1a, b: 0x00 },
];

export function speedToColor(ratio) {
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  const t = clamped * clamped;

  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }

  const f = hi.t === lo.t ? 0 : (t - lo.t) / (hi.t - lo.t);
  const r = Math.round(lo.r + f * (hi.r - lo.r));
  const g = Math.round(lo.g + f * (hi.g - lo.g));
  const b = Math.round(lo.b + f * (hi.b - lo.b));

  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
