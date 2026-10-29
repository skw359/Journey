import { CalendarSearch } from 'lucide-react';
import './DateSearchChip.css';

/**
 * Shown in the sidebar when the search box was read as a date rather than a
 * name, so it is obvious which journeys are being matched and why.
 */
export default function DateSearchChip({ dateWindow, count }) {
  if (!dateWindow) return null;

  return (
    <div className="date-search-chip" title="Matched as a date — journeys in this range">
      <CalendarSearch size={13} className="date-search-chip-icon" />
      <span className="date-search-chip-label">{dateWindow.label}</span>
      <span className="date-search-chip-count">
        {count} {count === 1 ? 'journey' : 'journeys'}
      </span>
    </div>
  );
}
