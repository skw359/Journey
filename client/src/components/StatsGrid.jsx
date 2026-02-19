import { useUnits } from '../context/UnitsContext';
import './StatsGrid.css';

export default function StatsGrid({ route }) {
  const { convertDistance, convertSpeed, convertElevation, distanceUnit, speedUnit, elevationUnit } = useUnits();
  if (!route) return null;

  const distance = convertDistance(route.distance);
  const avgSpeed = convertSpeed(route.avgSpeed);
  const topSpeed = convertSpeed(route.topSpeed);
  const topElevation = convertElevation(route.topElevation);

  return (
    <div className="stats-section">
      <div className="primary-stat">
        <h3>Distance</h3>
        <p>
          {distance != null ? distance.toFixed(1) : '--'}
          <span className="unit">{distanceUnit}</span>
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
            {avgSpeed != null ? avgSpeed.toFixed(0) : '--'}
            <span className="unit">{speedUnit}</span>
          </p>
        </div>
        <div className="stat-card">
          <h3>Top Speed</h3>
          <p>
            {topSpeed != null ? topSpeed.toFixed(0) : '--'}
            <span className="unit">{speedUnit}</span>
          </p>
        </div>
        <div className="stat-card">
          <h3>Top Elevation</h3>
          <p>
            {topElevation != null ? Math.round(topElevation) : '--'}
            <span className="unit">{elevationUnit}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
