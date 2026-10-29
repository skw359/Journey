import { useState, useEffect, useRef } from 'react';
import { reverseGeocode } from '../api/geocode';

const cache = new Map();

function buildLabel(startGeo, endGeo) {
  if (!startGeo || !endGeo) return null;

  const sameCity = startGeo.city && endGeo.city && startGeo.city === endGeo.city;
  const sameCountry = startGeo.country_code && endGeo.country_code &&
    startGeo.country_code === endGeo.country_code;

  if (sameCity) {
    const s = startGeo.place_name && startGeo.place_name !== 'unknown' ? startGeo.place_name : null;
    const e = endGeo.place_name && endGeo.place_name !== 'unknown' ? endGeo.place_name : null;
    if (s && e && s !== e) return `${s} → ${e}`;
    if (s && e) return `${s}, ${startGeo.city}`;
    return startGeo.city;
  }

  const formatCity = (geo, useSC) => {
    const city = geo.city && geo.city !== 'unknown' ? geo.city : null;
    if (!city) return null;
    if (useSC && geo.state_code) return `${city}, ${geo.state_code}`;
    if (!useSC && geo.country_code) return `${city}, ${geo.country_code}`;
    return city;
  };

  if (sameCountry) {
    const s = formatCity(startGeo, true);
    const e = formatCity(endGeo, true);
    if (s && e) return `${s} → ${e}`;
  }

  const s = formatCity(startGeo, false);
  const e = formatCity(endGeo, false);
  if (s && e) return `${s} → ${e}`;

  return null;
}

async function fetchCached(lat, lon) {
  const key = `${lat},${lon}`;
  if (cache.has(key)) return cache.get(key);
  const data = await reverseGeocode(lat, lon);
  cache.set(key, data);
  return data;
}

export default function useGeoLabel(currentRoute) {
  const [label, setLabel] = useState(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const startCoord = currentRoute?.startCoord;
    const endCoord = currentRoute?.endCoord;

    if (!startCoord || !endCoord) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the route has no endpoints
      setLabel(null);
      setLoading(false);
      return;
    }

    const seq = ++seqRef.current;
    setLoading(true);

    Promise.all([
      fetchCached(startCoord[0], startCoord[1]),
      fetchCached(endCoord[0], endCoord[1]),
    ])
      .then(([startGeo, endGeo]) => {
        if (seq !== seqRef.current) return;
        setLabel(buildLabel(startGeo, endGeo));
      })
      .catch(() => {
        if (seq !== seqRef.current) return;
        setLabel(null);
      })
      .finally(() => {
        if (seq !== seqRef.current) return;
        setLoading(false);
      });
  }, [currentRoute?.id]);

  return { label, loading };
}
