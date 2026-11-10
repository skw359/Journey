import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import * as authApi from '../api/auth';
import { onUnauthorized } from '../api/apiFetch';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSetup, setIsSetup] = useState(true);
  const [needsMigration, setNeedsMigration] = useState(false);
  const [migrationCount, setMigrationCount] = useState(0);
  const [marcoEnabled, setMarcoEnabled] = useState(false);
  const [registration, setRegistration] = useState('invite-only');
  // The session ended while the app was open, so the sign-in page can say why it appeared.
  const [sessionExpired, setSessionExpired] = useState(false);
  const signedInRef = useRef(false);

  const checkStatus = useCallback(async () => {
    try {
      const data = await authApi.getAuthStatus();
      setIsSetup(data.isSetup);
      setIsAuthenticated(data.isAuthenticated);
      setUser(data.user);
      setMarcoEnabled(Boolean(data.marcoEnabled));
      setRegistration(data.registration || (data.isSetup ? 'invite-only' : 'first-run'));
    } catch {
      setIsSetup(true);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    signedInRef.current = isAuthenticated;
  }, [isAuthenticated]);

  // A 401 while signed in: the session lapsed, or a password change ended it. A wrong password
  // also answers 401, so ask the server whether the session is really gone before acting.
  useEffect(() => {
    let asking = false;
    return onUnauthorized(async () => {
      if (asking || !signedInRef.current) return;
      asking = true;
      try {
        const data = await authApi.getAuthStatus();
        if (!data.isAuthenticated && signedInRef.current) {
          setUser(null);
          setIsAuthenticated(false);
          setIsSetup(data.isSetup);
          setSessionExpired(true);
        }
      } catch {
        // Offline: leave things as they are; the next request will ask again.
      } finally {
        asking = false;
      }
    });
  }, []);

  const login = useCallback(async (credentials) => {
    const data = await authApi.login(credentials);
    setUser(data.user);
    setIsAuthenticated(true);
    setIsSetup(true);
    setSessionExpired(false);
  }, []);

  const register = useCallback(async (credentials) => {
    const data = await authApi.register(credentials);
    setUser(data.user);
    setIsAuthenticated(true);
    setIsSetup(true);
    if (data.existingDataCount > 0) {
      setNeedsMigration(true);
      setMigrationCount(data.existingDataCount);
    }
  }, []);

  const doLogout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
    setIsAuthenticated(false);
  }, []);

  const removeAccount = useCallback(async (password) => {
    const data = await authApi.deleteAccount(password);
    setUser(null);
    setIsAuthenticated(false);
    setNeedsMigration(false);
    setMigrationCount(0);
    setIsSetup(Boolean(data.isSetup));
    setRegistration(data.isSetup ? 'invite-only' : 'first-run');
  }, []);

  const completeMigration = useCallback(async (doImport) => {
    if (doImport) {
      await authApi.migrateData();
    }
    setNeedsMigration(false);
    setMigrationCount(0);
  }, []);

  const updateUser = useCallback((updates) => {
    setUser(prev => prev ? { ...prev, ...updates } : prev);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isAuthenticated,
      isSetup,
      needsMigration,
      migrationCount,
      login,
      register,
      logout: doLogout,
      deleteAccount: removeAccount,
      completeMigration,
      updateUser,
      marcoEnabled,
      setMarcoEnabled,
      registration,
      sessionExpired,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
