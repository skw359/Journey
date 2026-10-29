import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { onLoadingChange } from '../api/apiFetch';

const LoadingContext = createContext(null);

const MIN_DISPLAY_MS = 800;
const LINGER_MS = 400;

export function LoadingProvider({ children }) {
  const [apiLoading, setApiLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const lingerTimerRef = useRef(null);
  const shownAtRef = useRef(0);

  useEffect(() => {
    return onLoadingChange(setApiLoading);
  }, []);

  useEffect(() => {
    if (apiLoading) {
      if (lingerTimerRef.current) {
        clearTimeout(lingerTimerRef.current);
        lingerTimerRef.current = null;
      }
      if (!visible) {
        shownAtRef.current = Date.now();
        // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors an external store with a min-display timer
        setVisible(true);
      }
    } else if (visible) {
      const elapsed = Date.now() - shownAtRef.current;
      const remaining = Math.max(MIN_DISPLAY_MS - elapsed, LINGER_MS);
      lingerTimerRef.current = setTimeout(() => {
        setVisible(false);
        lingerTimerRef.current = null;
      }, remaining);
    }
  }, [apiLoading, visible]);

  useEffect(() => {
    return () => {
      if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    };
  }, []);

  return (
    <LoadingContext.Provider value={{ isLoading: visible }}>
      {children}
    </LoadingContext.Provider>
  );
}

export function useLoadingContext() {
  const ctx = useContext(LoadingContext);
  if (!ctx) throw new Error('useLoadingContext must be used within LoadingProvider');
  return ctx;
}
