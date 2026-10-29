import { useState, useEffect, useRef, useCallback } from 'react';
import TopLoader from '../components/TopLoader';
import Sidebar from '../components/Sidebar';
import FilterBar from '../components/FilterBar';
import JourneyCard from '../components/JourneyCard';
import RouteMap from '../components/RouteMap';
import JourneyTopOverlay from '../components/JourneyTopOverlay';
import JourneyStage from '../components/JourneyStage';
import JourneyDetails from '../components/JourneyDetails';
import FirstRunOnboarding from '../components/FirstRunOnboarding';
import { fetchRoutes, fetchRouteDetail } from '../api/journeys';
import useGeoLabel from '../hooks/useGeoLabel';
import './TopJourneys.css';

const PREVIEW_MAX_POINTS = 100;
const DETAIL_ZOOM_THRESHOLD = 8;

function parseDuration(durationStr) {
  const match = durationStr?.match(/(\d+)h\s*(\d+)m/);
  return match ? parseInt(match[1]) * 60 + parseInt(match[2]) : 0;
}

export default function TopJourneys({ sidebarCollapsed = false }) {
  const [allRoutes, setAllRoutes] = useState([]);
  const [currentRoute, setCurrentRoute] = useState(null);
  const [currentRouteId, setCurrentRouteId] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [activeSort, setActiveSort] = useState('distance');
  const [isLoading, setIsLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [measureActive, setMeasureActive] = useState(false);
  const loaderRef = useRef(null);
  const currentRouteIdRef = useRef(currentRouteId);
  const routeCacheRef = useRef(new Map());
  const fullDetailRouteIdsRef = useRef(new Set());
  const detailFetchInFlightRef = useRef(new Set());
  const selectionSeqRef = useRef(0);
  const { label: geoLabel, loading: geoLoading } = useGeoLabel(currentRoute);

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

      routeCacheRef.current.set(routeId, route);
      setCurrentRoute(route);
      setCurrentRouteId(routeId);
      if (route.isFullResolution) fullDetailRouteIdsRef.current.add(routeId);
      else fullDetailRouteIdsRef.current.delete(routeId);
    } catch (err) {
      console.error(err);
    } finally {
      if (requestSeq === selectionSeqRef.current) {
        loaderRef.current?.finish();
        setIsLoading(false);
      }
    }
  }, []);

  const loadFullDetail = useCallback(async (routeId) => {
    if (!routeId) return;
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
      const shouldPreload = localStorage.getItem('preloadData') === 'true';
      try {
        const routes = await fetchRoutes();
        setAllRoutes(routes);

        if (currentRouteIdRef.current) return;

        const sorted = [...routes].sort((a, b) => parseFloat(b.distance) - parseFloat(a.distance));
        if (sorted.length > 0) {
          const topRoute = await fetchRouteDetail(sorted[0].id, { maxPoints: shouldPreload ? 0 : PREVIEW_MAX_POINTS });
          routeCacheRef.current.set(topRoute.id, topRoute);
          if (topRoute.isFullResolution) fullDetailRouteIdsRef.current.add(topRoute.id);
          setCurrentRoute(topRoute);
          setCurrentRouteId(sorted[0].id);

          if (shouldPreload && sorted.length > 1) {
            const remaining = sorted.slice(1);
            Promise.all(
              remaining.map(r => fetchRouteDetail(r.id, { maxPoints: 0 }))
            ).then(details => {
              details.forEach(route => {
                routeCacheRef.current.set(route.id, route);
                if (route.isFullResolution) fullDetailRouteIdsRef.current.add(route.id);
              });
            }).catch(err => console.error('Failed to preload routes:', err));
          }
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
    <div id="main-app">
      <TopLoader ref={loaderRef} />

      <div className="full-screen-container">
        {!showOnboardingEmptyState && (
          <Sidebar collapsed={sidebarCollapsed} floating>
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
            <div className="route-list" style={{ overflowY: 'auto', flexGrow: 1 }}>
              {showFilteredEmptyState ? (
                <p className="topjourneys-empty-filter">No journeys match your current filter.</p>
              ) : (
                sortedRoutes.map((route, index) => (
                  <JourneyCard
                    key={route.id}
                    route={route}
                    rank={index + 1}
                    active={route.id === currentRouteId}
                    onClick={(id) => loadRouteWithAnimation(id)}
                  />
                ))
              )}
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
    </div>
  );
}
