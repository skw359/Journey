import { Circle } from 'lucide-react';
import { MODE_CONFIG, getTravelModeLabel } from '../utils/travelModes';
import './TravelModeBadge.css';

export function TravelModeIcon({ mode, ...props }) {
  const Icon = MODE_CONFIG[mode]?.icon || Circle;
  return <Icon {...props} />;
}

export default function TravelModeBadge({ mode, clickable, onClick, variant }) {
  const config = MODE_CONFIG[mode] || { icon: Circle, label: 'Unknown' };
  const Icon = config.icon;
  const label = variant === 'topjourneys' ? getTravelModeLabel(mode, 'topjourneys') : config.label;

  return (
    <span
      className={`travel-mode-badge ${mode} ${clickable ? 'clickable' : ''}`}
      data-mode={mode}
      onClick={clickable ? onClick : undefined}
    >
      <Icon size={14} strokeWidth={1.5} />
      {label}
    </span>
  );
}
