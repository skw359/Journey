import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Header from './components/Header';

const loadDashboard = () => import('./pages/Dashboard');
const loadTopJourneys = () => import('./pages/TopJourneys');
const loadAtlas = () => import('./pages/Atlas');
const loadApiDocs = () => import('./pages/ApiDocs');
const loadSettings = () => import('./pages/Settings');
const loadPairClient = () => import('./pages/PairClient');
const loadFunStats = () => import('./pages/FunStats');
const loadRecentlyDeleted = () => import('./pages/RecentlyDeleted');
const loadMarco = () => import('./pages/Marco');

const Dashboard = lazy(loadDashboard);
const TopJourneys = lazy(loadTopJourneys);
const Atlas = lazy(loadAtlas);
const ApiDocs = lazy(loadApiDocs);
const Settings = lazy(loadSettings);
const PairClient = lazy(loadPairClient);
const FunStats = lazy(loadFunStats);
const RecentlyDeleted = lazy(loadRecentlyDeleted);
const Marco = lazy(loadMarco);

const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const DataMigration = lazy(() => import('./pages/DataMigration'));

const PAGE_TRANSITION_MS = 200;

function getPageKey(location) {
  return location.pathname;
}

function getLocationKey(location) {
  return `${location.pathname}${location.search}${location.hash}`;
}

function getSidebarRouteKey(pathname) {
  switch (pathname) {
    case '/journeys':
      return 'journeys';
    case '/topjourneys':
      return 'topjourneys';
    case '/atlas':
      return 'atlas';
    case '/recently-deleted':
      return 'recentlyDeleted';
    default:
      return null;
  }
}

function preloadRoute(pathname) {
  switch (pathname) {
    case '/':
    case '/journeys':
      return loadDashboard();
    case '/topjourneys':
      return loadTopJourneys();
    case '/heatmap':
    case '/alltime':
    case '/atlas':
      return loadAtlas();
    case '/settings':
      return loadSettings();
    case '/api.html':
    case '/api-docs':
      return loadApiDocs();
    case '/pair':
      return loadPairClient();
    case '/funstats':
      return loadFunStats();
    case '/recently-deleted':
      return loadRecentlyDeleted();
    case '/marco':
      return loadMarco();
    default:
      return loadDashboard();
  }
}

export default function App() {
  const location = useLocation();
  const { isLoading, isSetup, isAuthenticated, needsMigration } = useAuth();
  const [displayLocation, setDisplayLocation] = useState(location);
  const [transitionState, setTransitionState] = useState('entered');
  const [searchValue, setSearchValue] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState({
    journeys: false,
    topjourneys: false,
    atlas: false,
    recentlyDeleted: false,
  });
  const exitTimeoutRef = useRef(null);
  const enterTimeoutRef = useRef(null);
  const transitionSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      if (exitTimeoutRef.current) {
        clearTimeout(exitTimeoutRef.current);
      }
      if (enterTimeoutRef.current) {
        clearTimeout(enterTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const currentPage = getPageKey(location);
    const displayedPage = getPageKey(displayLocation);
    if (currentPage === displayedPage) {
      if (getLocationKey(location) !== getLocationKey(displayLocation)) {
        setDisplayLocation(location);
      }
      return;
    }

    if (exitTimeoutRef.current) clearTimeout(exitTimeoutRef.current);
    if (enterTimeoutRef.current) clearTimeout(enterTimeoutRef.current);

    setTransitionState('exiting');
    const nextLocation = location;
    const transitionSeq = ++transitionSeqRef.current;

    exitTimeoutRef.current = setTimeout(async () => {
      try {
        await preloadRoute(nextLocation.pathname);
      } catch (error) {
        console.error('Failed to preload route chunk:', error);
      }
      if (transitionSeq !== transitionSeqRef.current) return;

      setDisplayLocation(nextLocation);
      setTransitionState('entering');
      exitTimeoutRef.current = null;

      enterTimeoutRef.current = setTimeout(() => {
        if (transitionSeq !== transitionSeqRef.current) return;
        setTransitionState('entered');
        enterTimeoutRef.current = null;
      }, PAGE_TRANSITION_MS);
    }, PAGE_TRANSITION_MS);
  }, [location, displayLocation]);

  // Auth gating - render without Header
  if (isLoading) {
    return (
      <div className="auth-loading">
        <div className="auth-spinner" />
      </div>
    );
  }

  if (!isSetup) {
    return (
      <Suspense fallback={null}>
        <Register />
      </Suspense>
    );
  }

  if (needsMigration) {
    return (
      <Suspense fallback={null}>
        <DataMigration />
      </Suspense>
    );
  }

  if (!isAuthenticated) {
    return (
      <Suspense fallback={null}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="*" element={<Login />} />
        </Routes>
      </Suspense>
    );
  }

  const displayedPath = getPageKey(displayLocation);
  const sidebarRouteKey = getSidebarRouteKey(displayedPath);
  const onToggleSidebar = sidebarRouteKey
    ? () => {
      setSidebarCollapsed(prev => ({ ...prev, [sidebarRouteKey]: !prev[sidebarRouteKey] }));
    }
    : undefined;

  const transitionClass = `route-transition-shell route-transition-${transitionState}${transitionState === 'entered' ? '' : ' route-transition-lock'}`;

  return (
    <div className={transitionClass}>
      <Header
        onToggleSidebar={onToggleSidebar}
        showSearch={displayedPath === '/journeys' || displayedPath === '/recently-deleted'}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
      />
      <div className="route-transition-stage">
        <Suspense fallback={null}>
          <div className="route-transition-content">
            <Routes location={displayLocation}>
              <Route path="/" element={<Navigate to="/journeys" replace />} />
              <Route
                path="/journeys"
                element={<Dashboard sidebarCollapsed={sidebarCollapsed.journeys} searchValue={searchValue} />}
              />
              <Route
                path="/topjourneys"
                element={<TopJourneys sidebarCollapsed={sidebarCollapsed.topjourneys} />}
              />
              <Route path="/heatmap" element={<Navigate to="/atlas?view=heatmap" replace />} />
              <Route path="/alltime" element={<Navigate to="/atlas" replace />} />
              <Route path="/atlas" element={<Atlas sidebarCollapsed={sidebarCollapsed.atlas} />} />
              <Route
                path="/recently-deleted"
                element={<RecentlyDeleted sidebarCollapsed={sidebarCollapsed.recentlyDeleted} searchValue={searchValue} />}
              />
              <Route path="/funstats" element={<FunStats />} />
              <Route path="/marco" element={<Marco />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/pair" element={<PairClient />} />
              <Route path="/api.html" element={<ApiDocs />} />
              <Route path="/api-docs" element={<ApiDocs />} />
              <Route path="*" element={<Navigate to="/journeys" replace />} />
            </Routes>
          </div>
        </Suspense>
        <div className="route-transition-backdrop" aria-hidden="true" />
      </div>
    </div>
  );
}
