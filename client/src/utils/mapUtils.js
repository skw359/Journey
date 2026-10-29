// CARTO began requiring an API key on their raster (PNG) basemaps; requests
// without one come back stamped with an "API key required" watermark. The key
// is a build-time Vite var, so it is baked into the bundle and IS visible to
// anyone who opens devtools -- that is the intended model for basemap keys
// (CARTO ties the key to the domain you registered), the same way Mapbox and
// Google Maps public tokens work. Do not put anything actually secret here.
//
// Set VITE_CARTO_KEY in client/.env (see client/.env.example). Changing it
// requires a rebuild, since Vite inlines the value at build time.
const CARTO_KEY = import.meta.env.VITE_CARTO_KEY;

if (!CARTO_KEY && import.meta.env.DEV) {
  console.warn(
    '[maps] VITE_CARTO_KEY is not set -- basemap tiles will render with the ' +
    'CARTO "API key required" watermark. Add it to client/.env and restart Vite.'
  );
}

export function getTileUrl(theme) {
  const style = theme === 'dark' ? 'dark_all' : 'light_all';
  const url = `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
  return CARTO_KEY ? `${url}?key=${encodeURIComponent(CARTO_KEY)}` : url;
}

export function getChartColors(theme) {
  return theme === 'dark'
    ? { color: '#BDBDBD', grid: '#222222' }
    : { color: '#71717a', grid: '#e4e4e7' };
}

export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
