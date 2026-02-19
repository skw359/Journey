import { Footprints, Bike, Car } from 'lucide-react';
import './FilterBar.css';

const FILTERS = [
  { key: 'all', label: 'All', icon: null },
  { key: 'foot', label: 'Foot', icon: Footprints },
  { key: 'scooter', label: 'Scooter', icon: Bike },
  { key: 'drive', label: 'Drive', icon: Car },
];

export default function FilterBar({ active, onChange }) {
  return (
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
  );
}
