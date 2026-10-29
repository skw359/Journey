import { useState } from 'react';
import { Footprints, Bike, Car, Plane, TrainFront, TrainFrontTunnel, ChevronDown, ChevronRight, Filter } from 'lucide-react';
import './FilterBar.css';

const FILTERS = [
  { key: 'all', label: 'All', icon: null },
  { key: 'foot', label: 'Foot', icon: Footprints },
  { key: 'scooter', label: 'Scooter', icon: Bike },
  { key: 'drive', label: 'Drive', icon: Car },
  { key: 'train', label: 'Train', icon: TrainFront },
  { key: 'metro', label: 'Metro', icon: TrainFrontTunnel },
  { key: 'flight', label: 'Flight', icon: Plane },
];

export default function FilterBar({ active, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const activeFilter = FILTERS.find(f => f.key === active) || FILTERS[0];
  const ActiveIcon = activeFilter.icon;

  return (
    <div className={`filter-bar-wrap${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="filter-toggle"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <Filter size={14} />
        <span className="filter-toggle-label">
          Filter: {ActiveIcon && <ActiveIcon size={12} />} {activeFilter.label}
        </span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className="filter-bar">
          {FILTERS.map(f => (
            <button
              key={f.key}
              className={`filter-btn ${f.key}${active === f.key ? ' active' : ''}`}
              onClick={() => onChange(f.key)}
            >
              {f.icon && <f.icon size={14} />}
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
