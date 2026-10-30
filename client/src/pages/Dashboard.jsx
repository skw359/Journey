import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Pencil, AlertCircle, X, Merge, Plane } from 'lucide-react';
import TopLoader from '../components/TopLoader';
import Sidebar from '../components/Sidebar';
import FilterBar from '../components/FilterBar';
import JourneyCard from '../components/JourneyCard';
import RouteMap from '../components/RouteMap';
import PhotoViewer from '../components/PhotoViewer';
import Modal from '../components/Modal';
import FirstRunOnboarding from '../components/FirstRunOnboarding';
import JourneyTopOverlay from '../components/JourneyTopOverlay';
import JourneyStage from '../components/JourneyStage';
import JourneyDetails from '../components/JourneyDetails';
import FlightImportModal from '../components/FlightImportModal';
import DateSearchChip from '../components/DateSearchChip';
import { fetchRoutes, fetchRouteDetail, fetchRouteMedia, deleteRoute, renameRoute, updateTravelMode as apiUpdateTravelMode, uploadPhotos as apiUploadPhotos, deletePhoto as apiDeletePhoto, deleteDataPoint, combineJourneys, undoCombine } from '../api/journeys';
import { createLruCache, ROUTE_CACHE_LIMITS } from '../utils/lruCache';
import { formatTime } from '../utils/formatters';
import { isVideo, isViewable, previewFilename, coverFilename, describeFiles, describeMedia } from '../utils/media';
import { parseDateQuery, matchesSearch } from '../utils/dateSearch';
import { useToast } from '../context/ToastContext';
import { useUnits } from '../context/UnitsContext';
import useGeoLabel from '../hooks/useGeoLabel';
import './Dashboard.css';

const PREVIEW_MAX_POINTS = 100;
const DETAIL_ZOOM_THRESHOLD = 8;
// The journey list draws this many cards, and this many more each time it's
// scrolled to the end. Drawing every journey at once made each click on one
// re-render thousands of cards.
const LIST_PAGE_SIZE = 20;

// Upload toast suffix for whatever the server is still converting.
function processingNote(added) {
  const pending = added.filter(p => p.status === 'processing');
  const videos = pending.filter(isVideo).length;
  const photos = pending.length - videos;
  if (photos && videos) return ". They'll be ready soon";
  if (photos) return `. ${added.length === 1 ? 'It' : 'Photos'} will be ready in a moment`;
  if (videos) return '. Videos are being converted for playback';
  return '';
}

export default function Dashboard({ sidebarCollapsed = false, searchValue = '' }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { convertSpeed, speedUnit } = useUnits();
  const [searchParams, setSearchParams] = useSearchParams();
  const [allRoutes, setAllRoutes] = useState([]);
  const [currentRoute, setCurrentRoute] = useState(null);
  const [currentRouteId, setCurrentRouteId] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [measureActive, setMeasureActive] = useState(false);

  const [photoViewerOpen, setPhotoViewerOpen] = useState(false);
  // Tracked by id: the viewable list shifts when a video finishes processing.
  const [viewerMediaId, setViewerMediaId] = useState(null);

  const [uploading, setUploading] = useState(false);
  const [uploadLabel, setUploadLabel] = useState('');
  const [uploadProgress, setUploadProgress] = useState(null);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePhotoModalOpen, setDeletePhotoModalOpen] = useState(false);
  const [photoToDelete, setPhotoToDelete] = useState(null);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [pointDeleteModalOpen, setPointDeleteModalOpen] = useState(false);
  const [pointToDelete, setPointToDelete] = useState(null);

  const [travelModeDropdownOpen, setTravelModeDropdownOpen] = useState(false);

  // Combine mode
  const [combineMode, setCombineMode] = useState(false);
  const [selectedForCombine, setSelectedForCombine] = useState(new Set());
  const [combineModalOpen, setCombineModalOpen] = useState(false);
  const [combineNameValue, setCombineNameValue] = useState('');
  const [lastCombinedId, setLastCombinedId] = useState(null);
  const [flightImportOpen, setFlightImportOpen] = useState(false);

  const loaderRef = useRef(null);
  const listRef = useRef(null);
  const listEndRef = useRef(null);
  const currentRouteIdRef = useRef(currentRouteId);
  const fullDetailRouteIdsRef = useRef(new Set());
  const routeCacheRef = useRef(null);
  if (!routeCacheRef.current) {
    routeCacheRef.current = createLruCache({
      ...ROUTE_CACHE_LIMITS,
      onEvict: (id) => fullDetailRouteIdsRef.current.delete(id),
    });
  }
  const detailFetchInFlightRef = useRef(new Set());
  const selectionSeqRef = useRef(0);

  const { label: geoLabel, loading: geoLoading } = useGeoLabel(currentRoute);

  const cacheRouteDetail = useCallback((route) => {
    if (!route?.id) return;
    routeCacheRef.current.set(route.id, route);
    if (route.isFullResolution) fullDetailRouteIdsRef.current.add(route.id);
    else fullDetailRouteIdsRef.current.delete(route.id);
  }, []);

  // The journey list shows each journey's first photo (or converted video's poster);
  // keep it in step with uploads and deletes made here.
  const syncCoverPhoto = useCallback((routeId, photos) => {
    const coverPhoto = coverFilename(photos);
    setAllRoutes(prev => prev.map(r => (
      r.id === routeId && (r.coverPhoto ?? null) !== coverPhoto ? { ...r, coverPhoto } : r
    )));
  }, []);

  // Puts a journey's latest media list in its cached detail, its list card and, while it's open, on screen.
  const applyRouteMedia = useCallback((routeId, photos) => {
    const cached = routeCacheRef.current.get(routeId);
    if (cached) cacheRouteDetail({ ...cached, photos });
    setCurrentRoute(prev => (prev?.id === routeId ? { ...prev, photos } : prev));
    syncCoverPhoto(routeId, photos);
  }, [cacheRouteDetail, syncCoverPhoto]);

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
    } catch (err) {
      console.error(err);
    } finally {
      if (requestSeq === selectionSeqRef.current) {
        loaderRef.current?.finish();
        setIsLoading(false);
      }
    }
  }, [cacheRouteDetail]);

  const loadFullDetail = useCallback(async (routeId) => {
    if (!routeId) return;
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

  const loadFullDetailForViewport = useCallback(({ zoom }) => {
    if (zoom < DETAIL_ZOOM_THRESHOLD) return;
    loadFullDetail(currentRouteIdRef.current);
  }, [loadFullDetail]);

  // Measuring snaps to the recorded track, so it needs every point: the
  // 100-point preview would put A and B on shortcuts the journey never took.
  useEffect(() => {
    if (measureActive && currentRouteId) loadFullDetail(currentRouteId);
  }, [measureActive, currentRouteId, loadFullDetail]);

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

  const dateWindow = useMemo(() => parseDateQuery(searchValue), [searchValue]);

  const filteredRoutes = useMemo(() => allRoutes
    .filter(r => {
      const matchesFilter = activeFilter === 'all' || r.travelMode === activeFilter;
      return matchesFilter && matchesSearch(r, searchValue, dateWindow);
    })
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime)),
  [allRoutes, activeFilter, searchValue, dateWindow]);
  const hasAnyRoutes = allRoutes.length > 0;
  const showOnboardingEmptyState = !initialLoading && !hasAnyRoutes;
  const showFilteredEmptyState = hasAnyRoutes && filteredRoutes.length === 0;

  // How many of the filtered journeys the list draws; a new filter or search
  // starts again from the first page
  const listKey = `${activeFilter}\n${searchValue}`;
  const [listPage, setListPage] = useState({ key: listKey, count: LIST_PAGE_SIZE });
  if (listPage.key !== listKey) setListPage({ key: listKey, count: LIST_PAGE_SIZE });
  const visibleCount = listPage.key === listKey ? listPage.count : LIST_PAGE_SIZE;
  const visibleRoutes = useMemo(() => filteredRoutes.slice(0, visibleCount), [filteredRoutes, visibleCount]);
  const hasMoreRoutes = visibleCount < filteredRoutes.length;

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [listKey]);

  // Draws the next page once the end of the list scrolls into view. Runs again
  // after each page, so a list still too short to scroll keeps filling.
  useEffect(() => {
    const list = listRef.current;
    const end = listEndRef.current;
    if (!list || !end || sidebarCollapsed || !hasMoreRoutes) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setListPage(prev => ({ ...prev, count: prev.count + LIST_PAGE_SIZE }));
    }, { root: list, rootMargin: '0px 0px 200px 0px' });
    observer.observe(end);
    return () => observer.disconnect();
  }, [visibleCount, hasMoreRoutes, sidebarCollapsed]);

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
      const tid = toast.loading('Moving journey to Recently Deleted...');
      await deleteRoute(routeToDeleteId);
      toast.dismiss(tid);
      toast.success('Journey moved to Recently Deleted', undefined, {
        actionLabel: 'View',
        onAction: () => navigate('/recently-deleted'),
      });
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
    const label = describeFiles(files);
    setUploading(true);
    setUploadLabel(label);
    setUploadProgress(0);
    const tid = toast.loading(`Uploading ${label}...`);
    try {
      const result = await apiUploadPhotos(routeId, files, setUploadProgress);
      toast.dismiss(tid);
      const added = result.photos || [];
      if (added.length > 0) {
        toast.success(`${describeMedia(added)} uploaded${processingNote(added)}`);
      }
      for (const skipped of result.skipped || []) {
        toast.error(`${skipped.name}: ${skipped.reason}`);
      }
      // The new items show straight away; the poll below swaps in converted ones as they finish.
      const cached = routeCacheRef.current.get(routeId);
      if (cached && added.length > 0) {
        applyRouteMedia(routeId, [...(cached.photos || []), ...added]);
      }
    } catch (err) {
      console.error(err);
      toast.dismiss(tid);
      toast.error(err.message || 'Upload failed');
    }
    setUploading(false);
    setUploadProgress(null);
  };

  // While uploads on the open journey are converting, poll their status and swap them in when done.
  const processing = (currentRoute?.photos || []).filter(p => p.status === 'processing');
  const processingIds = processing.map(p => p.id).join(',');
  // Photos take seconds to convert, videos minutes.
  const pollMs = processing.some(p => !isVideo(p)) ? 1000 : 4000;

  useEffect(() => {
    if (!currentRouteId || !processingIds) return;
    const routeId = currentRouteId;
    const pending = processingIds.split(',');
    const timer = setInterval(async () => {
      try {
        const media = await fetchRouteMedia(routeId);
        if (currentRouteIdRef.current !== routeId) return;
        const byId = new Map(media.map(p => [p.id, p]));
        const settled = pending.filter(id => byId.get(id)?.status !== 'processing');
        if (settled.length === 0) return;

        applyRouteMedia(routeId, media);
        // Converted photos just appear; only videos and failures get a toast.
        const done = settled.map(id => byId.get(id)).filter(Boolean);
        const count = (video, status) => done.filter(p => isVideo(p) === video && p.status === status).length;
        const readyVideos = count(true, 'ready');
        const failedVideos = count(true, 'failed');
        const failedPhotos = count(false, 'failed');
        if (readyVideos) toast.success(readyVideos === 1 ? 'Video ready to play' : `${readyVideos} videos ready to play`);
        if (failedVideos) toast.error(failedVideos === 1 ? "A video couldn't be converted" : `${failedVideos} videos couldn't be converted`);
        if (failedPhotos) toast.error(failedPhotos === 1 ? "A photo couldn't be processed" : `${failedPhotos} photos couldn't be processed`);
      } catch (err) {
        console.error(err);
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [currentRouteId, processingIds, pollMs, applyRouteMedia, toast]);

  const viewableMedia = (currentRoute?.photos || []).filter(isViewable);
  const viewerIndex = viewableMedia.findIndex(p => p.id === viewerMediaId);
  const deletePreview = previewFilename(photoToDelete);

  const handleDeletePhoto = async () => {
    if (!currentRouteId || !photoToDelete) return;
    
    const photoId = photoToDelete.id;
    const noun = isVideo(photoToDelete) ? 'video' : 'photo';
    const oldPhotos = [...(currentRoute.photos || [])];
    syncCoverPhoto(currentRouteId, oldPhotos.filter(p => p.id !== photoId));

    setCurrentRoute(prev => {
      if (!prev || prev.id !== currentRouteId) return prev;
      const updated = { ...prev, photos: prev.photos.filter(p => p.id !== photoId) };
      cacheRouteDetail(updated);
      return updated;
    });
    setDeletePhotoModalOpen(false);
    setPhotoToDelete(null);

    try {
      const tid = toast.loading(`Deleting ${noun}...`);
      await apiDeletePhoto(currentRouteId, photoId);
      toast.dismiss(tid);
      toast.success(noun === 'video' ? 'Video deleted' : 'Photo deleted');
    } catch (err) {
      console.error(err);
      toast.error(`Failed to delete ${noun}`);
      syncCoverPhoto(currentRouteId, oldPhotos);
      setCurrentRoute(prev => {
        if (!prev || prev.id !== currentRouteId) return prev;
        const reverted = { ...prev, photos: oldPhotos };
        cacheRouteDetail(reverted);
        return reverted;
      });
    }
  };

  // Stable, so the charts (which rebuild whenever it changes) aren't redrawn
  // by every unrelated re-render, such as the one that starts a journey switch
  const handlePointClick = useCallback((index, route) => {
    const speed = route.profileSpeedMph[index];
    const time = route.profileTimeMs[index];
    const startTime = route.profileTimeMs[0];
    setPointToDelete({ index, speed, time, startTime });
    setPointDeleteModalOpen(true);
  }, []);

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

  const toggleCombineSelection = useCallback((id) => {
    setSelectedForCombine(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Stable, so selecting a journey re-renders only the cards whose `active`
  // changed (JourneyCard is memoized)
  const handleCardClick = useCallback((id) => {
    if (combineMode) toggleCombineSelection(id);
    else loadRouteWithAnimation(id);
  }, [combineMode, toggleCombineSelection, loadRouteWithAnimation]);

  const handleOpenCombineModal = () => {
    if (selectedForCombine.size < 2) {
      toast.error('Select at least 2 journeys to combine');
      return;
    }
    // Default name: earliest journey's name
    const selected = allRoutes
      .filter(r => selectedForCombine.has(r.id))
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    setCombineNameValue(selected[0]?.name || '');
    setCombineModalOpen(true);
  };

  const handleCombine = async () => {
    const ids = allRoutes
      .filter(r => selectedForCombine.has(r.id))
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
      .map(r => r.id);

    setCombineModalOpen(false);
    setCombineMode(false);
    setSelectedForCombine(new Set());

    try {
      const tid = toast.loading(`Combining ${ids.length} journeys...`);
      const result = await combineJourneys(ids, combineNameValue.trim() || undefined);
      toast.dismiss(tid);
      toast.success('Journeys combined successfully');

      // Refresh journey list and select the combined journey
      const routes = await fetchRoutes();
      setAllRoutes(routes);
      routeCacheRef.current.clear();
      fullDetailRouteIdsRef.current.clear();
      setLastCombinedId(result.route.id);

      await loadRouteWithAnimation(result.route.id);
    } catch (err) {
      console.error(err);
      toast.error('Failed to combine: ' + err.message);
    }
  };

  const handleUndoCombine = async () => {
    if (!lastCombinedId) return;
    const tid = toast.loading('Undoing combine...');
    try {
      try {
        await undoCombine(lastCombinedId);
      } catch (err) {
        if (err.code !== 'edited_since_combine' || !window.confirm(`${err.message} Undo anyway?`)) throw err;
        await undoCombine(lastCombinedId, { force: true });
      }
      toast.dismiss(tid);
      toast.success('Combine undone — journeys restored');
      setLastCombinedId(null);

      // Refresh journey list
      const routes = await fetchRoutes();
      setAllRoutes(routes);
      routeCacheRef.current.clear();
      fullDetailRouteIdsRef.current.clear();

      const sorted = [...routes].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
      if (sorted.length > 0) {
        await loadRouteWithAnimation(sorted[0].id);
      } else {
        setCurrentRoute(null);
        setCurrentRouteId(null);
      }
    } catch (err) {
      console.error(err);
      toast.dismiss(tid);
      toast.error('Failed to undo combine: ' + err.message);
    }
  };

  return (
    <div id="main-app">
      <TopLoader ref={loaderRef} />

      <div className="full-screen-container">
        {!showOnboardingEmptyState && (
          <Sidebar collapsed={sidebarCollapsed} floating>
            {hasAnyRoutes && !combineMode && <FilterBar active={activeFilter} onChange={setActiveFilter} />}
            {!combineMode && activeFilter === 'flight' && (
              <button className="import-flight-btn" onClick={() => setFlightImportOpen(true)}>
                <Plane size={14} /> Import Flight
              </button>
            )}
            {!combineMode && <DateSearchChip dateWindow={dateWindow} count={filteredRoutes.length} />}
            {combineMode && (
              <div className="combine-toolbar">
                <span className="combine-toolbar-label">{selectedForCombine.size} selected</span>
                <button className="combine-toolbar-btn combine-toolbar-confirm" onClick={handleOpenCombineModal} disabled={selectedForCombine.size < 2}>
                  <Merge size={14} /> Combine
                </button>
                <button className="combine-toolbar-btn combine-toolbar-cancel" onClick={() => { setCombineMode(false); setSelectedForCombine(new Set()); }}>
                  Cancel
                </button>
              </div>
            )}
            <div ref={listRef} className="route-list" style={{ overflowY: 'auto', flexGrow: 1 }}>
              {showFilteredEmptyState ? (
                <p className="dashboard-empty-filter">
                  {dateWindow
                    ? `No journeys found for ${dateWindow.label}.`
                    : 'No matching journeys could be found with the current search parameters.'}
                </p>
              ) : (
                visibleRoutes.map(route => (
                  <div key={route.id} className={`combine-card-wrap${combineMode ? ' combine-mode' : ''}`}>
                    {combineMode && (
                      <input
                        type="checkbox"
                        className="combine-checkbox"
                        checked={selectedForCombine.has(route.id)}
                        onChange={() => toggleCombineSelection(route.id)}
                      />
                    )}
                    <JourneyCard
                      route={route}
                      active={!combineMode && route.id === currentRouteId}
                      onClick={handleCardClick}
                    />
                  </div>
                ))
              )}
              {hasMoreRoutes && <div ref={listEndRef} className="route-list-end" aria-hidden="true" />}
            </div>
          </Sidebar>
        )}

        <main className={`details-view-container${showOnboardingEmptyState ? ' onboarding-layout' : ''}${currentRoute && !showOnboardingEmptyState ? ' fullscreen-map' : ''}`}>

          {showOnboardingEmptyState ? (
            <section className="main-content empty-onboarding">
              <FirstRunOnboarding />
            </section>
          ) : currentRoute && (
            <JourneyStage
              routeId={currentRoute.id}
              loading={isLoading}
              sidebarCollapsed={sidebarCollapsed}
              measureActive={measureActive}
              hero={(
                <>
                  <RouteMap
                    route={currentRoute}
                    sidebarCollapsed={sidebarCollapsed}
                    onViewportChange={loadFullDetailForViewport}
                    weather={currentRoute.weather}
                    fullscreen
                    measureActive={measureActive}
                    onMeasureActiveChange={setMeasureActive}
                  />

                  <JourneyTopOverlay
                    route={currentRoute}
                    geoLabel={geoLabel}
                    geoLoading={geoLoading}
                    measureActive={measureActive}
                    onToggleMeasure={() => setMeasureActive(prev => !prev)}
                    travelModeDropdownOpen={travelModeDropdownOpen}
                    onToggleTravelModeDropdown={(e) => { e?.stopPropagation?.(); setTravelModeDropdownOpen(prev => !prev); }}
                    onUpdateTravelMode={handleUpdateTravelMode}
                    onRename={() => { setRenameValue(currentRoute.name); setRenameModalOpen(true); }}
                    onCombine={() => setCombineMode(true)}
                    onDelete={() => setDeleteModalOpen(true)}
                    onUndoCombine={handleUndoCombine}
                    showUndo={Boolean(lastCombinedId && currentRouteId === lastCombinedId)}
                  />
                </>
              )}
            >
              <JourneyDetails
                route={currentRoute}
                onPointClick={handlePointClick}
                uploading={uploading}
                uploadLabel={uploadLabel}
                uploadProgress={uploadProgress}
                onUpload={handleUploadPhotos}
                onDeletePhoto={(item) => {
                  setPhotoToDelete(item);
                  setDeletePhotoModalOpen(true);
                }}
                onViewPhoto={(id) => {
                  setViewerMediaId(id);
                  setPhotoViewerOpen(true);
                }}
              />
            </JourneyStage>
          )}
        </main>
      </div>

      <PhotoViewer
        photos={viewableMedia}
        currentIndex={viewerIndex}
        open={photoViewerOpen}
        onClose={() => setPhotoViewerOpen(false)}
        onNavigate={(index) => setViewerMediaId(viewableMedia[index]?.id ?? null)}
      />

      <Modal open={deleteModalOpen} onClose={() => setDeleteModalOpen(false)}>
        <div className="modal-header">
          <AlertCircle size={24} />
          <h3>Delete Journey</h3>
        </div>
        <div className="modal-body">
          <p>Are you sure you want to delete this journey?</p>
          <div className="modal-route-name">&quot;{currentRoute?.name}&quot;</div>
          <p>It will be moved to Recently Deleted and permanently removed after 7 days.</p>
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={() => setDeleteModalOpen(false)}>Cancel</button>
          <button className="modal-btn modal-btn-delete" onClick={handleDeleteJourney}>Delete</button>
        </div>
      </Modal>

      <Modal open={deletePhotoModalOpen} onClose={() => { setDeletePhotoModalOpen(false); }}>
        <div className="modal-header">
          <AlertCircle size={24} />
          <h3>Delete {isVideo(photoToDelete) ? 'Video' : 'Photo'}</h3>
        </div>
        <div className="modal-body">
          <p>Are you sure you want to permanently delete this {isVideo(photoToDelete) ? 'video' : 'photo'}? This action cannot be undone.</p>
          {deletePreview && (
            <div className="modal-photo-preview">
              <img src={`/photos/thumb/${deletePreview}`} alt="Preview" />
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

      <Modal open={combineModalOpen} onClose={() => setCombineModalOpen(false)}>
        <div className="modal-header rename-header">
          <Merge size={24} />
          <h3>Combine Journeys</h3>
        </div>
        <div className="modal-body">
          <p>The following {selectedForCombine.size} journeys will be merged into one, in chronological order:</p>
          <div className="combine-preview-list">
            {allRoutes
              .filter(r => selectedForCombine.has(r.id))
              .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
              .map((r, i) => (
                <div key={r.id} className="combine-preview-item">
                  <span className="combine-preview-num">{i + 1}.</span>
                  <span className="combine-preview-name">{r.name}</span>
                  <span className="combine-preview-meta">{r.distance} mi &bull; {r.duration}</span>
                </div>
              ))}
          </div>
          <p style={{ marginTop: 16 }}>Name for the combined journey:</p>
          <input
            type="text"
            className="modern-input"
            placeholder="Combined journey name..."
            autoComplete="off"
            value={combineNameValue}
            onChange={(e) => setCombineNameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCombine(); }}
            autoFocus
          />
          <p style={{ fontSize: '0.85em', color: 'var(--text-tertiary)', marginTop: 12 }}>
            A backup will be saved so you can undo this operation.
          </p>
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={() => setCombineModalOpen(false)}>Cancel</button>
          <button className="modal-btn modal-btn-confirm" onClick={handleCombine}>
            <span className="btn-text">Combine</span>
            <span className="btn-loader" />
          </button>
        </div>
      </Modal>

      <FlightImportModal
        open={flightImportOpen}
        onClose={() => setFlightImportOpen(false)}
        onImported={async (newRoute) => {
          setFlightImportOpen(false);
          const routes = await fetchRoutes();
          setAllRoutes(routes);
          routeCacheRef.current.clear();
          fullDetailRouteIdsRef.current.clear();
          await loadRouteWithAnimation(newRoute.id);
        }}
      />
    </div>
  );
}
