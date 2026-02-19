import { useMemo, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useTheme } from '../context/ThemeContext';
import { useUnits } from '../context/UnitsContext';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, zoomPlugin);

export default function ElevationChart({ route, onPointClick }) {
  const { chartColors } = useTheme();
  const { convertDistance, convertElevation, distanceUnit, elevationUnit } = useUnits();
  const chartRef = useRef(null);

  const { data, options } = useMemo(() => {
    if (!route?.profileDistMi || !route?.profileElevM) return { data: null, options: null };

    const data = {
      labels: route.profileDistMi.map((distance) => {
        const converted = convertDistance(distance);
        return (converted ?? 0).toFixed(1);
      }),
      datasets: [{
        label: `Elevation (${elevationUnit})`,
        data: route.profileElevM.map((elevation) => {
          if (elevation == null) return null;
          return convertElevation(elevation);
        }),
        borderColor: '#02d87f',
        backgroundColor: 'rgba(2, 216, 127, 0.1)',
        fill: true,
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
            label: (ctx) => `${Math.round(ctx.parsed.y)} ${elevationUnit}`,
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
        x: { title: { display: true, text: `Distance (${distanceUnit})`, color: chartColors.color }, grid: { color: chartColors.grid } },
        y: { title: { display: true, text: `Elevation (${elevationUnit})`, color: chartColors.color }, grid: { color: chartColors.grid } },
      },
    };

    return { data, options };
  }, [chartColors, convertDistance, convertElevation, distanceUnit, elevationUnit, onPointClick, route]);

  if (!data) return null;

  return (
    <div className="graph-container">
      <div className="graph-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Elevation Profile</h3>
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
