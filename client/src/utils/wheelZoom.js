// Journey pages scroll, so a plain mouse wheel scrolls the page and only
// Ctrl/⌘ + wheel zooms the map or chart under the cursor. Trackpad pinch
// arrives as a wheel event with ctrlKey set, so pinch-to-zoom keeps working.
export function isZoomWheel(event) {
  return Boolean(event?.ctrlKey || event?.metaKey);
}

// chartjs-plugin-zoom `onZoomStart`: returning false lets the wheel event
// through to the page instead of zooming the chart.
export function allowChartZoomStart({ event }) {
  return event?.type !== 'wheel' || isZoomWheel(event);
}

export const ZOOM_MODIFIER_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
    ? '⌘'
    : 'Ctrl';
