import apiFetch from './apiFetch';

// Journey AI (Marco) client API.

export async function getMarcoConfig() {
  const res = await apiFetch('/api/ask/config');
  if (!res.ok) throw new Error('Failed to get Journey AI settings');
  return res.json();
}

export async function updateMarcoConfig({ enabled, url, model, timeoutS }) {
  const res = await apiFetch('/api/ask/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, url, model, timeoutS }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save Journey AI settings');
  return data;
}

export async function testMarcoConnection({ url, model }) {
  const res = await apiFetch('/api/ask/config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, model }),
  });
  return res.json();
}

export async function askMarco(question, history = []) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const res = await apiFetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, timeZone, history }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Marco could not answer that');
    err.code = data.code || null;
    throw err;
  }
  return data;
}

/**
 * Streaming ask: the server relays Ollama's generation as Server-Sent Events,
 * so callbacks fire while the model is still writing.
 *
 *   history                prior turns [{ role:'user'|'assistant', content }],
 *                          oldest first — lets the server resolve follow-ups
 *   onStage(stage, extra)  'selecting' | 'querying' | 'answering'
 *   onToken(text)          one generated fragment, in order
 *   onReplace(text)        discard everything shown; this is the full answer
 *
 * Resolves { answer, meta } from the final done event. Uses raw fetch rather
 * than apiFetch on purpose: apiFetch's loading counter settles on res.json(),
 * which a streamed body never calls — and the chat has its own live indicator.
 */
export async function askMarcoStream(question, { history = [], onStage, onToken, onReplace, signal } = {}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, timeZone, history, stream: true }),
    signal,
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    // Validation and config problems arrive as plain JSON before any stream.
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || 'Marco could not answer that');
    err.code = data.code || null;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let done = null;
  let failure = null;

  const dispatch = (event, data) => {
    if (event === 'token') onToken?.(data.text ?? '');
    else if (event === 'stage') onStage?.(data.stage, data);
    else if (event === 'replace') onReplace?.(data.text ?? '');
    else if (event === 'done') done = data;
    else if (event === 'error') failure = data;
  };

  for (;;) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffered += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffered.indexOf('\n\n')) >= 0) {
      const frame = buffered.slice(0, sep);
      buffered = buffered.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        dispatch(event, JSON.parse(data));
      } catch {
        // A malformed frame is dropped; the done event carries the full truth.
      }
    }
  }

  if (failure) {
    const err = new Error(failure.error || 'Marco could not answer that');
    err.code = failure.code || null;
    throw err;
  }
  if (!done) {
    throw new Error('The connection to Marco was interrupted');
  }
  return done;
}
