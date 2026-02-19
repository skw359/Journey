import { createContext, useCallback, useContext, useMemo } from 'react';
import { updateUnitPreference as saveUnitPreference } from '../api/settings';
import { useAuth } from './AuthContext';
import {
  convertAccelerationFromFtPerSec2,
  convertDistanceFromMiles,
  convertElevationFromMeters,
  convertSpeedFromMph,
  getAccelerationUnitLabel,
  getDistanceUnitLabel,
  getElevationUnitLabel,
  getSpeedUnitLabel,
  isMetricPreference,
  normalizeUnitPreference,
} from '../utils/units';

const UnitsContext = createContext(null);

export function UnitsProvider({ children }) {
  const { user, updateUser } = useAuth();
  const unitPreference = normalizeUnitPreference(user?.unitPreference);
  const isMetric = isMetricPreference(unitPreference);

  const setUnitPreference = useCallback(async (nextUnitPreference) => {
    const normalized = normalizeUnitPreference(nextUnitPreference);
    const result = await saveUnitPreference(normalized);
    updateUser({ unitPreference: normalizeUnitPreference(result.unitPreference) });
    return normalizeUnitPreference(result.unitPreference);
  }, [updateUser]);

  const value = useMemo(() => ({
    unitPreference,
    isMetric,
    distanceUnit: getDistanceUnitLabel(unitPreference),
    speedUnit: getSpeedUnitLabel(unitPreference),
    elevationUnit: getElevationUnitLabel(unitPreference),
    accelerationUnit: getAccelerationUnitLabel(unitPreference),
    setUnitPreference,
    convertDistance: (value) => convertDistanceFromMiles(value, unitPreference),
    convertSpeed: (value) => convertSpeedFromMph(value, unitPreference),
    convertElevation: (value) => convertElevationFromMeters(value, unitPreference),
    convertAcceleration: (value) => convertAccelerationFromFtPerSec2(value, unitPreference),
  }), [isMetric, setUnitPreference, unitPreference]);

  return (
    <UnitsContext.Provider value={value}>
      {children}
    </UnitsContext.Provider>
  );
}

export function useUnits() {
  const context = useContext(UnitsContext);
  if (!context) throw new Error('useUnits must be used within UnitsProvider');
  return context;
}
