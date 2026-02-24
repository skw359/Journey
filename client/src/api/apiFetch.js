let inFlight = 0;
let listeners = new Set();

function notify() {
  const loading = inFlight > 0;
  listeners.forEach(fn => fn(loading));
}

export function onLoadingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export default async function apiFetch(...args) {
  inFlight++;
  notify();
  try {
    const res = await fetch(...args);
    const origJson = res.json.bind(res);
    const origText = res.text.bind(res);
    let bodyRead = false;
    const done = () => {
      if (!bodyRead) {
        bodyRead = true;
        inFlight--;
        notify();
      }
    };
    res.json = () => origJson().then(v => { done(); return v; }, e => { done(); throw e; });
    res.text = () => origText().then(v => { done(); return v; }, e => { done(); throw e; });
    return res;
  } catch (err) {
    inFlight--;
    notify();
    throw err;
  }
}
