import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getTileUrl, getChartColors } from '../utils/mapUtils';

const ThemeContext = createContext();
const THEME_TRANSITION_DURATION_MS = 250;

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const hasMountedRef = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    const prefersReducedMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    const shouldAnimate = hasMountedRef.current && !prefersReducedMotion;

    if (shouldAnimate) {
      root.classList.add('theme-transition');
    }

    root.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);

    hasMountedRef.current = true;

    if (!shouldAnimate) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      root.classList.remove('theme-transition');
    }, THEME_TRANSITION_DURATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
      root.classList.remove('theme-transition');
    };
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  }, []);

  const tileUrl = getTileUrl(theme);
  const chartColors = getChartColors(theme);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, tileUrl, chartColors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
