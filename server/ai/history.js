'use strict';

/**
 * Conversation memory for Marco — the sanitizer for client-sent transcripts.
 *
 * The transcript lives in the CLIENT: it is literally the chat on screen, so
 * the server never stores conversation state. Each /api/ask request carries
 * the recent completed turns, this module reduces them to something safe to
 * put in front of the model, and both Ollama rounds see the result. New chat
 * or a page reload empties the transcript, and with it the memory — exactly
 * what the UI already shows.
 *
 * The caps are NOT about the context window — the Ollama box runs 64k and ten
 * short turns are a couple of KB. They are about small models drifting when
 * handed long transcripts: stale periods and places start bleeding into new
 * tool calls. Follow-ups only ever reference the last few turns, so that is
 * all we forward.
 */

const MAX_HISTORY_MESSAGES = 10;        // 5 exchanges
const MAX_HISTORY_MESSAGE_CHARS = 1200; // one turn; trimmed mid-sentence is fine
const MAX_HISTORY_TOTAL_CHARS = 6000;   // the whole forwarded transcript

/**
 * history is client input: keep only well-formed { role, content } turns, cap
 * each turn and the total, keep the MOST RECENT turns, and never start with an
 * assistant turn (chat templates expect user-first after system). Anything
 * malformed is dropped silently — a bad transcript degrades to a stateless
 * question, never to a 400.
 *
 * @param {unknown} raw            req.body.history, straight off the wire
 * @returns {Array<{role: 'user'|'assistant', content: string}>} oldest first
 */
function sanitizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    const cleaned = [];
    for (const entry of raw.slice(-MAX_HISTORY_MESSAGES * 2)) {
        if (!entry || typeof entry !== 'object') continue;
        const role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : null;
        const content = typeof entry.content === 'string' ? entry.content.trim() : '';
        if (!role || !content) continue;
        cleaned.push({
            role,
            content: content.length > MAX_HISTORY_MESSAGE_CHARS
                ? `${content.slice(0, MAX_HISTORY_MESSAGE_CHARS).trimEnd()}…`
                : content,
        });
    }
    let recent = cleaned.slice(-MAX_HISTORY_MESSAGES);
    let total = recent.reduce((n, m) => n + m.content.length, 0);
    while (recent.length && total > MAX_HISTORY_TOTAL_CHARS) {
        total -= recent[0].content.length;
        recent.shift();
    }
    while (recent.length && recent[0].role === 'assistant') recent.shift();
    return recent;
}

module.exports = {
    sanitizeHistory,
    MAX_HISTORY_MESSAGES,
    MAX_HISTORY_MESSAGE_CHARS,
    MAX_HISTORY_TOTAL_CHARS,
};
