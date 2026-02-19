import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getTileUrl, getChartColors } from '../utils/mapUtils';

const ThemeContext = createContext();

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
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
