export function getTileUrl(theme) {
  return theme === 'dark'
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
}

export function getChartColors(theme) {
  return theme === 'dark'
    ? { color: '#BDBDBD', grid: '#222222' }
    : { color: '#71717a', grid: '#e4e4e7' };
}

export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
