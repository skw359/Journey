import { useLocation, Link } from 'react-router-dom';
import { Search, User } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLoadingContext } from '../context/LoadingContext';
import './Header.css';

const NAV_LINKS = [
  { to: '/journeys', label: 'Dashboard' },
  { to: '/topjourneys', label: 'Top Journeys' },
  { to: '/atlas', label: 'Atlas' },
  { to: '/recently-deleted', label: 'Recently Deleted' },
  { to: '/funstats', label: 'Fun Stats' },
];

export default function Header({ onToggleSidebar, showSearch, searchValue, onSearchChange }) {
  const location = useLocation();
  const { user, logout, marcoEnabled } = useAuth();
  const { isLoading: dataLoading } = useLoadingContext();
  const searchRef = useRef(null);
  const closeProfileMenuTimeoutRef = useRef(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const canToggleSidebar = typeof onToggleSidebar === 'function';
  const navLinks = marcoEnabled
    ? [...NAV_LINKS, { to: '/marco', label: 'Marco' }]
    : NAV_LINKS;

  useEffect(() => {
    if (closeProfileMenuTimeoutRef.current) {
      clearTimeout(closeProfileMenuTimeoutRef.current);
      closeProfileMenuTimeoutRef.current = null;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close the menu on navigation
    setProfileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => () => {
    if (closeProfileMenuTimeoutRef.current) {
      clearTimeout(closeProfileMenuTimeoutRef.current);
      closeProfileMenuTimeoutRef.current = null;
    }
  }, []);

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Escape') {
      onSearchChange?.('');
      searchRef.current?.blur();
    }
  };

  const handleProfileMenuBlur = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      if (closeProfileMenuTimeoutRef.current) {
        clearTimeout(closeProfileMenuTimeoutRef.current);
        closeProfileMenuTimeoutRef.current = null;
      }
      setProfileMenuOpen(false);
    }
  };

  const handleProfileMenuKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (closeProfileMenuTimeoutRef.current) {
        clearTimeout(closeProfileMenuTimeoutRef.current);
        closeProfileMenuTimeoutRef.current = null;
      }
      setProfileMenuOpen(false);
    }
  };

  const handleProfileMenuMouseEnter = () => {
    if (closeProfileMenuTimeoutRef.current) {
      clearTimeout(closeProfileMenuTimeoutRef.current);
      closeProfileMenuTimeoutRef.current = null;
    }
    setProfileMenuOpen(true);
  };

  const handleProfileMenuMouseLeave = () => {
    if (closeProfileMenuTimeoutRef.current) {
      clearTimeout(closeProfileMenuTimeoutRef.current);
    }
    closeProfileMenuTimeoutRef.current = setTimeout(() => {
      setProfileMenuOpen(false);
      closeProfileMenuTimeoutRef.current = null;
    }, 180);
  };

  return (
    <header className="app-navbar">
      <div className="header-left-group">
        <div
          className="brand-container"
          onClick={canToggleSidebar ? onToggleSidebar : undefined}
          title={canToggleSidebar ? 'Toggle Sidebar' : undefined}
          style={canToggleSidebar ? { cursor: 'pointer' } : undefined}
        >
          <div className="brand-icon">
            <img src="/logo.png" alt="Journey" width={24} height={24} />
          </div>
          <span className="brand-text">Journey</span>
        </div>

        <div className="header-separator" />

        <nav className="header-nav">
          {navLinks.map(link => (
            <Link
              key={link.to}
              to={link.to}
              className={`nav-link${location.pathname === link.to ? ' active' : ''}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="header-actions">
        {showSearch && (
          <div className="search-container">
            <input
              ref={searchRef}
              type="text"
              id="journey-search"
              className={searchFocused ? 'focused' : ''}
              placeholder="Name or date…"
              autoComplete="off"
              value={searchValue || ''}
              onChange={(e) => onSearchChange?.(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={handleSearchKeyDown}
            />
            <Search className="search-icon" size={16} />
          </div>
        )}

        {dataLoading && (
          <div className="header-loading-indicator">
            <div className="header-loading-spinner" />
            <span className="header-loading-text">Loading…</span>
          </div>
        )}

        <div
          className={`header-profile-menu${profileMenuOpen ? ' open' : ''}`}
          onMouseEnter={handleProfileMenuMouseEnter}
          onMouseLeave={handleProfileMenuMouseLeave}
          onFocusCapture={handleProfileMenuMouseEnter}
          onBlurCapture={handleProfileMenuBlur}
          onKeyDown={handleProfileMenuKeyDown}
        >
          <Link
            className={`header-avatar-link${location.pathname === '/settings' ? ' active' : ''}`}
            to="/settings"
            title="Settings"
            aria-label="Settings"
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
            onClick={() => {
              if (closeProfileMenuTimeoutRef.current) {
                clearTimeout(closeProfileMenuTimeoutRef.current);
                closeProfileMenuTimeoutRef.current = null;
              }
              setProfileMenuOpen(false);
            }}
          >
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="header-avatar-img" />
            ) : (
              <span className="header-avatar-fallback">
                <User size={18} />
              </span>
            )}
          </Link>

          <div className="header-profile-dropdown" role="menu" aria-label="Profile actions">
            <Link
              className={`header-profile-dropdown-item${location.pathname === '/settings' ? ' active' : ''}`}
              to="/settings"
              role="menuitem"
              onClick={() => {
                if (closeProfileMenuTimeoutRef.current) {
                  clearTimeout(closeProfileMenuTimeoutRef.current);
                  closeProfileMenuTimeoutRef.current = null;
                }
                setProfileMenuOpen(false);
              }}
            >
              Settings
            </Link>
            <button
              type="button"
              className="header-profile-dropdown-item"
              onClick={() => {
                if (closeProfileMenuTimeoutRef.current) {
                  clearTimeout(closeProfileMenuTimeoutRef.current);
                  closeProfileMenuTimeoutRef.current = null;
                }
                setProfileMenuOpen(false);
                logout();
              }}
              role="menuitem"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
