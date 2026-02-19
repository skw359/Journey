import { useMemo, useState, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useTheme } from '../context/ThemeContext';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, zoomPlugin);

export default function SpeedChart({ route, onPointClick }) {
  const { chartColors } = useTheme();
  const [mode, setMode] = useState('time');
  const chartRef = useRef(null);

  const timeMinutes = useMemo(() => {
    if (!route?.profileTimeMs) return [];
    const start = route.profileTimeMs[0];
    return route.profileTimeMs.map(t => (t - start) / 60000);
  }, [route]);

  const { data, options } = useMemo(() => {
    if (!route?.profileSpeedMph) return { data: null, options: null };

    const isTimeMode = mode === 'time';
    const labels = isTimeMode
      ? timeMinutes.map(t => t.toFixed(1))
      : route.profileDistMi.map(d => d.toFixed(1));
    const xAxisLabel = isTimeMode ? 'Time (minutes)' : 'Distance (miles)';

    const data = {
      labels,
      datasets: [{
        label: 'Speed (mph)',
        data: route.profileSpeedMph,
        borderColor: '#4A90E2',
        backgroundColor: 'rgba(74, 144, 226, 0.1)',
        fill: false,
        tension: 0.2,
        pointRadius: 0,
      }],
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (e, elements) => {
        if (elements?.length > 0) onPointClick?.(elements[0].index, route);
      },
      onHover: (event, chartElement) => {
        event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (ctx) => {
              const idx = ctx[0].dataIndex;
              return isTimeMode
                ? `Time: ${timeMinutes[idx].toFixed(1)} min`
                : `Distance: ${route.profileDistMi[idx].toFixed(2)} mi`;
            },
            label: (ctx) => `Speed: ${ctx.parsed.y.toFixed(1)} mph`,
            footer: () => 'Click to delete this point',
          },
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x',
          },
          zoom: {
            wheel: {
              enabled: true,
            },
            pinch: {
              enabled: true
            },
            mode: 'x',
          }
        }
      },
      scales: {
        x: { title: { display: true, text: xAxisLabel, color: chartColors.color }, grid: { color: chartColors.grid } },
        y: { title: { display: true, text: 'Speed (mph)', color: chartColors.color }, grid: { color: chartColors.grid } },
      },
    };

    return { data, options };
  }, [route, mode, chartColors, timeMinutes, onPointClick]);

  if (!data) return null;

  return (
    <div className="graph-container">
      <div className="graph-header">
        <h3>Speed Profile</h3>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button 
            onClick={() => chartRef.current?.resetZoom()}
            className="reset-zoom-btn"
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'var(--text-primary)',
              padding: '4px 8px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.8rem',
              transition: 'background 0.2s'
            }}
            onMouseOver={(e) => e.target.style.background = 'rgba(255,255,255,0.2)'}
            onMouseOut={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
          >
            Reset Zoom
          </button>
          <div className="graph-toggle">
            <button
              className={`graph-toggle-btn${mode === 'time' ? ' active' : ''}`}
              onClick={() => setMode('time')}
            >
              Over Time
            </button>
            <button
              className={`graph-toggle-btn${mode === 'distance' ? ' active' : ''}`}
              onClick={() => setMode('distance')}
            >
              Over Distance
            </button>
          </div>
        </div>
      </div>
      <div className="graph-canvas-wrapper">
        <Line ref={chartRef} data={data} options={options} />
      </div>
    </div>
  );
}
