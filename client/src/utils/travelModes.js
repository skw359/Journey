import { Footprints, Bike, Car, Plane, TrainFront, TrainFrontTunnel } from 'lucide-react';

export const MODE_CONFIG = {
  foot: { icon: Footprints, label: 'Foot' },
  scooter: { icon: Bike, label: 'Micromobility' },
  drive: { icon: Car, label: 'Drive' },
  train: { icon: TrainFront, label: 'Train' },
  metro: { icon: TrainFrontTunnel, label: 'Metro' },
  flight: { icon: Plane, label: 'Flight' },
};

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
