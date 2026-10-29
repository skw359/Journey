import { memo, useMemo, useState } from 'react';
import TravelModeBadge from './TravelModeBadge';
import { useUnits } from '../context/UnitsContext';
import './JourneyCard.css';

// Memoized so a list re-renders only the cards whose props changed
export default memo(function JourneyCard({ route, active, onClick, variant, rank, note }) {
  const { convertDistance, distanceUnit } = useUnits();
  const distance = convertDistance(route.distance);
  const [failedPhoto, setFailedPhoto] = useState(null);
  const coverPhoto = route.coverPhoto && route.coverPhoto !== failedPhoto ? route.coverPhoto : null;

  const intermediate = useMemo(() => {
    const cp = route.citiesPassed;
    if (!Array.isArray(cp) || cp.length < 3) return [];
    const startCity = cp[0];
    const endCity = cp[cp.length - 1];
    return [...new Set(cp.filter(c => c !== startCity && c !== endCity))];
  }, [route.citiesPassed]);

  return (
    <div
      className={`route-card${active ? ' active' : ''}${coverPhoto ? ' has-photo' : ''}`}
      onClick={() => onClick(route.id)}
    >
      {coverPhoto && (
        <div className="route-card-media" aria-hidden="true">
          <img
            src={`/photos/thumb-480/${coverPhoto}`}
            alt=""
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            onError={() => setFailedPhoto(coverPhoto)}
          />
        </div>
      )}
      <div className="route-card-header">
        {rank != null && (
          <span className="rank-badge">{rank}</span>
        )}
        <h3>{route.name}</h3>
      </div>
      <p>
        {(distance ?? 0).toFixed(1)} {distanceUnit} {'\u2022'} {(route.duration || '').replace(/^0h /, '')}
      </p>
      <div style={{ marginTop: '8px' }}>
        <TravelModeBadge mode={route.travelMode || 'foot'} variant={variant} />
      </div>
      {note && <div className="route-card-note">{note}</div>}
      {intermediate.length > 0 && (
        <span className="cities-passed">
          Passed through {intermediate.length} {intermediate.length === 1 ? 'city' : 'cities'}
          <span className="cities-passed-tooltip">{intermediate.join(', ')}</span>
        </span>
      )}
    </div>
  );
});
