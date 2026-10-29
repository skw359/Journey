import { Footprints, Bike, Car, Circle, Plane, TrainFront, TrainFrontTunnel } from 'lucide-react';
import './TravelModeBadge.css';

const MODE_CONFIG = {
  foot: { icon: Footprints, label: 'Foot' },
  scooter: { icon: Bike, label: 'Micromobility' },
  drive: { icon: Car, label: 'Drive' },
  train: { icon: TrainFront, label: 'Train' },
  metro: { icon: TrainFrontTunnel, label: 'Metro' },
  flight: { icon: Plane, label: 'Flight' },
};

export function getTravelModeIcon(mode) {
  return MODE_CONFIG[mode]?.icon || Circle;
}

export function getTravelModeLabel(mode, variant) {
  if (variant === 'topjourneys') {
    switch (mode) {
      case 'foot': return 'Walk/Run';
      case 'scooter': return 'Scooter/Bike';
      case 'drive': return 'Drive';
      case 'train': return 'Train';
      case 'metro': return 'Metro';
      case 'flight': return 'Flight';
      default: return 'Unknown';
    }
  }
  return MODE_CONFIG[mode]?.label || 'Unknown';
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
