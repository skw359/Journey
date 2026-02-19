import TravelModeBadge from './TravelModeBadge';
import './JourneyCard.css';

export default function JourneyCard({ route, active, onClick, variant, rank }) {
  return (
    <div
      className={`route-card${active ? ' active' : ''}`}
      onClick={() => onClick(route.id)}
    >
      <div className="route-card-header">
        {rank != null && (
          <span className={`rank-badge ${rank <= 3 ? `medal-${rank}` : ''}`}>
            {rank <= 3 ? ['', '\u{1F947}', '\u{1F948}', '\u{1F949}'][rank] : `#${rank}`}
          </span>
        )}
        <h3>{route.name}</h3>
      </div>
      <p>
        {parseFloat(route.distance).toFixed(1)} mi {'\u2022'} {route.duration.replace(/^0h /, '')}
      </p>
      <div style={{ marginTop: '8px' }}>
        <TravelModeBadge mode={route.travelMode || 'foot'} variant={variant} />
      </div>
    </div>
  );
}
