const RG_BASE = 'https://origin.mdoan.com';

export async function reverseGeocode(lat, lon) {
  const res = await fetch(`${RG_BASE}/lookup?lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
  return res.json();
}
