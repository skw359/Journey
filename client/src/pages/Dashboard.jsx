import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Trash2, Pencil, ChevronRight, AlertCircle, X } from 'lucide-react';
import TopLoader from '../components/TopLoader';
import Sidebar from '../components/Sidebar';
import FilterBar from '../components/FilterBar';
import JourneyCard from '../components/JourneyCard';
import RouteMap from '../components/RouteMap';
import StatsGrid from '../components/StatsGrid';
import ElevationChart from '../components/ElevationChart';
import SpeedChart from '../components/SpeedChart';
import AccelerationChart from '../components/AccelerationChart';
import PhotoGallery from '../components/PhotoGallery';
import PhotoViewer from '../components/PhotoViewer';
import Modal from '../components/Modal';
import TravelModeBadge from '../components/TravelModeBadge';
import FirstRunOnboarding from '../components/FirstRunOnboarding';
import { Footprints, Bike, Car } from 'lucide-react';
import { fetchRoutes, fetchRouteDetail, deleteRoute, renameRoute, updateTravelMode as apiUpdateTravelMode, uploadPhotos as apiUploadPhotos, deletePhoto as apiDeletePhoto, deleteDataPoint } from '../api/journeys';
import { formatTime, formatDataPointCount } from '../utils/formatters';
import { useToast } from '../context/ToastContext';
import { useUnits } from '../context/UnitsContext';
import useGeoLabel from '../hooks/useGeoLabel';
import './Dashboard.css';

const PREVIEW_MAX_POINTS = 100;
const DETAIL_ZOOM_THRESHOLD = 8;

export default function Dashboard({ sidebarCollapsed = false, searchValue = '' }) {
  const toast = useToast();
  const { convertSpeed, speedUnit } = useUnits();
  const [searchParams, setSearchParams] = useSearchParams();
  const [allRoutes, setAllRoutes] = useState([]);
  const [currentRoute, setCurrentRoute] = useState(null);
  const [currentRouteId, setCurrentRouteId] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  const [photoViewerOpen, setPhotoViewerOpen] = useState(false);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);

  const handleScroll = (e) => {
    setIsScrolled(e.target.scrollTop > 20);
  };
  const [uploading, setUploading] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePhotoModalOpen, setDeletePhotoModalOpen] = useState(false);
  const [photoToDelete, setPhotoToDelete] = useState(null);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [pointDeleteModalOpen, setPointDeleteModalOpen] = useState(false);
  const [pointToDelete, setPointToDelete] = useState(null);

  const [travelModeDropdownOpen, setTravelModeDropdownOpen] = useState(false);

  const loaderRef = useRef(null);
  const currentRouteIdRef = useRef(currentRouteId);
  const routeCacheRef = useRef(new Map());
  const fullDetailRouteIdsRef = useRef(new Set());
  const detailFetchInFlightRef = useRef(new Set());
  const selectionSeqRef = useRef(0);

  const { label: geoLabel, loading: geoLoading } = useGeoLabel(currentRoute);

  const cacheRouteDetail = useCallback((route) => {
    if (!route?.id) return;
    routeCacheRef.current.set(route.id, route);
    if (route.isFullResolution) fullDetailRouteIdsRef.current.add(route.id);
    else fullDetailRouteIdsRef.current.delete(route.id);
  }, []);

  useEffect(() => {
    currentRouteIdRef.current = currentRouteId;
  }, [currentRouteId]);

  const loadRouteWithAnimation = useCallback(async (routeId) => {
    if (routeId === currentRouteIdRef.current) return;
    const requestSeq = ++selectionSeqRef.current;
    setIsLoading(true);
    loaderRef.current?.start();

    await new Promise(r => setTimeout(r, 250));

    try {
      const cachedRoute = routeCacheRef.current.get(routeId);
      const route = cachedRoute || await fetchRouteDetail(routeId, { maxPoints: PREVIEW_MAX_POINTS });
      if (requestSeq !== selectionSeqRef.current) return;

      cacheRouteDetail(route);
      setCurrentRoute(route);
      setCurrentRouteId(routeId);
      setInfoExpanded(false);
    } catch (err) {
      console.error(err);
    } finally {
      if (requestSeq === selectionSeqRef.current) {
        loaderRef.current?.finish();
        setIsLoading(false);
      }
    }
  }, [cacheRouteDetail]);

  const loadFullDetailForViewport = useCallback(async ({ zoom }) => {
    const routeId = currentRouteIdRef.current;
    if (!routeId || zoom < DETAIL_ZOOM_THRESHOLD) return;
    if (fullDetailRouteIdsRef.current.has(routeId)) return;
    if (detailFetchInFlightRef.current.has(routeId)) return;

    detailFetchInFlightRef.current.add(routeId);
    try {
      const route = await fetchRouteDetail(routeId, { maxPoints: 0 });
      cacheRouteDetail(route);
      setCurrentRoute(prev => {
        if (!prev || prev.id !== routeId) return prev;
        return route;
      });
    } catch (err) {
      console.error('Failed to load full route detail:', err);
    } finally {
      detailFetchInFlightRef.current.delete(routeId);
    }
  }, [cacheRouteDetail]);

  useEffect(() => {
    const load = async () => {
      try {
        const routes = await fetchRoutes();
        setAllRoutes(routes);

        const urlRouteId = searchParams.get('routeId');
        if (urlRouteId) {
          const exists = routes.some(r => r.id === urlRouteId);
          if (exists) {
            await loadRouteWithAnimation(urlRouteId);
            setSearchParams({}, { replace: true });
            return;
          }
        }

        const sorted = [...routes].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
        if (sorted.length > 0) {
          await loadRouteWithAnimation(sorted[0].id);
        }
      } catch (err) {
        console.error('Failed to load routes:', err);
      } finally {
        setInitialLoading(false);
      }
    };
    load();
  }, []);

  const filteredRoutes = allRoutes
    .filter(r => {
      const matchesFilter = activeFilter === 'all' || r.travelMode === activeFilter;
      const matchesSearch = r.name.toLowerCase().includes(searchValue.toLowerCase());
      return matchesFilter && matchesSearch;
    })
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  const hasAnyRoutes = allRoutes.length > 0;
  const showOnboardingEmptyState = !initialLoading && !hasAnyRoutes;
  const showFilteredEmptyState = hasAnyRoutes && filteredRoutes.length === 0;

  const handleDeleteJourney = async () => {
    if (!currentRouteId) return;
    
    const routeToDeleteId = currentRouteId;
    const oldRoutes = [...allRoutes];
    const newRoutes = allRoutes.filter(r => r.id !== routeToDeleteId);
    
    setAllRoutes(newRoutes);
    routeCacheRef.current.delete(routeToDeleteId);
    fullDetailRouteIdsRef.current.delete(routeToDeleteId);
    detailFetchInFlightRef.current.delete(routeToDeleteId);
    setDeleteModalOpen(false);

    const sorted = [...newRoutes].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    if (sorted.length > 0) {
      loadRouteWithAnimation(sorted[0].id);
    } else {
      setCurrentRoute(null);
      setCurrentRouteId(null);
    }

    try {
      const tid = toast.loading('Deleting journey...');
      await deleteRoute(routeToDeleteId);
      toast.dismiss(tid);
      toast.success('Journey deleted successfully');
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete journey');
      setAllRoutes(oldRoutes);
    }
  };

  const handleRename = async () => {
    if (!currentRouteId || !renameValue.trim() || renameValue.trim() === currentRoute?.name) {
      setRenameModalOpen(false);
      return;
    }

    const newName = renameValue.trim();
    const oldName = currentRoute.name;

    setCurrentRoute(prev => {
      if (!prev || prev.id !== currentRouteId) return prev;
      const updated = { ...prev, name: newName };
      cacheRouteDetail(updated);
      return updated;
    });
    setAllRoutes(prev => prev.map(r => r.id === currentRouteId ? { ...r, name: newName } : r));
    setRenameModalOpen(false);

    try {
      const tid = toast.loading('Renaming journey...');
      await renameRoute(currentRouteId, newName);
      toast.dismiss(tid);
      toast.success('Journey renamed');
    } catch (err) {
      console.error(err);
      toast.error('Failed to rename journey');
      setCurrentRoute(prev => {
        if (!prev || prev.id !== currentRouteId) return prev;
        const reverted = { ...prev, name: oldName };
        cacheRouteDetail(reverted);
        return reverted;
      });
      setAllRoutes(prev => prev.map(r => r.id === currentRouteId ? { ...r, name: oldName } : r));
    }
  };

  const handleUpdateTravelMode = async (mode) => {
    if (!currentRouteId) return;
    setTravelModeDropdownOpen(false);
    
    const oldMode = currentRoute.travelMode;
    
    setCurrentRoute(prev => {
      if (!prev || prev.id !== currentRouteId) return prev;
      const updated = { ...prev, travelMode: mode };
      cacheRouteDetail(updated);
      return updated;
    });
    setAllRoutes(prev => prev.map(r => r.id === currentRouteId ? { ...r, travelMode: mode } : r));

    try {
      const tid = toast.loading('Updating travel mode...');
      await apiUpdateTravelMode(currentRouteId, mode);
      toast.dismiss(tid);
      toast.success(`Travel mode updated to ${mode}`);
    } catch (err) {
      console.error(err);
      toast.error('Failed to update travel mode');
      setCurrentRoute(prev => {
        if (!prev || prev.id !== currentRouteId) return prev;
        const reverted = { ...prev, travelMode: oldMode };
        cacheRouteDetail(reverted);
        return reverted;
      });
      setAllRoutes(prev => prev.map(r => r.id === currentRouteId ? { ...r, travelMode: oldMode } : r));
    }
  };

  const handleUploadPhotos = async (files) => {
    if (!currentRouteId) return;
    const routeId = currentRouteId;
    setUploading(true);
    setUploadCount(files.length);
    try {
      const tid = toast.loading(`Uploading ${files.length} photo${files.length === 1 ? '' : 's'}...`);
      await apiUploadPhotos(routeId, files);
      toast.dismiss(tid);
      toast.success(`${files.length} photo${files.length === 1 ? '' : 's'} uploaded`);
      const maxPoints = fullDetailRouteIdsRef.current.has(routeId) ? 0 : PREVIEW_MAX_POINTS;
      const detail = await fetchRouteDetail(routeId, { maxPoints });
      cacheRouteDetail(detail);
      if (currentRouteIdRef.current === routeId) {
        setCurrentRoute(detail);
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to upload photos');
    }
    setUploading(false);
  };

  const handleDeletePhoto = async () => {
    if (!currentRouteId || !photoToDelete) return;
    
    const photoId = photoToDelete.id;
    const oldPhotos = [...(currentRoute.photos || [])];

    setCurrentRoute(prev => {
      if (!prev || prev.id !== currentRouteId) return prev;
      const updated = { ...prev, photos: prev.photos.filter(p => p.id !== photoId) };
      cacheRouteDetail(updated);
      return updated;
    });
    setDeletePhotoModalOpen(false);
    setPhotoToDelete(null);

    try {
      const tid = toast.loading('Deleting photo...');
      await apiDeletePhoto(currentRouteId, photoId);
      toast.dismiss(tid);
      toast.success('Photo deleted');
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete photo');
      setCurrentRoute(prev => {
        if (!prev || prev.id !== currentRouteId) return prev;
        const reverted = { ...prev, photos: oldPhotos };
        cacheRouteDetail(reverted);
        return reverted;
      });
    }
  };

  const handlePointClick = (index, route) => {
    const speed = route.profileSpeedMph[index];
    const time = route.profileTimeMs[index];
    const startTime = route.profileTimeMs[0];
    setPointToDelete({ index, speed, time, startTime });
    setPointDeleteModalOpen(true);
  };

  const handleDeletePoint = async () => {
    if (!currentRouteId || pointToDelete === null) return;
    
    const routeId = currentRouteId;

    const findClosestIndex = (series, target) => {
      if (!Array.isArray(series) || series.length === 0 || !Number.isFinite(target)) return pointToDelete.index;
      let bestIndex = 0;
      let bestDelta = Infinity;
      for (let i = 0; i < series.length; i++) {
        const delta = Math.abs(series[i] - target);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIndex = i;
        }
      }
      return bestIndex;
    };

    let indexToDelete = pointToDelete.index;
    if (!fullDetailRouteIdsRef.current.has(routeId)) {
      try {
        const fullRoute = await fetchRouteDetail(routeId, { maxPoints: 0 });
        cacheRouteDetail(fullRoute);
        if (currentRouteIdRef.current === routeId) {
          setCurrentRoute(fullRoute);
        }
        indexToDelete = findClosestIndex(fullRoute.profileTimeMs, pointToDelete.time);
      } catch (err) {
        console.error(err);
        toast.error('Failed to load full route detail before delete');
        return;
      }
    }

    const oldRoute = routeCacheRef.current.get(routeId) || currentRoute;

    setCurrentRoute(prev => {
      if (!prev || prev.id !== routeId) return prev;
      const newRoute = { ...prev };
      newRoute.coordinates = prev.coordinates.filter((_, i) => i !== indexToDelete);
      newRoute.profileSpeedMph = prev.profileSpeedMph.filter((_, i) => i !== indexToDelete);
      newRoute.profileTimeMs = prev.profileTimeMs.filter((_, i) => i !== indexToDelete);
      newRoute.profileDistMi = prev.profileDistMi.filter((_, i) => i !== indexToDelete);
      if (prev.profileElevM) {
        newRoute.profileElevM = prev.profileElevM.filter((_, i) => i !== indexToDelete);
      }
      cacheRouteDetail(newRoute);
      return newRoute;
    });
    
    setPointDeleteModalOpen(false);
    setPointToDelete(null);

    try {
      const tid = toast.loading('Deleting point...');
      await deleteDataPoint(routeId, indexToDelete);
      toast.dismiss(tid);
      toast.success('Point deleted');
      const detail = await fetchRouteDetail(routeId, { maxPoints: 0 });
      cacheRouteDetail(detail);
      if (currentRouteIdRef.current === routeId) {
        setCurrentRoute(detail);
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete point: ' + err.message);
      if (oldRoute) {
        cacheRouteDetail(oldRoute);
        setCurrentRoute(oldRoute);
      }
    }
  };

  const getDateTimeStr = () => {
    if (!currentRoute?.startTime || !currentRoute?.endTime) return '';
    const start = new Date(currentRoute.startTime);
    const end = new Date(currentRoute.endTime);
    const dateStr = start.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const startTimeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const endTimeStr = end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const rawCount = currentRoute.totalPoints ?? currentRoute.coordinates?.length ?? 0;
    const displayedCount = formatDataPointCount(rawCount);
    const pointLabel = rawCount === 1 ? 'point' : 'points';
    return `${dateStr} • ${startTimeStr}–${endTimeStr} • ${displayedCount} ${pointLabel}`;
  };

  return (
    <div id="main-app">
      <TopLoader ref={loaderRef} />

      <div className="full-screen-container">
        {!showOnboardingEmptyState && (
          <Sidebar collapsed={sidebarCollapsed}>
            {hasAnyRoutes && <FilterBar active={activeFilter} onChange={setActiveFilter} />}
            <div className="route-list" style={{ overflowY: 'auto', flexGrow: 1 }}>
              {showFilteredEmptyState ? (
                <p className="dashboard-empty-filter">No matching journeys could be found with the current search parameters.</p>
              ) : (
                filteredRoutes.map(route => (
                  <JourneyCard
                    key={route.id}
                    route={route}
                    active={route.id === currentRouteId}
                    onClick={(id) => loadRouteWithAnimation(id)}
                  />
                ))
              )}
            </div>
          </Sidebar>
        )}

        <main className={`details-view-container${showOnboardingEmptyState ? ' onboarding-layout' : ''}`} onScroll={handleScroll}>
          {currentRoute && (
            <div className={`details-header${isLoading ? ' fade-out' : ''}${isScrolled ? ' scrolled' : ''}`}>
              <div className="details-title-wrap">
                <h2>
                  <div className="title-stack">
                    <div className="details-title-row">
                      <div>{currentRoute.name}</div>
                      <button
                        className={`info-toggle-btn${infoExpanded ? ' active' : ''}`}
                        onClick={() => setInfoExpanded(prev => !prev)}
                        title="Show Details"
                      >
                        <ChevronRight size={12} />
                      </button>
                    </div>
                    {geoLoading ? (
                      <div className="geo-label-skeleton" />
                    ) : geoLabel ? (
                      <div className="geo-label">{geoLabel}</div>
                    ) : null}
                    <div className={`meta-info-expandable${infoExpanded ? ' expanded' : ''}`}>
                      <div className="details-datetime">{getDateTimeStr()}</div>
                    </div>
                    <div className="badges-row">
                      {currentRoute.watchRecorded && <span className="badge-watch"> Watch</span>}
                      <span className="details-travel-mode" style={{ position: 'relative' }}>
                        <TravelModeBadge
                          mode={currentRoute.travelMode || 'foot'}
                          clickable
                          onClick={(e) => { e.stopPropagation(); setTravelModeDropdownOpen(prev => !prev); }}
                        />
                        {travelModeDropdownOpen && (
                          <div className="travel-mode-dropdown active">
                            {[
                              { mode: 'foot', icon: Footprints, label: 'Foot' },
                              { mode: 'scooter', icon: Bike, label: 'Micromobility' },
                              { mode: 'drive', icon: Car, label: 'Drive' },
                            ].map(opt => (
                              <div
                                key={opt.mode}
                                className={`travel-mode-option ${opt.mode}`}
                                onClick={(e) => { e.stopPropagation(); handleUpdateTravelMode(opt.mode); }}
                              >
                                <opt.icon size={16} />
                                {opt.label}
                              </div>
                            ))}
                          </div>
                        )}
                      </span>
                      {currentRoute.waypoints?.length > 0 && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', padding: '2px 6px',
                          background: '#4A90E2', color: 'white', borderRadius: 6, fontSize: '0.72em'
                        }}>
                          {currentRoute.waypoints.length} Saved Spot{currentRoute.waypoints.length === 1 ? '' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </h2>
                <button
                  className="icon-btn"
                  onClick={() => { setRenameValue(currentRoute.name); setRenameModalOpen(true); }}
                  title="Rename Journey"
                >
                  <Pencil size={18} />
                </button>
              </div>
              <button
                className="delete-btn"
                onClick={() => setDeleteModalOpen(true)}
                title="Delete Journey"
              >
                <Trash2 size={20} />
              </button>
            </div>
          )}

          <section className={`main-content${isLoading ? ' fade-out' : ''}${showOnboardingEmptyState ? ' empty-onboarding' : ''}`}>
            {showOnboardingEmptyState ? (
              <FirstRunOnboarding />
            ) : currentRoute && (
              <>
                <RouteMap
                  route={currentRoute}
                  sidebarCollapsed={sidebarCollapsed}
                  onViewportChange={loadFullDetailForViewport}
                />
                <StatsGrid route={currentRoute} />

                {currentRoute.profileTimeMs && currentRoute.profileDistMi && (
                  <div className="graphs-section">
                    <ElevationChart route={currentRoute} onPointClick={handlePointClick} />
                    <SpeedChart route={currentRoute} onPointClick={handlePointClick} />
                    <AccelerationChart route={currentRoute} onPointClick={handlePointClick} />
                  </div>
                )}

                <PhotoGallery
                  photos={currentRoute.photos}
                  uploading={uploading}
                  uploadCount={uploadCount}
                  onUpload={handleUploadPhotos}
                  onDeletePhoto={(id, filename) => {
                    setPhotoToDelete({ id, filename });
                    setDeletePhotoModalOpen(true);
                  }}
                  onViewPhoto={(idx) => {
                    setCurrentPhotoIndex(idx);
                    setPhotoViewerOpen(true);
                  }}
                />
              </>
            )}
          </section>
        </main>
      </div>

      <PhotoViewer
        photos={currentRoute?.photos || []}
        currentIndex={currentPhotoIndex}
        open={photoViewerOpen}
        onClose={() => setPhotoViewerOpen(false)}
        onNavigate={setCurrentPhotoIndex}
      />

      <Modal open={deleteModalOpen} onClose={() => setDeleteModalOpen(false)}>
        <div className="modal-header">
          <AlertCircle size={24} />
          <h3>Delete Journey</h3>
        </div>
        <div className="modal-body">
          <p>Are you sure you want to delete this journey?</p>
          <div className="modal-route-name">&quot;{currentRoute?.name}&quot;</div>
          <p>This action cannot be undone.</p>
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={() => setDeleteModalOpen(false)}>Cancel</button>
          <button className="modal-btn modal-btn-delete" onClick={handleDeleteJourney}>Delete</button>
        </div>
      </Modal>

      <Modal open={deletePhotoModalOpen} onClose={() => { setDeletePhotoModalOpen(false); }}>
        <div className="modal-header">
          <AlertCircle size={24} />
          <h3>Delete Photo</h3>
        </div>
        <div className="modal-body">
          <p>Are you sure you want to permanently delete this photo? This action cannot be undone.</p>
          {photoToDelete && (
            <div className="modal-photo-preview">
              <img src={`/photos/${photoToDelete.filename}`} alt="Photo preview" />
            </div>
          )}
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={() => { setDeletePhotoModalOpen(false); }}>Cancel</button>
          <button className="modal-btn modal-btn-delete" onClick={handleDeletePhoto}>
            <span className="btn-text">Delete</span>
            <span className="btn-loader" />
          </button>
        </div>
      </Modal>

      <Modal open={renameModalOpen} onClose={() => { setRenameModalOpen(false); }}>
        <div className="modal-header rename-header">
          <Pencil size={24} />
          <h3>Rename Journey</h3>
        </div>
        <div className="modal-body">
          <p>Enter a new name for this journey.</p>
          <input
            type="text"
            className="modern-input"
            placeholder="New journey name..."
            autoComplete="off"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
            autoFocus
          />
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={() => { setRenameModalOpen(false); }}>Cancel</button>
          <button className="modal-btn modal-btn-confirm" onClick={handleRename}>
            <span className="btn-text">Rename</span>
            <span className="btn-loader" />
          </button>
        </div>
      </Modal>

      <Modal open={pointDeleteModalOpen} onClose={() => { setPointDeleteModalOpen(false); setPointToDelete(null); }}>
        <div className="modal-header">
          <X size={24} />
          <h3>Delete Data Point</h3>
        </div>
        <div className="modal-body">
          <p>Do you want to delete this specific data point?</p>
          {pointToDelete && (
            <div style={{ background: 'var(--bg-secondary)', padding: 15, borderRadius: 8, margin: '15px 0', border: '1px solid var(--bg-tertiary)' }}>
              <div className="tooltip-row">
                <span className="tooltip-label">Speed:</span>
                <span className="tooltip-value">{(convertSpeed(pointToDelete.speed) ?? 0).toFixed(1)} {speedUnit}</span>
              </div>
              <div className="tooltip-row"><span className="tooltip-label">Time:</span><span className="tooltip-value">{formatTime(pointToDelete.time, pointToDelete.startTime)}</span></div>
              <div className="tooltip-row"><span className="tooltip-label">Index:</span><span className="tooltip-value">#{pointToDelete.index}</span></div>
            </div>
          )}
          <p style={{ fontSize: '0.85em', color: 'var(--accent-danger)' }}>Warning: This will recalculate top speed and average speed.</p>
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={() => { setPointDeleteModalOpen(false); setPointToDelete(null); }}>Cancel</button>
          <button className="modal-btn modal-btn-delete" onClick={handleDeletePoint}>
            <span className="btn-text">Delete Point</span>
            <span className="btn-loader" />
          </button>
        </div>
      </Modal>
    </div>
  );
}
