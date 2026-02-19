export const LARGE_ROUTE_WARNING_MESSAGE = 'This journey has a lot of data points. The map might load slower than normal.';
export const LARGE_ROUTE_WARNING_SUPPRESSED_KEY = 'suppressLargeRouteWarning';

let warningDisplayCount = 0;
let warningMutedForSession = false;

function canUseLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function isLargeRouteWarningSuppressed() {
  if (!canUseLocalStorage()) return false;
  try {
    return window.localStorage.getItem(LARGE_ROUTE_WARNING_SUPPRESSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setLargeRouteWarningSuppressed(suppressed) {
  if (canUseLocalStorage()) {
    try {
      window.localStorage.setItem(
        LARGE_ROUTE_WARNING_SUPPRESSED_KEY,
        suppressed ? 'true' : 'false'
      );
    } catch {
      // no-op
    }
  }

  if (!suppressed) warningMutedForSession = false;
}

export function showLargeRouteWarning(infoToast) {
  if (warningMutedForSession || isLargeRouteWarningSuppressed() || typeof infoToast !== 'function') return;

  warningDisplayCount += 1;

  const options = warningDisplayCount >= 2
    ? {
        actionLabel: 'Mute',
        onAction: () => {
          warningMutedForSession = true;
        }
      }
    : undefined;

  infoToast(LARGE_ROUTE_WARNING_MESSAGE, 5000, options);
}
