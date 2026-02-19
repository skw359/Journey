import { useState, useEffect, useRef, useCallback } from 'react';
import TopLoader from '../components/TopLoader';
import Sidebar from '../components/Sidebar';
import FilterBar from '../components/FilterBar';
import RouteMap from '../components/RouteMap';
import StatsGrid from '../components/StatsGrid';
import ElevationChart from '../components/ElevationChart';
import SpeedChart from '../components/SpeedChart';
import AccelerationChart from '../components/AccelerationChart';
import TravelModeBadge from '../components/TravelModeBadge';
import FirstRunOnboarding from '../components/FirstRunOnboarding';
import { fetchRoutes, fetchRouteDetail } from '../api/journeys';
import { showLargeRouteWarning } from '../utils/largeRouteWarning';
import { useToast } from '../context/ToastContext';
import './TopJourneys.css';

const PREVIEW_MAX_POINTS = 100;
const DETAIL_ZOOM_THRESHOLD = 8;

function parseDuration(durationStr) {
  const match = durationStr?.match(/(\d+)h\s*(\d+)m/);
  return match ? parseInt(match[1]) * 60 + parseInt(match[2]) : 0;
}

function getRankBadgeClass(rank) {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  return 'default';
}

export default function TopJourneys({ sidebarCollapsed = false }) {
  const toast = useToast();
  const [allRoutes, setAllRoutes] = useState([]);
  const [currentRoute, setCurrentRoute] = useState(null);
  const [currentRouteId, setCurrentRouteId] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [activeSort, setActiveSort] = useState('distance');
  const [isLoading, setIsLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const loaderRef = useRef(null);
  const currentRouteIdRef = useRef(currentRouteId);
  const routeCacheRef = useRef(new Map());
  const fullDetailRouteIdsRef = useRef(new Set());
  const detailFetchInFlightRef = useRef(new Set());
  const selectionSeqRef = useRef(0);
  const toastInfoRef = useRef(toast.info);

  useEffect(() => {
    currentRouteIdRef.current = currentRouteId;
  }, [currentRouteId]);

  useEffect(() => {
    toastInfoRef.current = toast.info;
  }, [toast.info]);

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

      routeCacheRef.current.set(routeId, route);
      setCurrentRoute(route);
      setCurrentRouteId(routeId);
      if (route.isFullResolution) fullDetailRouteIdsRef.current.add(routeId);
      else fullDetailRouteIdsRef.current.delete(routeId);

      const pointCount = route.totalPoints ?? route.coordinates?.length ?? 0;
      if (pointCount > 5000) {
        showLargeRouteWarning(toastInfoRef.current);
      }
    } catch (err) {
      console.error(err);
    } finally {
      if (requestSeq === selectionSeqRef.current) {
        loaderRef.current?.finish();
        setIsLoading(false);
      }
    }
  }, []);

  const loadFullDetailForViewport = useCallback(async ({ zoom }) => {
    const routeId = currentRouteIdRef.current;
    if (!routeId || zoom < DETAIL_ZOOM_THRESHOLD) return;
    if (fullDetailRouteIdsRef.current.has(routeId)) return;
    if (detailFetchInFlightRef.current.has(routeId)) return;

    detailFetchInFlightRef.current.add(routeId);
    try {
      const route = await fetchRouteDetail(routeId, { maxPoints: 0 });
      routeCacheRef.current.set(routeId, route);
      fullDetailRouteIdsRef.current.add(routeId);
      setCurrentRoute(prev => {
        if (!prev || prev.id !== routeId) return prev;
        return route;
      });
    } catch (err) {
      console.error('Failed to load full route detail:', err);
    } finally {
      detailFetchInFlightRef.current.delete(routeId);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const routes = await fetchRoutes();
        setAllRoutes(routes);

        if (currentRouteIdRef.current) return;

        const sorted = [...routes].sort((a, b) => parseFloat(b.distance) - parseFloat(a.distance));
        if (sorted.length > 0) {
          await loadRouteWithAnimation(sorted[0].id);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setInitialLoading(false);
      }
    };

    load();
  }, [loadRouteWithAnimation]);

  const sortedRoutes = allRoutes
    .filter(r => activeFilter === 'all' || r.travelMode === activeFilter)
    .sort((a, b) => {
      switch (activeSort) {
        case 'distance': return parseFloat(b.distance) - parseFloat(a.distance);
        case 'duration': return parseDuration(b.duration) - parseDuration(a.duration);
        case 'topSpeed': return parseFloat(b.avgSpeed || 0) - parseFloat(a.avgSpeed || 0);
        default: return parseFloat(b.distance) - parseFloat(a.distance);
      }
    });
  const hasAnyRoutes = allRoutes.length > 0;
  const showOnboardingEmptyState = !initialLoading && !hasAnyRoutes;
  const showFilteredEmptyState = hasAnyRoutes && sortedRoutes.length === 0;

  return (
    <div id="main-app" className="topjourneys-page">
      <TopLoader ref={loaderRef} />

      <div className="full-screen-container">
        {!showOnboardingEmptyState && (
          <Sidebar collapsed={sidebarCollapsed}>
            {hasAnyRoutes && <FilterBar active={activeFilter} onChange={setActiveFilter} />}
            {hasAnyRoutes && (
              <div className="sort-options">
                {['distance', 'duration', 'topSpeed'].map(s => (
                  <button
                    key={s}
                    className={`sort-btn${activeSort === s ? ' active' : ''}`}
                    onClick={() => setActiveSort(s)}
                  >
                    {s === 'distance' ? 'Distance' : s === 'duration' ? 'Duration' : 'Top Speed'}
                  </button>
                ))}
              </div>
            )}
            <div style={{ overflowY: 'auto', flexGrow: 1 }}>
              {showFilteredEmptyState ? (
                <p className="topjourneys-empty-filter">No journeys match your current filter.</p>
              ) : (
                sortedRoutes.map((route, index) => {
                  const rank = index + 1;
                  return (
                    <div
                      key={route.id}
                      className={`route-card${route.id === currentRouteId ? ' active' : ''}`}
                      onClick={() => loadRouteWithAnimation(route.id)}
                    >
                      <div className={`rank-badge ${getRankBadgeClass(rank)}`}>{rank}</div>
                      <div className="route-card-content">
                        <div className="route-card-name">{route.name}</div>
                        <div className="route-card-stats">
                          <span className="route-card-stat"><strong>{parseFloat(route.distance).toFixed(1)}</strong> mi</span>
                          <span className="route-card-stat"><strong>{route.duration}</strong></span>
                        </div>
                        <div className="route-card-badges">
                          <TravelModeBadge mode={route.travelMode || 'foot'} variant="topjourneys" />
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Sidebar>
        )}

        <main className={`details-view-container${showOnboardingEmptyState ? ' onboarding-layout' : ''}`}>
          {currentRoute && (
            <div className={`details-header${isLoading ? ' fade-out' : ''}`}>
              <h2>{currentRoute.name}</h2>
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
                    <ElevationChart route={currentRoute} />
                    <SpeedChart route={currentRoute} />
                    <AccelerationChart route={currentRoute} />
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
