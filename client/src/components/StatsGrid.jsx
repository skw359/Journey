import { mToFt } from '../utils/formatters';
import './StatsGrid.css';

export default function StatsGrid({ route }) {
  if (!route) return null;

  return (
    <div className="stats-section">
      <div className="primary-stat">
        <h3>Distance</h3>
        <p>
          {parseFloat(route.distance).toFixed(1)}
          <span className="unit">mi</span>
        </p>
      </div>
      <div className="stats-grid">
        <div className="stat-card">
          <h3>Duration</h3>
          <p>{route.duration.replace(/^0h /, '')}</p>
        </div>
        <div className="stat-card">
          <h3>Avg. Speed</h3>
          <p>
            {parseFloat(route.avgSpeed).toFixed(0)}
            <span className="unit">mph</span>
          </p>
        </div>
        <div className="stat-card">
          <h3>Top Speed</h3>
          <p>
            {parseFloat(route.topSpeed).toFixed(0)}
            <span className="unit">mph</span>
          </p>
        </div>
        <div className="stat-card">
          <h3>Top Elevation</h3>
          <p>
            {route.topElevation
              ? Math.round(mToFt(route.topElevation))
              : '--'}
            <span className="unit">ft</span>
          </p>
        </div>
      </div>
    </div>
  );
}
