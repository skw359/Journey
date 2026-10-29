import { useEffect, useRef } from 'react';
import { useUnits } from '../context/UnitsContext';

const CANVAS_W = 520;
const CANVAS_H = 440;
const PAD = { top: 35, right: 70, bottom: 35, left: 55 };

const PLOT_W = CANVAS_W - PAD.left - PAD.right;
const PLOT_H = CANVAS_H - PAD.top - PAD.bottom;

// Map pressure to Y using log scale (standard for soundings)
function pressureToY(p, pTop, pBot) {
  const logP = Math.log(p);
  const logTop = Math.log(pTop);
  const logBot = Math.log(pBot);
  return PAD.top + ((logP - logTop) / (logBot - logTop)) * PLOT_H;
}

// Map temperature (F) to X
function tempToX(t, tMin, tMax) {
  return PAD.left + ((t - tMin) / (tMax - tMin)) * PLOT_W;
}

// Wind direction to arrow character
function windArrow(deg) {
  const arrows = ['\u2193', '\u2199', '\u2190', '\u2196', '\u2191', '\u2197', '\u2192', '\u2198'];
  return arrows[Math.round(deg / 45) % 8];
}

export default function SoundingChart({ data }) {
  const canvasRef = useRef(null);
  const { convertTemperature, convertSpeed, temperatureUnit, speedUnit } = useUnits();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data?.levels?.length) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width = `${CANVAS_W}px`;
    canvas.style.height = `${CANVAS_H}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const levels = data.levels;

    const pBot = Math.max(...levels.map(l => l.pressure));
    const pTop = Math.min(...levels.map(l => l.pressure));

    // Convert all temps for range calc
    const allTemps = levels.flatMap(l => {
      const vals = [convertTemperature(l.temp)];
      if (l.dewpoint != null) vals.push(convertTemperature(l.dewpoint));
      return vals;
    });
    const rawMin = Math.min(...allTemps);
    const rawMax = Math.max(...allTemps);
    const tPad = Math.max((rawMax - rawMin) * 0.15, 10);
    const tMin = Math.floor(rawMin - tPad);
    const tMax = Math.ceil(rawMax + tPad);

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const fg = isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)';
    const fgDim = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)';
    const bg = isDark ? '#1a1a2e' : '#f5f7fa';

    // Background
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Grid lines - pressure levels
    ctx.strokeStyle = fgDim;
    ctx.lineWidth = 0.5;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = fg;
    ctx.textAlign = 'right';

    const gridPressures = [1000, 925, 850, 700, 500, 300, 200];
    for (const p of gridPressures) {
      if (p > pBot || p < pTop) continue;
      const y = pressureToY(p, pTop, pBot);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + PLOT_W, y);
      ctx.stroke();
      ctx.fillText(`${p}`, PAD.left - 6, y + 3);
    }

    // Grid lines - temperature
    ctx.textAlign = 'center';
    const tStep = (tMax - tMin) > 80 ? 20 : 10;
    for (let t = Math.ceil(tMin / tStep) * tStep; t <= tMax; t += tStep) {
      const x = tempToX(t, tMin, tMax);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + PLOT_H);
      ctx.stroke();
      ctx.fillText(`${t}${temperatureUnit}`, x, PAD.top + PLOT_H + 14);
    }

    // Axis labels
    ctx.fillStyle = fg;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Temperature', PAD.left + PLOT_W / 2, CANVAS_H - 5);

    ctx.save();
    ctx.translate(13, PAD.top + PLOT_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Pressure (hPa)', 0, 0);
    ctx.restore();

    // Draw dewpoint line (green)
    const dpLevels = levels.filter(l => l.dewpoint != null);
    if (dpLevels.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = isDark ? '#4ecdc4' : '#2a9d8f';
      ctx.lineWidth = 2;
      dpLevels.forEach((l, i) => {
        const x = tempToX(convertTemperature(l.dewpoint), tMin, tMax);
        const y = pressureToY(l.pressure, pTop, pBot);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Draw temperature line (red)
    ctx.beginPath();
    ctx.strokeStyle = isDark ? '#ff6b6b' : '#e63946';
    ctx.lineWidth = 2.5;
    levels.forEach((l, i) => {
      const x = tempToX(convertTemperature(l.temp), tMin, tMax);
      const y = pressureToY(l.pressure, pTop, pBot);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw data points
    levels.forEach(l => {
      const x = tempToX(convertTemperature(l.temp), tMin, tMax);
      const y = pressureToY(l.pressure, pTop, pBot);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? '#ff6b6b' : '#e63946';
      ctx.fill();
    });

    dpLevels.forEach(l => {
      const x = tempToX(convertTemperature(l.dewpoint), tMin, tMax);
      const y = pressureToY(l.pressure, pTop, pBot);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? '#4ecdc4' : '#2a9d8f';
      ctx.fill();
    });

    // Wind barbs on right side
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    levels.forEach(l => {
      if (l.windSpeed == null || l.windDir == null) return;
      const y = pressureToY(l.pressure, pTop, pBot);
      const x = PAD.left + PLOT_W + 8;
      const ws = convertSpeed(l.windSpeed);
      const arrow = windArrow(l.windDir);
      ctx.fillStyle = fg;
      ctx.fillText(`${arrow} ${(ws ?? 0).toFixed(0)}`, x, y + 4);
    });

    // Wind column label
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = fg;
    ctx.textAlign = 'left';
    ctx.fillText(`Wind (${speedUnit})`, PAD.left + PLOT_W + 6, PAD.top - 8);

    // Legend
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const legendY = PAD.top - 18;

    ctx.strokeStyle = isDark ? '#ff6b6b' : '#e63946';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, legendY);
    ctx.lineTo(PAD.left + 18, legendY);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.fillText('Temp', PAD.left + 22, legendY + 3);

    ctx.strokeStyle = isDark ? '#4ecdc4' : '#2a9d8f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD.left + 58, legendY);
    ctx.lineTo(PAD.left + 76, legendY);
    ctx.stroke();
    ctx.fillText('Dewpoint', PAD.left + 80, legendY + 3);
  }, [data, convertTemperature, convertSpeed, temperatureUnit, speedUnit]);

  return <canvas ref={canvasRef} className="sounding-canvas" />;
}
