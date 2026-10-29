import { Footprints, Bike, Car, Plane, TrainFront, TrainFrontTunnel, Pencil, Merge, Trash2, Undo2, RotateCcw, Ruler, MapPin, Route, Clock, Gauge, Zap } from 'lucide-react';
import { getTravelModeIcon, getTravelModeLabel } from './TravelModeBadge';
import { useUnits } from '../context/UnitsContext';
import { formatJourneyDateTime } from '../utils/formatters';
import './JourneyTopOverlay.css';

const TRAVEL_MODE_OPTIONS = [
  { mode: 'foot', icon: Footprints, label: 'Foot' },
  { mode: 'scooter', icon: Bike, label: 'Micromobility' },
  { mode: 'drive', icon: Car, label: 'Drive' },
  { mode: 'train', icon: TrainFront, label: 'Train' },
  { mode: 'metro', icon: TrainFrontTunnel, label: 'Metro' },
  { mode: 'flight', icon: Plane, label: 'Flight' },
];

// One icon-labelled stat in the line under the title. The label is the
// tooltip and what screen readers announce in place of the icon.
function MetaItem({ icon, label, children }) {
  const Icon = icon;
  return (
    <span className="jto-meta-item" title={label}>
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
      <span className="jto-sr-only">{label}: </span>
      <span className="jto-meta-text">{children}</span>
    </span>
  );
}

export default function JourneyTopOverlay({
  route,
  geoLabel,
  geoLoading,
  travelModeDropdownOpen,
  onToggleTravelModeDropdown,
  onUpdateTravelMode,
  onRename,
  onCombine,
  onDelete,
  onUndoCombine,
  showUndo,
  onRestore,
  onPermanentDelete,
  trashNotice,
  measureActive = false,
  onToggleMeasure,
}) {
  const { convertDistance, convertSpeed, distanceUnit, speedUnit } = useUnits();
  if (!route) return null;

  const mode = route.travelMode || 'foot';
  const ModeIcon = getTravelModeIcon(mode);
  const modeLabel = getTravelModeLabel(mode);

  const distance = convertDistance(route.distance);
  const avgSpeed = convertSpeed(route.avgSpeed);
  const topSpeed = convertSpeed(route.topSpeed);
  const durationStr = route.duration?.replace(/^0h /, '') || '--';
  const dateTimeStr = formatJourneyDateTime(route.startTime, route.endTime);
  const canMeasure = Boolean(onToggleMeasure) && route.coordinates?.length > 1;

  return (
    <div className="journey-top-overlay" data-mode={mode}>
      <div className="journey-top-gradient" aria-hidden="true" />

      {(canMeasure || showUndo || onCombine || onDelete || onRestore || onPermanentDelete) && (
        <div className="journey-top-actions">
          {canMeasure && (
            <button
              type="button"
              className={`jto-icon-btn jto-measure-btn${measureActive ? ' active' : ''}`}
              onClick={onToggleMeasure}
              title={measureActive ? 'Stop measuring (Esc)' : 'Measure distance between two points'}
              aria-pressed={measureActive}
            >
              <Ruler size={18} />
              <span className="jto-btn-label">Measure</span>
            </button>
          )}
          {showUndo && onUndoCombine && (
            <button className="jto-icon-btn" onClick={onUndoCombine} title="Undo Combine">
              <Undo2 size={18} />
            </button>
          )}
          {onCombine && (
            <button className="jto-icon-btn" onClick={onCombine} title="Combine Journeys">
              <Merge size={18} />
            </button>
          )}
          {onRestore && (
            <button className="jto-icon-btn jto-icon-btn-restore" onClick={onRestore} title="Restore Journey">
              <RotateCcw size={18} />
            </button>
          )}
          {onDelete && (
            <button className="jto-icon-btn jto-icon-btn-danger" onClick={onDelete} title="Delete Journey">
              <Trash2 size={18} />
            </button>
          )}
          {onPermanentDelete && (
            <button className="jto-icon-btn jto-icon-btn-danger" onClick={onPermanentDelete} title="Delete Permanently">
              <Trash2 size={18} />
            </button>
          )}
        </div>
      )}

      <div className="journey-top-content">
        {trashNotice && (
          <div className="jto-deleted-notice">
            <Trash2 size={13} strokeWidth={2} />
            <span>{trashNotice}</span>
          </div>
        )}
        <div className="jto-eyebrow">
          <div className="jto-mode-wrap">
            {onUpdateTravelMode ? (
              <button
                type="button"
                className={`jto-mode-label ${mode}`}
                onClick={onToggleTravelModeDropdown}
                title="Change travel mode"
              >
                <ModeIcon size={14} strokeWidth={1.8} />
                <span>{modeLabel}</span>
              </button>
            ) : (
              <span className={`jto-mode-label ${mode} jto-mode-label-static`}>
                <ModeIcon size={14} strokeWidth={1.8} />
                <span>{modeLabel}</span>
              </span>
            )}
            {travelModeDropdownOpen && onUpdateTravelMode && (
              <div className="jto-travel-mode-dropdown">
                {TRAVEL_MODE_OPTIONS.map(opt => (
                  <div
                    key={opt.mode}
                    className={`travel-mode-option ${opt.mode}${opt.mode === mode ? ' selected' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onUpdateTravelMode(opt.mode); }}
                  >
                    <opt.icon size={16} />
                    {opt.label}
                  </div>
                ))}
              </div>
            )}
          </div>
          {dateTimeStr && <span className="jto-datetime">{dateTimeStr}</span>}
        </div>

        <div className="jto-title-row">
          <h1 className="jto-title">{route.name}</h1>
          {onRename && (
            <button className="jto-icon-btn jto-title-edit" onClick={onRename} title="Rename Journey">
              <Pencil size={16} />
            </button>
          )}
        </div>

        <div className="jto-meta">
          {geoLoading ? (
            <span className="jto-meta-item" title="Location">
              <MapPin size={15} strokeWidth={2} aria-hidden="true" />
              <span className="jto-geo-skeleton" />
            </span>
          ) : geoLabel ? (
            <MetaItem icon={MapPin} label="Location">{geoLabel}</MetaItem>
          ) : null}
          <MetaItem icon={Route} label="Distance">
            {distance != null ? distance.toFixed(1) : '--'}
            <span className="jto-meta-unit">{distanceUnit}</span>
          </MetaItem>
          <MetaItem icon={Clock} label="Duration">{durationStr}</MetaItem>
          <MetaItem icon={Gauge} label="Average speed">
            {avgSpeed != null ? avgSpeed.toFixed(0) : '--'}
            <span className="jto-meta-unit">{speedUnit}</span>
          </MetaItem>
          <MetaItem icon={Zap} label="Top speed">
            {topSpeed != null ? topSpeed.toFixed(0) : '--'}
            <span className="jto-meta-unit">{speedUnit}</span>
          </MetaItem>
        </div>

        <div className="jto-badges">
          {route.watchRecorded && <span className="jto-badge jto-badge-watch">Watch</span>}
          {route.waypoints?.length > 0 && (
            <span className="jto-badge jto-badge-waypoints">
              {route.waypoints.length} Saved Spot{route.waypoints.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
