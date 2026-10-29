'use strict';

/**
 * Minimal Ollama client for Marco. Zero dependencies — global fetch, exactly
 * like the geocoding utilities elsewhere in server/utils.
 *
 * The Ollama instance lives on ANOTHER machine (that is the whole point of the
 * setup), so every call carries a hard timeout and every failure is normalized
 * into an OllamaError with a stable `code` the route layer can map to a
 * user-facing message:
 *
 *   unreachable   TCP-level failure — wrong URL, box offline, firewall
 *   timeout       connected but did not answer inside the deadline
 *   http_error    non-2xx from Ollama (bad model name usually shows up here)
 *   bad_response  2xx but not the JSON shape we expect
 */

class OllamaError extends Error {
    constructor(code, message, detail = null) {
        super(message);
        this.name = 'OllamaError';
        this.code = code;
        this.detail = detail;
    }
}

async function ollamaRequest(baseUrl, path, { method = 'GET', body = null, timeoutMs = 10000 } = {}) {
    const url = `${String(baseUrl).replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
        res = await fetch(url, {
            method,
            signal: controller.signal,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new OllamaError('timeout', `Ollama did not respond within ${Math.round(timeoutMs / 1000)}s (${url})`);
        }
        throw new OllamaError('unreachable', `Could not reach Ollama at ${baseUrl} — ${err.cause?.code || err.message}`);
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OllamaError(
            'http_error',
            `Ollama returned ${res.status} ${res.statusText}`,
            text.slice(0, 400)
        );
    }

    try {
        return await res.json();
    } catch {
        throw new OllamaError('bad_response', 'Ollama returned a non-JSON response');
    }
}

/**
 * One tool-selection round. Sends the tool schemas and returns the first tool
 * call (or the plain content when the model calls none — that is the
 * out-of-scope / identity path, not an error).
 *
 * `history` is prior turns of this conversation — already sanitized by the
 * route into { role: 'user'|'assistant', content } objects — spliced between
 * the system prompt and the latest question so the model can resolve
 * follow-ups ("what about the week before?"). Omitted or empty, the request
 * is byte-identical to the pre-history behaviour.
 *
 * think:false — gemma4 advertises the thinking capability, and reasoning
 * tokens add latency without helping a six-way function choice. Older Ollama
 * servers that predate the flag reject it with a 400; retry once without.
 */
async function chatToolSelect({ url, model, system, question, tools, history = [], timeoutMs = 45000 }) {
    const body = {
        model,
        stream: false,
        think: false,
        messages: [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: question },
        ],
        tools,
        options: { temperature: 0 },
    };

    let data;
    try {
        data = await ollamaRequest(url, '/api/chat', { method: 'POST', body, timeoutMs });
    } catch (err) {
        if (err.code === 'http_error' && /think/i.test(err.detail || '')) {
            const { think, ...withoutThink } = body;
            data = await ollamaRequest(url, '/api/chat', { method: 'POST', body: withoutThink, timeoutMs });
        } else {
            throw err;
        }
    }

    const message = data?.message;
    if (!message || typeof message !== 'object') {
        throw new OllamaError('bad_response', 'Ollama chat response had no message');
    }

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const first = calls[0];
    return {
        name: first?.function?.name ?? null,
        args: first?.function?.arguments ?? {},
        callCount: calls.length,
        content: typeof message.content === 'string' ? message.content.trim() : '',
    };
}

/**
 * The phrasing round: turn a query result into Marco's prose. Deliberately
 * plain system+user messages rather than tool-role messages — tool-role
 * templating varies by model family, and this path must work with whatever
 * the user has pulled.
 */
async function chatAnswer({ url, model, system, user, history = [], timeoutMs = 60000 }) {
    const body = {
        model,
        stream: false,
        think: false,
        messages: [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: user },
        ],
        options: { temperature: 0.2 },
    };

    let data;
    try {
        data = await ollamaRequest(url, '/api/chat', { method: 'POST', body, timeoutMs });
    } catch (err) {
        if (err.code === 'http_error' && /think/i.test(err.detail || '')) {
            const { think, ...withoutThink } = body;
            data = await ollamaRequest(url, '/api/chat', { method: 'POST', body: withoutThink, timeoutMs });
        } else {
            throw err;
        }
    }

    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new OllamaError('bad_response', 'Ollama returned an empty answer');
    }
    return { content: content.trim() };
}

/**
 * Streaming variant of the phrasing round. Same request as chatAnswer but with
 * stream:true; Ollama replies with NDJSON — one JSON object per line, each
 * carrying a small `message.content` fragment, the last marked done:true.
 * `onToken(fragment)` fires per fragment; resolves { content } with the full
 * assembled text.
 *
 * Timeouts are per-idle-gap, not total: a healthy stream can run for a while,
 * but a stream that goes silent for idleTimeoutMs is dead. An external
 * AbortSignal (`signal`) cancels cleanly — the user hit stop or closed the
 * page — and surfaces as code 'aborted' so callers can tell it apart from a
 * failure.
 */
async function chatAnswerStream({
    url, model, system, user, history = [], onToken,
    timeoutMs = 15000,          // to first byte
    idleTimeoutMs = 20000,      // max silence between chunks
    signal = null,
    _allowThink = true,
}) {
    const fullUrl = `${String(url).replace(/\/+$/, '')}/api/chat`;
    const body = {
        model,
        stream: true,
        messages: [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: user },
        ],
        options: { temperature: 0.2 },
    };
    if (_allowThink) body.think = false;

    const controller = new AbortController();
    let abortReason = null; // 'external' | 'idle'
    const abortExternally = () => { abortReason = 'external'; controller.abort(); };
    if (signal) {
        if (signal.aborted) throw new OllamaError('aborted', 'Cancelled before the stream started');
        signal.addEventListener('abort', abortExternally, { once: true });
    }

    let idleTimer = setTimeout(() => { abortReason = 'idle'; controller.abort(); }, timeoutMs);
    const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { abortReason = 'idle'; controller.abort(); }, idleTimeoutMs);
    };
    const cleanup = () => {
        clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', abortExternally);
    };

    let res;
    try {
        res = await fetch(fullUrl, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (err) {
        cleanup();
        if (err.name === 'AbortError') {
            if (abortReason === 'external') throw new OllamaError('aborted', 'Stream cancelled');
            throw new OllamaError('timeout', `Ollama did not start responding within ${Math.round(timeoutMs / 1000)}s`);
        }
        throw new OllamaError('unreachable', `Could not reach Ollama at ${url} — ${err.cause?.code || err.message}`);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        cleanup();
        // Same older-server fallback as the non-streaming calls.
        if (_allowThink && /think/i.test(text)) {
            return chatAnswerStream({
                url, model, system, user, history, onToken, timeoutMs, idleTimeoutMs, signal,
                _allowThink: false,
            });
        }
        throw new OllamaError('http_error', `Ollama returned ${res.status} ${res.statusText}`, text.slice(0, 400));
    }

    const decoder = new TextDecoder();
    let buffered = '';
    let content = '';
    try {
        for await (const chunk of res.body) {
            resetIdle();
            buffered += decoder.decode(chunk, { stream: true });
            let newline;
            while ((newline = buffered.indexOf('\n')) >= 0) {
                const line = buffered.slice(0, newline).trim();
                buffered = buffered.slice(newline + 1);
                if (!line) continue;
                let parsed;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    continue; // tolerate a torn line; the tail stays in the buffer
                }
                const piece = parsed?.message?.content;
                if (typeof piece === 'string' && piece.length) {
                    content += piece;
                    if (onToken) {
                        try { onToken(piece); } catch { /* listener errors never kill the stream */ }
                    }
                }
            }
        }
    } catch (err) {
        cleanup();
        if (err.name === 'AbortError' || controller.signal.aborted) {
            if (abortReason === 'external') throw new OllamaError('aborted', 'Stream cancelled');
            throw new OllamaError('timeout', `Ollama went silent mid-stream for over ${Math.round(idleTimeoutMs / 1000)}s`);
        }
        throw new OllamaError('bad_response', `Stream broke mid-answer: ${err.message}`);
    }
    cleanup();

    if (!content.trim()) {
        throw new OllamaError('bad_response', 'Ollama streamed an empty answer');
    }
    return { content: content.trim() };
}

/** Model tag comparison that treats 'name' and 'name:latest' as the same. */
function sameModelTag(a, b) {
    const norm = (t) => {
        const s = String(t || '').trim();
        return s.endsWith(':latest') ? s.slice(0, -':latest'.length) : s;
    };
    return norm(a) === norm(b) && norm(a) !== '';
}

/**
 * Connection test for the settings screen. Reports each layer separately so
 * the UI can say exactly what is wrong: unreachable vs reachable-but-model-
 * missing vs model-present-but-no-tools.
 *
 *   { reachable, version, modelFound, models[], tools: true|false|null }
 *
 * tools is null when the server predates capability reporting — a warning,
 * not a failure.
 */
async function checkOllama({ url, model, timeoutMs = 6000 }) {
    const result = { reachable: false, version: null, modelFound: false, models: [], tools: null };

    const tags = await ollamaRequest(url, '/api/tags', { timeoutMs });
    result.reachable = true;

    const names = Array.isArray(tags?.models) ? tags.models.map((m) => m?.name).filter(Boolean) : [];
    result.models = names.slice(0, 12);
    result.modelFound = names.some((n) => sameModelTag(n, model));

    try {
        const version = await ollamaRequest(url, '/api/version', { timeoutMs: 3000 });
        if (version?.version) result.version = String(version.version);
    } catch {
        // Version endpoint is informational only.
    }

    if (result.modelFound) {
        try {
            const show = await ollamaRequest(url, '/api/show', {
                method: 'POST',
                body: { model },
                timeoutMs,
            });
            if (Array.isArray(show?.capabilities)) {
                result.tools = show.capabilities.includes('tools');
            }
        } catch {
            result.tools = null;
        }
    }

    return result;
}

module.exports = {
    OllamaError,
    ollamaRequest,
    chatToolSelect,
    chatAnswer,
    chatAnswerStream,
    checkOllama,
    sameModelTag,
};
