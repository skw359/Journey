let inFlight = 0;
let listeners = new Set();
let unauthorizedListeners = new Set();

const BODY_READERS = ['json', 'text', 'blob', 'arrayBuffer', 'formData'];

function notify() {
  const loading = inFlight > 0;
  listeners.forEach(fn => fn(loading));
}

function start() {
  inFlight++;
  notify();
}

function stop() {
  inFlight = Math.max(0, inFlight - 1);
  notify();
}

export function onLoadingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Called for every 401. The session may have ended while the app was open; the listener
// (AuthContext) asks the server and falls back to the sign-in page if it has.
export function onUnauthorized(fn) {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

// Counts a request as loading until its headers arrive, then while its body is read.
// A response whose body is never read (e.g. an error status) no longer keeps it on.
export default async function apiFetch(...args) {
  start();
  let res;
  try {
    res = await fetch(...args);
  } catch (err) {
    stop();
    throw err;
  }
  if (res.status === 401) unauthorizedListeners.forEach(fn => fn());
  // After the caller's own continuation, which usually starts reading the body.
  setTimeout(stop, 0);
  for (const method of BODY_READERS) {
    if (typeof res[method] !== 'function') continue;
    const read = res[method].bind(res);
    res[method] = () => {
      start();
      return read().finally(stop);
    };
  }
  return res;
}
