import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Trash2 } from 'lucide-react';
import TopLoader from '../components/TopLoader';
import Sidebar from '../components/Sidebar';
import FilterBar from '../components/FilterBar';
import JourneyCard from '../components/JourneyCard';
import RouteMap from '../components/RouteMap';
import Modal from '../components/Modal';
import JourneyTopOverlay from '../components/JourneyTopOverlay';
import JourneyStage from '../components/JourneyStage';
import JourneyDetails from '../components/JourneyDetails';
import DateSearchChip from '../components/DateSearchChip';
import {
  fetchTrash,
  fetchTrashDetail,
  restoreTrashedJourney,
  permanentlyDeleteTrashedJourney,
  emptyTrash,
} from '../api/journeys';
import { useToast } from '../context/ToastContext';
import useGeoLabel from '../hooks/useGeoLabel';
import { parseDateQuery, matchesSearch } from '../utils/dateSearch';
import './Dashboard.css';
import './RecentlyDeleted.css';

function originLabel(origin) {
  switch (origin) {
    case 'rejected_short': return 'Rejected: too short';
    case 'rejected_insufficient': return 'Rejected: not enough data';
    case 'user_deleted':
    default: return 'Deleted';
  }
}

function expiryLabel(expiresAt) {
  if (!expiresAt) return '';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Auto-deletes soon';
  const days = Math.ceil(ms / 86400000);
  return `Auto-deletes in ${days} day${days === 1 ? '' : 's'}`;
}

function describeTrash(meta) {
  if (!meta) return 'Deleted';
  const expiry = expiryLabel(meta.expiresAt);
  return expiry ? `${originLabel(meta.origin)} · ${expiry}` : originLabel(meta.origin);
}

export default function RecentlyDeleted({ sidebarCollapsed = false, searchValue = '' }) {
  const toast = useToast();
  const navigate = useNavigate();

  const [allTrash, setAllTrash] = useState([]);
  const [currentRoute, setCurrentRoute] = useState(null);
  const [currentTrashId, setCurrentTrashId] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [permaDeleteModalOpen, setPermaDeleteModalOpen] = useState(false);
  const [emptyModalOpen, setEmptyModalOpen] = useState(false);

  const loaderRef = useRef(null);
  const currentTrashIdRef = useRef(currentTrashId);
  const routeCacheRef = useRef(new Map());
  const selectionSeqRef = useRef(0);

  const { label: geoLabel, loading: geoLoading } = useGeoLabel(currentRoute);

  useEffect(() => {
    currentTrashIdRef.current = currentTrashId;
  }, [currentTrashId]);

  const loadTrashDetail = useCallback(async (trashId) => {
    if (trashId === currentTrashIdRef.current) return;
    const requestSeq = ++selectionSeqRef.current;
    setIsLoading(true);
    loaderRef.current?.start();

    await new Promise(r => setTimeout(r, 250));

    try {
      const cached = routeCacheRef.current.get(trashId);
      const detail = cached || await fetchTrashDetail(trashId);
      if (requestSeq !== selectionSeqRef.current) return;

      routeCacheRef.current.set(trashId, detail);
      setCurrentRoute(detail);
      setCurrentTrashId(trashId);
    } catch (err) {
      console.error(err);
      toast.error('Failed to load journey');
    } finally {
      if (requestSeq === selectionSeqRef.current) {
        loaderRef.current?.finish();
        setIsLoading(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    const load = async () => {
      try {
        const items = await fetchTrash();
        setAllTrash(items);
        if (items.length > 0) {
          await loadTrashDetail(items[0].id);
        }
      } catch (err) {
        console.error('Failed to load Recently Deleted:', err);
        toast.error('Failed to load Recently Deleted');
      } finally {
        setInitialLoading(false);
      }
    };
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dateWindow = useMemo(() => parseDateQuery(searchValue), [searchValue]);

  const filteredTrash = useMemo(() => allTrash
    .filter(t => {
      const matchesFilter = activeFilter === 'all' || t.travelMode === activeFilter;
      return matchesFilter && matchesSearch(t, searchValue, dateWindow);
    })
    .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt)),
  [allTrash, activeFilter, searchValue, dateWindow]);

  const hasAny = allTrash.length > 0;
  const showEmptyState = !initialLoading && !hasAny;
  const showFilteredEmptyState = hasAny && filteredTrash.length === 0;

  // After removing the current item, drop it from state/cache and select the next.
  const dropCurrentAndAdvance = (trashId) => {
    const remaining = allTrash.filter(t => t.id !== trashId);
    setAllTrash(remaining);
    routeCacheRef.current.delete(trashId);
    if (remaining.length > 0) {
      loadTrashDetail(remaining[0].id);
    } else {
      setCurrentRoute(null);
      setCurrentTrashId(null);
    }
    return remaining;
  };

  const handleRestore = async () => {
    if (!currentTrashId) return;
    const trashId = currentTrashId;
    const routeId = currentRoute?.routeId || allTrash.find(t => t.id === trashId)?.routeId;
    dropCurrentAndAdvance(trashId);

    try {
      const tid = toast.loading('Restoring journey...');
      await restoreTrashedJourney(trashId);
      toast.dismiss(tid);
      toast.success('Journey restored', undefined, routeId ? {
        actionLabel: 'View',
        onAction: () => navigate(`/journeys?routeId=${routeId}`),
      } : undefined);
    } catch (err) {
      console.error(err);
      toast.error('Failed to restore journey: ' + err.message);
      try { setAllTrash(await fetchTrash()); } catch { /* ignore refresh failure */ }
    }
  };

  const handlePermanentDelete = async () => {
    if (!currentTrashId) return;
    const trashId = currentTrashId;
    setPermaDeleteModalOpen(false);
    dropCurrentAndAdvance(trashId);

    try {
      const tid = toast.loading('Deleting permanently...');
      await permanentlyDeleteTrashedJourney(trashId);
      toast.dismiss(tid);
      toast.success('Journey permanently deleted');
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete journey: ' + err.message);
      try { setAllTrash(await fetchTrash()); } catch { /* ignore refresh failure */ }
    }
  };

  const handleEmptyTrash = async () => {
    setEmptyModalOpen(false);
    const had = allTrash.length;
    setAllTrash([]);
    setCurrentRoute(null);
    setCurrentTrashId(null);
    routeCacheRef.current.clear();

    try {
      const tid = toast.loading('Emptying Recently Deleted...');
      await emptyTrash();
      toast.dismiss(tid);
      toast.success(`Permanently deleted ${had} journey${had === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(err);
      toast.error('Failed to empty Recently Deleted: ' + err.message);
      try { setAllTrash(await fetchTrash()); } catch { /* ignore refresh failure */ }
    }
  };

  const trashNotice = describeTrash(currentRoute?.trash);

  return (
    <div id="main-app" className="trash-page">
      <TopLoader ref={loaderRef} />

      <div className="trash-banner">
        <Trash2 size={16} />
        <span className="trash-banner-text">
          Journeys are permanently removed 7 days after deletion.
        </span>
        {hasAny && (
          <button className="trash-empty-btn" onClick={() => setEmptyModalOpen(true)}>
            <Trash2 size={14} /> Empty Recently Deleted
          </button>
        )}
      </div>

      <div className="full-screen-container">
        {!showEmptyState && (
          <Sidebar collapsed={sidebarCollapsed} floating>
            {hasAny && <FilterBar active={activeFilter} onChange={setActiveFilter} />}
            <DateSearchChip dateWindow={dateWindow} count={filteredTrash.length} />
            <div className="route-list" style={{ overflowY: 'auto', flexGrow: 1 }}>
              {showFilteredEmptyState ? (
                <p className="dashboard-empty-filter">
                  {dateWindow
                    ? `No deleted journeys found for ${dateWindow.label}.`
                    : 'No matching deleted journeys could be found with the current search parameters.'}
                </p>
              ) : (
                filteredTrash.map(item => (
                  <JourneyCard
                    key={item.id}
                    route={item}
                    active={item.id === currentTrashId}
                    onClick={(id) => loadTrashDetail(id)}
                    note={describeTrash(item)}
                  />
                ))
              )}
            </div>
          </Sidebar>
        )}

        <main className={`details-view-container${showEmptyState ? ' onboarding-layout' : ''}${currentRoute && !showEmptyState ? ' fullscreen-map' : ''}`}>
          {showEmptyState ? (
            <section className="main-content empty-onboarding">
              <div className="trash-empty-state">
                <Trash2 size={48} />
                <h2>Recently Deleted is empty</h2>
              </div>
            </section>
          ) : currentRoute && (
            <JourneyStage
              routeId={currentRoute.id}
              loading={isLoading}
              sidebarCollapsed={sidebarCollapsed}
              hero={(
                <>
                  <RouteMap
                    route={currentRoute}
                    sidebarCollapsed={sidebarCollapsed}
                    weather={currentRoute.weather}
                    fullscreen
                  />

                  <JourneyTopOverlay
                    route={currentRoute}
                    geoLabel={geoLabel}
                    geoLoading={geoLoading}
                    trashNotice={trashNotice}
                    onRestore={handleRestore}
                    onPermanentDelete={() => setPermaDeleteModalOpen(true)}
                  />
                </>
              )}
            >
              <JourneyDetails
                route={currentRoute}
                showPhotos={false}
              />
            </JourneyStage>
          )}
        </main>
      </div>

      <Modal open={permaDeleteModalOpen} onClose={() => setPermaDeleteModalOpen(false)}>
        <div className="modal-header">
          <AlertCircle size={24} />
          <h3>Delete Permanently</h3>
        </div>
        <div className="modal-body">
          <p>Are you sure you want to permanently delete this journey?</p>
          <div className="modal-route-name">&quot;{currentRoute?.name}&quot;</div>
          <p>This action cannot be undone.</p>
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={() => setPermaDeleteModalOpen(false)}>Cancel</button>
          <button className="modal-btn modal-btn-delete" onClick={handlePermanentDelete}>Delete Permanently</button>
        </div>
      </Modal>

      <Modal open={emptyModalOpen} onClose={() => setEmptyModalOpen(false)}>
        <div className="modal-header">
          <AlertCircle size={24} />
          <h3>Empty Recently Deleted</h3>
        </div>
        <div className="modal-body">
          <p>Permanently delete all {allTrash.length} journey{allTrash.length === 1 ? '' : 's'} in Recently Deleted?</p>
          <p>This action cannot be undone.</p>
        </div>
        <div className="modal-buttons">
          <button className="modal-btn modal-btn-cancel" onClick={() => setEmptyModalOpen(false)}>Cancel</button>
          <button className="modal-btn modal-btn-delete" onClick={handleEmptyTrash}>Empty Recently Deleted</button>
        </div>
      </Modal>
    </div>
  );
}
