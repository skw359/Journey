import { useMemo, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useTheme } from '../context/ThemeContext';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, zoomPlugin);

export default function AccelerationChart({ route, onPointClick }) {
  const { chartColors } = useTheme();
  const chartRef = useRef(null);

  const { data, options } = useMemo(() => {
    if (!route?.profileSpeedMph || !route?.profileTimeMs) return { data: null, options: null };

    const startTime = route.profileTimeMs[0];
    const timeMinutes = route.profileTimeMs.map(t => (t - startTime) / 60000);

    const accelerationData = [];
    for (let i = 1; i < route.profileSpeedMph.length; i++) {
      const dSpeed = (route.profileSpeedMph[i] - route.profileSpeedMph[i - 1]) * 0.44704;
      const dTime = (route.profileTimeMs[i] - route.profileTimeMs[i - 1]) / 1000;
      if (dTime > 0) {
        accelerationData.push((dSpeed / dTime) * 3.28084);
      } else {
        accelerationData.push(0);
      }
    }

    const data = {
      labels: timeMinutes.slice(1).map(t => t.toFixed(1)),
      datasets: [{
        label: 'Acceleration (ft/s\u00B2)',
        data: accelerationData,
        borderColor: '#FF6B6B',
        backgroundColor: 'rgba(255, 107, 107, 0.1)',
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
        if (elements?.length > 0) onPointClick?.(elements[0].index + 1, route);
      },
      onHover: (event, chartElement) => {
        event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.parsed.y.toFixed(2)} ft/s\u00B2`,
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
        x: { title: { display: true, text: 'Time (minutes)', color: chartColors.color }, grid: { color: chartColors.grid } },
        y: { title: { display: true, text: 'Acceleration (ft/s\u00B2)', color: chartColors.color }, grid: { color: chartColors.grid } },
      },
    };

    return { data, options };
  }, [route, chartColors, onPointClick]);

  if (!data) return null;

  return (
    <div className="graph-container">
      <div className="graph-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Acceleration</h3>
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
      </div>
      <div className="graph-canvas-wrapper">
        <Line ref={chartRef} data={data} options={options} />
      </div>
    </div>
  );
}
