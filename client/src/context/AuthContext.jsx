import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as authApi from '../api/auth';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSetup, setIsSetup] = useState(true);
  const [needsMigration, setNeedsMigration] = useState(false);
  const [migrationCount, setMigrationCount] = useState(0);
  const [marcoEnabled, setMarcoEnabled] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const data = await authApi.getAuthStatus();
      setIsSetup(data.isSetup);
      setIsAuthenticated(data.isAuthenticated);
      setUser(data.user);
      setMarcoEnabled(Boolean(data.marcoEnabled));
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

  const login = useCallback(async (credentials) => {
    const data = await authApi.login(credentials);
    setUser(data.user);
    setIsAuthenticated(true);
    setIsSetup(true);
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
