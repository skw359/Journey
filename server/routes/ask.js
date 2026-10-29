const express = require('express');
const router = express.Router();
const { pool, queryTenant } = require('../db');
const { MIN_ROUTE_MILES } = require('../config');
const {
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_S,
    MIN_TIMEOUT_S,
    MAX_TIMEOUT_S,
    MarcoConfigError,
    getMarcoConfig,
    saveMarcoConfig,
    normalizeOllamaUrl,
    normalizeModel,
} = require('../ai/marco-config');
const ollama = require('../ai/ollama');
const { ask, MarcoError } = require('../ai/pipeline');
const { sanitizeHistory } = require('../ai/history');
const { todayInZone } = require('../ai/periods');
const log = require('../utils/logger').scope('marco');

// Mounted at /api/ask, guarded by requireSession in app.js.
//
// The Ollama endpoint is app-level infrastructure (stored in app_config, like
// the database and weather settings); the journeys Marco reads are always the
// requesting user's own tenant schema via queryTenant(req.userId, ...).

const MAX_QUESTION_CHARS = 500;

function safeTimeZone(raw) {
    const tz = typeof raw === 'string' && raw.trim() ? raw.trim() : 'UTC';
    try {
        todayInZone(tz);
        return tz;
    } catch {
        return 'UTC';
    }
}

// GET /api/ask/config — current Marco settings for the settings screen.
router.get('/config', async (req, res) => {
    try {
        const config = await getMarcoConfig(true);
        res.json({
            enabled: config.enabled,
            url: config.url,
            model: config.model,
            defaultModel: DEFAULT_MODEL,
            timeoutS: config.timeoutS,
            defaultTimeoutS: DEFAULT_TIMEOUT_S,
            minTimeoutS: MIN_TIMEOUT_S,
            maxTimeoutS: MAX_TIMEOUT_S,
        });
    } catch (err) {
        log.error('Get Marco config error:', err);
        res.status(500).json({ error: 'Failed to get Journey AI settings' });
    }
});

// PUT /api/ask/config — save toggle + endpoint + model.
router.put('/config', async (req, res) => {
    try {
        const { enabled, url, model, timeoutS } = req.body || {};
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be true or false' });
        }
        const config = await saveMarcoConfig({ enabled, url, model, timeoutS });
        log.info(`config saved · ${config.enabled ? 'enabled' : 'disabled'} · ${config.url || 'no url'} · ${config.model} · ${config.timeoutS}s timeout`);
        res.json({ success: true, ...config });
    } catch (err) {
        if (err instanceof MarcoConfigError) {
            return res.status(400).json({ error: err.message });
        }
        log.error('Save Marco config error:', err);
        res.status(500).json({ error: 'Failed to save Journey AI settings' });
    }
});

// POST /api/ask/config/test — probe an Ollama endpoint before saving.
// Uses the values from the body so the user can test unsaved edits; falls
// back to the stored config when a field is omitted.
router.post('/config/test', async (req, res) => {
    try {
        const stored = await getMarcoConfig();
        let url;
        let model;
        try {
            url = normalizeOllamaUrl(req.body?.url || stored.url);
            model = normalizeModel(req.body?.model || stored.model);
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }

        const check = await ollama.checkOllama({ url, model });
        const success = check.reachable && check.modelFound && check.tools !== false;

        let message;
        if (!check.modelFound) {
            message = `Connected to Ollama${check.version ? ` ${check.version}` : ''}, but "${model}" is not pulled there`
                + (check.models.length ? ` (available: ${check.models.slice(0, 5).join(', ')})` : '');
        } else if (check.tools === false) {
            message = `Connected, but "${model}" does not report the tools capability Marco needs`;
        } else if (check.tools === null) {
            message = `Connected — "${model}" is available (this Ollama version does not report capabilities, so tool support was not verified)`;
        } else {
            message = `Connected — "${model}" is available with tool support${check.version ? ` (Ollama ${check.version})` : ''}`;
        }

        res.json({ success, message, ...check });
    } catch (err) {
        if (err instanceof ollama.OllamaError) {
            return res.json({ success: false, reachable: false, error: err.message });
        }
        log.error('Test Marco connection error:', err);
        res.status(500).json({ success: false, error: 'Connection test failed' });
    }
});

function friendlyMarcoError(err) {
    return err.code === 'ollama_timeout'
        ? 'The AI server took too long to respond. It may be busy loading the model — try again in a moment, or raise the response timeout in Settings if that machine is just slow.'
        : 'Could not reach the AI server. Check that Ollama is running and the URL in Settings is right.';
}

// POST /api/ask — the main event.
//
// Two response modes on one endpoint:
//   body.stream !== true  → classic JSON { answer, meta }
//   body.stream === true  → Server-Sent Events, so the browser paints the
//                           answer token by token as Ollama generates it:
//     event: stage    {"stage":"selecting"|"querying"|"answering","tool"?}
//     event: token    {"text":"..."}          one generated fragment
//     event: replace  {"text":"..."}          discard shown text, use this
//     event: done     {"answer":..., "meta":...}
//     event: error    {"error":..., "code":...}
// Validation problems are rejected as plain JSON before the stream opens.
router.post('/', async (req, res) => {
    const wantsStream = req.body?.stream === true;
    let streamOpen = false;

    try {
        const config = await getMarcoConfig();
        if (!config.enabled) {
            return res.status(409).json({ error: 'Journey AI is not enabled. Turn it on in Settings first.' });
        }
        if (!config.url) {
            return res.status(409).json({ error: 'Journey AI has no Ollama URL configured. Add one in Settings.' });
        }

        const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
        if (!question) {
            return res.status(400).json({ error: 'A question is required' });
        }
        if (question.length > MAX_QUESTION_CHARS) {
            return res.status(400).json({ error: `Questions are limited to ${MAX_QUESTION_CHARS} characters` });
        }

        const timeZone = safeTimeZone(req.body?.timeZone);
        const history = sanitizeHistory(req.body?.history);

        const { rows: userRows } = await pool.query(
            'SELECT unit_preference FROM users WHERE id = $1',
            [req.userId]
        );
        const units = userRows[0]?.unit_preference === 'metric' ? 'metric' : 'imperial';

        // Cancel the Ollama generation the moment the browser goes away —
        // stop button, closed tab, navigation.
        const abort = new AbortController();
        let sendEvent = null;

        if (wantsStream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no', // defeat proxy buffering (nginx et al.)
            });
            res.flushHeaders?.();
            streamOpen = true;
            req.on('close', () => abort.abort());
            sendEvent = (event, data) => {
                if (!res.writableEnded) {
                    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                }
            };
        }

        const result = await ask(
            {
                question,
                timeZone,
                units,
                history,
                ctx: {
                    query: (text, params) => queryTenant(req.userId, text, params),
                    tz: timeZone,
                    units,
                    minMiles: MIN_ROUTE_MILES,
                },
            },
            {
                ollama,
                url: config.url,
                model: config.model,
                timeoutMs: (config.timeoutS || DEFAULT_TIMEOUT_S) * 1000,
                log,
                signal: abort.signal,
                onEvent: wantsStream
                    ? (evt) => {
                        if (evt.type === 'token') sendEvent('token', { text: evt.text });
                        else if (evt.type === 'stage') sendEvent('stage', { stage: evt.stage, tool: evt.tool || null });
                        else if (evt.type === 'replace') sendEvent('replace', { text: evt.text });
                    }
                    : undefined,
            }
        );

        // One line per question so tool routing is visible in the console —
        // "which tool did the model actually pick?" should never be a mystery.
        log.info(`answered · tool=${result.tool || 'none'} · args=${JSON.stringify(result.args || {})} · ${result.phrasing}${history.length ? ` · history=${history.length}` : ''}`);

        const payload = {
            answer: result.answer,
            meta: {
                tool: result.tool,
                args: result.args,
                periods: result.periods,
                phrasing: result.phrasing,
                model: result.model,
                timeZone,
                units,
                timing: result.timing,
            },
        };

        if (wantsStream) {
            sendEvent('done', payload);
            res.end();
        } else {
            res.json(payload);
        }
    } catch (err) {
        if (err instanceof MarcoError && err.code === 'aborted') {
            // The user hit stop — nothing to report, close quietly.
            log.debug('ask cancelled by the client');
            if (streamOpen) res.end();
            else res.status(499).json({ error: 'Cancelled' });
            return;
        }
        if (err instanceof MarcoError) {
            log.warn(`ask failed · ${err.code} · ${err.message}`);
            if (streamOpen) {
                res.write(`event: error\ndata: ${JSON.stringify({ error: friendlyMarcoError(err), code: err.code })}\n\n`);
                res.end();
            } else {
                res.status(502).json({ error: friendlyMarcoError(err), code: err.code });
            }
            return;
        }
        log.error('Ask error:', err);
        if (streamOpen) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Something went wrong answering that question' })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: 'Something went wrong answering that question' });
        }
    }
});

module.exports = router;
