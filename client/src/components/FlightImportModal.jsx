import { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import Modal from './Modal';
import { useToast } from '../context/ToastContext';
import { useTheme } from '../context/ThemeContext';
import { useUnits } from '../context/UnitsContext';
import { TILE_ATTRIBUTION } from '../utils/mapUtils';
import { searchFlights, getFlightTrack, importFlight, fetchAirports } from '../api/journeys';
import { Plane, ArrowLeft, Search, ArrowRight, MapPin } from 'lucide-react';
import './FlightImportModal.css';

const STEPS = { SEARCH: 'search', RESULTS: 'results', PREVIEW: 'preview' };

export default function FlightImportModal({ open, onClose, onImported }) {
  const toast = useToast();
  const { tileUrl } = useTheme();
  const { convertDistance, convertSpeed, convertElevation, distanceUnit, speedUnit, elevationUnit } = useUnits();

  // Step state
  const [step, setStep] = useState(STEPS.SEARCH);

  // Search form
  const [departure, setDeparture] = useState('');
  const [arrival, setArrival] = useState('');
  const [date, setDate] = useState('');
  const [departureTime, setDepartureTime] = useState('');
  const [flightNumber, setFlightNumber] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // Airport autocomplete
  const [airports, setAirports] = useState(null);
  const [depSuggestions, setDepSuggestions] = useState([]);
  const [arrSuggestions, setArrSuggestions] = useState([]);
  const [activeField, setActiveField] = useState(null);

  // Results
  const [flights, setFlights] = useState([]);

  // Preview
  const [selectedFlight, setSelectedFlight] = useState(null);
  const [trackData, setTrackData] = useState(null);
  const [loadingTrack, setLoadingTrack] = useState(false);
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);

  // Map ref
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);

  // Load airports for autocomplete
  useEffect(() => {
    if (open && !airports) {
      fetchAirports().then(setAirports).catch(() => {});
    }
  }, [open, airports]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setStep(STEPS.SEARCH);
      setDeparture('');
      setArrival('');
      setDate('');
      setDepartureTime('');
      setFlightNumber('');
      setSearching(false);
      setSearchError('');
      setFlights([]);
      setSelectedFlight(null);
      setTrackData(null);
      setLoadingTrack(false);
      setImportName('');
      setImporting(false);
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    }
  }, [open]);

  // Airport search/filter
  const filterAirports = useCallback((query) => {
    if (!airports || query.length < 1) return [];
    const q = query.toUpperCase();
    const results = [];
    for (const [code, info] of Object.entries(airports)) {
      if (results.length >= 8) break;
      if (code.includes(q) || info.name.toUpperCase().includes(q) || info.city.toUpperCase().includes(q)) {
        results.push({ code, ...info });
      }
    }
    return results;
  }, [airports]);

  const handleDepChange = (val) => {
    setDeparture(val.toUpperCase());
    setDepSuggestions(val.length >= 1 ? filterAirports(val) : []);
    setActiveField('dep');
  };

  const handleArrChange = (val) => {
    setArrival(val.toUpperCase());
    setArrSuggestions(val.length >= 1 ? filterAirports(val) : []);
    setActiveField('arr');
  };

  const selectAirport = (code, field) => {
    if (field === 'dep') {
      setDeparture(code);
      setDepSuggestions([]);
    } else {
      setArrival(code);
      setArrSuggestions([]);
    }
    setActiveField(null);
  };

  // Search
  const handleSearch = async () => {
    if (!departure || !arrival || !date) {
      setSearchError('Please fill in departure, arrival, and date.');
      return;
    }
    if (!/^[A-Z]{3}$/.test(departure) || !/^[A-Z]{3}$/.test(arrival)) {
      setSearchError('Airport codes must be 3-letter IATA codes (e.g., JFK, LAX).');
      return;
    }
    setSearchError('');
    setSearching(true);
    try {
      const res = await searchFlights({
        departure, arrival, date,
        departureTime: departureTime || undefined,
        flightNumber: flightNumber || undefined,
      });
      if (!res.flights || res.flights.length === 0) {
        setSearchError('No flights found for the given criteria. Try adjusting your search.');
        setSearching(false);
        return;
      }
      setFlights(res.flights);
      if (res.flights.length === 1) {
        handleSelectFlight(res.flights[0]);
      } else {
        setStep(STEPS.RESULTS);
      }
    } catch (err) {
      setSearchError(err.message || 'Search failed');
    }
    setSearching(false);
  };

  // Select flight and load track
  const handleSelectFlight = async (flight) => {
    setSelectedFlight(flight);
    setLoadingTrack(true);
    setStep(STEPS.PREVIEW);

    const defaultName = `Flight - ${flight.departure.airport} to ${flight.arrival.airport} - ${new Date(flight.departure.time).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}`;
    setImportName(flight.flightNumber ? `${flight.flightNumber} - ${flight.departure.airport} to ${flight.arrival.airport}` : defaultName);

    try {
      const track = await getFlightTrack({
        flightId: flight.flightId,
        departure: flight.departure.airport,
        arrival: flight.arrival.airport,
        departureTime: flight.departure.time,
        arrivalTime: flight.arrival.time,
      });
      setTrackData(track);
    } catch (err) {
      toast.error('Failed to load flight track');
      setStep(STEPS.RESULTS);
    }
    setLoadingTrack(false);
  };

  // Initialize map when track data is ready
  useEffect(() => {
    if (step !== STEPS.PREVIEW || !trackData || !mapContainerRef.current) return;

    // Clean up previous map
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    // Small delay to let the container render
    const timer = setTimeout(() => {
      if (!mapContainerRef.current) return;

      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
        attributionControl: true,
      });
      mapInstanceRef.current = map;

      L.tileLayer(tileUrl, {
        attribution: TILE_ATTRIBUTION,
        subdomains: 'abcd',
        maxZoom: 20,
      }).addTo(map);

      // Draw flight path
      const coords = trackData.coordinates;
      if (coords && coords.length >= 2) {
        const polyline = L.polyline(coords, {
          color: '#A855F7',
          weight: 3,
          opacity: 0.9,
        }).addTo(map);

        // Start/end markers
        L.circleMarker(coords[0], {
          radius: 6, fillColor: '#22c55e', fillOpacity: 1, color: '#fff', weight: 2,
        }).addTo(map);
        L.circleMarker(coords[coords.length - 1], {
          radius: 6, fillColor: '#ef4444', fillOpacity: 1, color: '#fff', weight: 2,
        }).addTo(map);

        map.fitBounds(polyline.getBounds(), { padding: [30, 30] });
      }
    }, 50);

    return () => {
      clearTimeout(timer);
    };
  }, [step, trackData, tileUrl]);

  // Import
  const handleImport = async () => {
    if (!selectedFlight || !trackData) return;
    setImporting(true);
    const loadId = toast.loading('Importing flight...');
    try {
      const res = await importFlight({
        flightId: selectedFlight.flightId,
        departure: selectedFlight.departure.airport,
        arrival: selectedFlight.arrival.airport,
        departureTime: selectedFlight.departure.time,
        arrivalTime: selectedFlight.arrival.time,
        name: importName,
      });
      toast.dismiss(loadId);
      toast.success('Flight imported successfully!');
      onImported?.(res.route);
    } catch (err) {
      toast.dismiss(loadId);
      toast.error(err.message || 'Failed to import flight');
    }
    setImporting(false);
  };

  const formatFlightTime = (isoStr) => {
    if (!isoStr) return '--';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  const formatFlightDate = (isoStr) => {
    if (!isoStr) return '';
    return new Date(isoStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const goBack = () => {
    if (step === STEPS.RESULTS) setStep(STEPS.SEARCH);
    else if (step === STEPS.PREVIEW) {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
      setTrackData(null);
      setStep(flights.length > 1 ? STEPS.RESULTS : STEPS.SEARCH);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <div className="flight-import-modal">
        {/* Header */}
        <div className="modal-header flight-header">
          {step !== STEPS.SEARCH && (
            <button className="flight-back-btn" onClick={goBack}>
              <ArrowLeft size={16} />
            </button>
          )}
          <Plane size={20} />
          <h3>{step === STEPS.SEARCH ? 'Import Flight' : step === STEPS.RESULTS ? 'Select Flight' : 'Preview Flight'}</h3>
        </div>

        {/* Step: Search */}
        {step === STEPS.SEARCH && (
          <div className="flight-search-form">
            <div className="flight-form-grid">
              <div className="flight-field">
                <label>Departure Airport</label>
                <div className="airport-input-wrap">
                  <input
                    className="modern-input airport-input"
                    placeholder="e.g. JFK"
                    value={departure}
                    onChange={(e) => handleDepChange(e.target.value)}
                    onFocus={() => setActiveField('dep')}
                    onBlur={() => setTimeout(() => setActiveField(null), 200)}
                    maxLength={3}
                  />
                  {activeField === 'dep' && depSuggestions.length > 0 && (
                    <div className="airport-suggestions">
                      {depSuggestions.map(a => (
                        <div key={a.code} className="airport-suggestion" onMouseDown={() => selectAirport(a.code, 'dep')}>
                          <span className="airport-code">{a.code}</span>
                          <span className="airport-name">{a.city} - {a.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flight-field">
                <label>Arrival Airport</label>
                <div className="airport-input-wrap">
                  <input
                    className="modern-input airport-input"
                    placeholder="e.g. LAX"
                    value={arrival}
                    onChange={(e) => handleArrChange(e.target.value)}
                    onFocus={() => setActiveField('arr')}
                    onBlur={() => setTimeout(() => setActiveField(null), 200)}
                    maxLength={3}
                  />
                  {activeField === 'arr' && arrSuggestions.length > 0 && (
                    <div className="airport-suggestions">
                      {arrSuggestions.map(a => (
                        <div key={a.code} className="airport-suggestion" onMouseDown={() => selectAirport(a.code, 'arr')}>
                          <span className="airport-code">{a.code}</span>
                          <span className="airport-name">{a.city} - {a.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flight-field">
                <label>Date</label>
                <input
                  className="modern-input"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="flight-field">
                <label>Departure Time <span className="optional-label">(optional)</span></label>
                <input
                  className="modern-input"
                  type="time"
                  value={departureTime}
                  onChange={(e) => setDepartureTime(e.target.value)}
                />
              </div>
            </div>
            <div className="flight-field flight-number-field">
              <label>Flight Number <span className="optional-label">(optional)</span></label>
              <input
                className="modern-input"
                placeholder="e.g. AA100"
                value={flightNumber}
                onChange={(e) => setFlightNumber(e.target.value.toUpperCase())}
              />
            </div>

            {searchError && <div className="flight-error">{searchError}</div>}

            <div className="modal-buttons">
              <button className="modal-btn modal-btn-cancel" onClick={onClose}>Cancel</button>
              <button className={`modal-btn modal-btn-confirm${searching ? ' loading' : ''}`} onClick={handleSearch} disabled={searching}>
                <span className="btn-text"><Search size={14} /> Search Flights</span>
                <span className="btn-loader" />
              </button>
            </div>
          </div>
        )}

        {/* Step: Results */}
        {step === STEPS.RESULTS && (
          <div className="flight-results">
            <p className="flight-results-count">{flights.length} flight{flights.length !== 1 ? 's' : ''} found</p>
            <div className="flight-results-list">
              {flights.map((flight, idx) => (
                <div key={idx} className="flight-result-card" onClick={() => handleSelectFlight(flight)}>
                  <div className="flight-result-header">
                    {flight.flightNumber && <span className="flight-result-number">{flight.flightNumber}</span>}
                    {flight.airline && <span className="flight-result-airline">{flight.airline}</span>}
                    {flight.source === 'great_circle' && <span className="flight-result-synth">Estimated</span>}
                  </div>
                  <div className="flight-result-route">
                    <div className="flight-result-endpoint">
                      <span className="flight-result-code">{flight.departure.airport}</span>
                      <span className="flight-result-time">{formatFlightTime(flight.departure.time)}</span>
                      <span className="flight-result-city">{flight.departure.city}</span>
                    </div>
                    <div className="flight-result-arrow">
                      <ArrowRight size={16} />
                      {flight.duration && <span className="flight-result-duration">{flight.duration}</span>}
                    </div>
                    <div className="flight-result-endpoint">
                      <span className="flight-result-code">{flight.arrival.airport}</span>
                      <span className="flight-result-time">{formatFlightTime(flight.arrival.time)}</span>
                      <span className="flight-result-city">{flight.arrival.city}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-buttons">
              <button className="modal-btn modal-btn-cancel" onClick={goBack}>Back</button>
            </div>
          </div>
        )}

        {/* Step: Preview */}
        {step === STEPS.PREVIEW && (
          <div className="flight-preview">
            {loadingTrack ? (
              <div className="flight-loading">
                <div className="flight-loading-spinner" />
                <p>Loading flight track...</p>
              </div>
            ) : trackData ? (
              <>
                <div className="flight-map-container" ref={mapContainerRef} />
                <div className="flight-stats-row">
                  <div className="flight-stat">
                    <span className="flight-stat-value">{convertDistance(trackData.distance).toFixed(1)}</span>
                    <span className="flight-stat-label">{distanceUnit}</span>
                  </div>
                  <div className="flight-stat">
                    <span className="flight-stat-value">{trackData.duration}</span>
                    <span className="flight-stat-label">Duration</span>
                  </div>
                  <div className="flight-stat">
                    <span className="flight-stat-value">{convertSpeed(trackData.topSpeed).toFixed(0)}</span>
                    <span className="flight-stat-label">{speedUnit}</span>
                  </div>
                  <div className="flight-stat">
                    <span className="flight-stat-value">{convertElevation(trackData.topElevation).toFixed(0)}</span>
                    <span className="flight-stat-label">{elevationUnit}</span>
                  </div>
                </div>
                {trackData.source === 'great_circle' && (
                  <p className="flight-synth-note">
                    <MapPin size={12} /> Estimated route (great-circle path). Configure a FlightAware API key in Settings for actual flight tracks.
                  </p>
                )}
                <div className="flight-field">
                  <label>Journey Name</label>
                  <input
                    className="modern-input"
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                  />
                </div>
                <div className="modal-buttons">
                  <button className="modal-btn modal-btn-cancel" onClick={goBack}>Back</button>
                  <button className={`modal-btn modal-btn-confirm flight-import-btn${importing ? ' loading' : ''}`} onClick={handleImport} disabled={importing}>
                    <span className="btn-text"><Plane size={14} /> Import Flight</span>
                    <span className="btn-loader" />
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}
