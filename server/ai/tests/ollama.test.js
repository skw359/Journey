#!/usr/bin/env node
'use strict';

/**
 * Ollama client tests against a real in-process HTTP server that speaks just
 * enough of the Ollama API. This is the closest an offline test can get to
 * the wire: actual sockets, actual JSON, actual timeouts.
 *
 *   node server/ai/tests/ollama.test.js
 */

const http = require('http');
const { check, checkMatch, checkRejects, report } = require('./testkit');
const {
    chatToolSelect, chatAnswer, chatAnswerStream, checkOllama, sameModelTag, OllamaError,
} = require('../ollama');

/** Boot a scripted mock Ollama. Routes is {method+path: (body) => [status, payload]}. */
function mockOllama(routes) {
    const received = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            received.push({ method: req.method, path: req.url, body });
            const handler = routes[`${req.method} ${req.url}`];
            if (!handler) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }
            const [status, payload, delayMs = 0] = handler(body);
            setTimeout(() => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
            }, delayMs);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                received,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

const TOOLS_STUB = [{ type: 'function', function: { name: 'stats_summary', parameters: {} } }];

/**
 * Mock a STREAMING Ollama /api/chat: writes the given raw byte-chunks with a
 * delay between each, exactly as they are given — chunk boundaries included —
 * so NDJSON reassembly across torn lines is genuinely exercised.
 */
function mockStreamingOllama(chunks, { gapMs = 5, status = 200 } = {}) {
    const received = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            received.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
            if (status !== 200) {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'nope' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            let i = 0;
            const writeNext = () => {
                if (i >= chunks.length) { res.end(); return; }
                res.write(chunks[i++]);
                setTimeout(writeNext, gapMs);
            };
            writeNext();
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                received,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

const ndj = (content, done = false) => `${JSON.stringify({ message: { role: 'assistant', content }, done })}\n`;

async function main() {
    /* ---- tag normalization ---- */
    check('sameModelTag: exact', sameModelTag('gemma4:e4b', 'gemma4:e4b'), true);
    check('sameModelTag: latest suffix equivalence', sameModelTag('gemma4', 'gemma4:latest'), true);
    check('sameModelTag: different quant differs', sameModelTag('gemma4:e4b', 'gemma4:e4b-it-qat'), false);
    check('sameModelTag: empty never matches', sameModelTag('', ''), false);

    /* ---- tool-selection round trip ---- */
    {
        const mock = await mockOllama({
            'POST /api/chat': () => [200, {
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ function: { name: 'stats_summary', arguments: { period: 'last_week', travel_mode: 'any' } } }],
                },
            }],
        });
        const out = await chatToolSelect({
            url: `${mock.url}/`, // trailing slash must be tolerated
            model: 'gemma4:e4b',
            system: 'sys',
            question: 'how far last week?',
            tools: TOOLS_STUB,
        });
        check('chat: tool call name parsed', out.name, 'stats_summary');
        check('chat: tool call args parsed', out.args, { period: 'last_week', travel_mode: 'any' });
        check('chat: callCount', out.callCount, 1);

        const sent = mock.received[0];
        check('chat: path joined without double slash', sent.path, '/api/chat');
        check('chat: think disabled', sent.body.think, false);
        check('chat: stream disabled', sent.body.stream, false);
        check('chat: temperature 0 for selection', sent.body.options.temperature, 0);
        check('chat: tools forwarded', sent.body.tools.length, 1);
        check('chat: system+user messages', sent.body.messages.map((m) => m.role), ['system', 'user']);
        await mock.close();
    }

    /* ---- history threading: follow-ups see the transcript ---- */
    {
        const HISTORY = [
            { role: 'user', content: 'how far did I drive last week?' },
            { role: 'assistant', content: 'You drove 88.4 miles, Aug 17 – Aug 23.' },
        ];
        const mock = await mockOllama({
            'POST /api/chat': () => [200, {
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ function: { name: 'stats_summary', arguments: { period: 'week_before_last', travel_mode: 'drive' } } }],
                },
            }],
        });
        await chatToolSelect({
            url: mock.url, model: 'm', system: 'sys', tools: TOOLS_STUB,
            question: 'what about the week before?', history: HISTORY,
        });
        const msgs = mock.received[0].body.messages;
        check('history: select order is system, transcript, question',
            msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
        check('history: transcript text intact', msgs[1].content, HISTORY[0].content);
        check('history: latest question sits last', msgs[3].content, 'what about the week before?');
        await mock.close();
    }
    {
        const mock = await mockOllama({
            'POST /api/chat': () => [200, { message: { role: 'assistant', content: 'phrased' } }],
        });
        await chatAnswer({
            url: mock.url, model: 'm', system: 's', user: 'u',
            history: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }],
        });
        check('history: answer round carries it too',
            mock.received[0].body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
        await mock.close();
    }

    /* ---- no-tool content passthrough ---- */
    {
        const mock = await mockOllama({
            'POST /api/chat': () => [200, { message: { role: 'assistant', content: "I'm Marco!" } }],
        });
        const out = await chatToolSelect({ url: mock.url, model: 'm', system: 's', question: 'hi', tools: TOOLS_STUB });
        check('chat: no tool -> null name and content kept', [out.name, out.content], [null, "I'm Marco!"]);
        await mock.close();
    }

    /* ---- think-flag fallback for older servers ---- */
    {
        let calls = 0;
        const mock = await mockOllama({
            'POST /api/chat': (body) => {
                calls++;
                if ('think' in body) return [400, { error: 'json: unknown field "think"' }];
                return [200, { message: { role: 'assistant', content: 'ok without think' } }];
            },
        });
        const out = await chatAnswer({ url: mock.url, model: 'm', system: 's', user: 'u' });
        check('think fallback: retried once without the flag', calls, 2);
        check('think fallback: succeeded on retry', out.content, 'ok without think');
        await mock.close();
    }

    /* ---- answer round ---- */
    {
        const mock = await mockOllama({
            'POST /api/chat': () => [200, { message: { role: 'assistant', content: '  You drove 42 miles.  ' } }],
        });
        const out = await chatAnswer({ url: mock.url, model: 'm', system: 's', user: 'u' });
        check('answer: content trimmed', out.content, 'You drove 42 miles.');
        check('answer: temperature 0.2', mock.received[0].body.options.temperature, 0.2);
        await mock.close();
    }
    {
        const mock = await mockOllama({
            'POST /api/chat': () => [200, { message: { role: 'assistant', content: '   ' } }],
        });
        await checkRejects('answer: blank content is bad_response',
            () => chatAnswer({ url: mock.url, model: 'm', system: 's', user: 'u' }), 'bad_response');
        await mock.close();
    }

    /* ---- error taxonomy ---- */
    await checkRejects('unreachable port maps to unreachable',
        () => chatAnswer({ url: 'http://127.0.0.1:1', model: 'm', system: 's', user: 'u' }), 'unreachable');
    {
        const mock = await mockOllama({
            'POST /api/chat': () => [200, { message: { role: 'assistant', content: 'too late' } }, 300],
        });
        await checkRejects('slow response maps to timeout',
            () => chatAnswer({ url: mock.url, model: 'm', system: 's', user: 'u', timeoutMs: 60 }), 'timeout');
        await mock.close();
    }
    {
        const mock = await mockOllama({
            'POST /api/chat': () => [500, { error: 'model "nope" not found' }],
        });
        await checkRejects('HTTP 5xx maps to http_error',
            () => chatAnswer({ url: mock.url, model: 'nope', system: 's', user: 'u' }), 'http_error');
        await mock.close();
    }

    /* ---- chatAnswerStream: the live-typing path ---- */

    {
        // History must survive streaming — including the think-flag retry,
        // which rebuilds the request from explicit arguments.
        const HISTORY = [
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
        ];
        const received = [];
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                const body = JSON.parse(raw);
                received.push(body);
                if ('think' in body) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'json: unknown field \"think\"' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                res.write(ndj('ok'));
                res.end(ndj('', true));
            });
        });
        const url = await new Promise((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
        });
        const out = await chatAnswerStream({ url, model: 'm', system: 's', user: 'u', history: HISTORY });
        check('stream history: think retry keeps the transcript',
            received.map((b) => b.messages.map((m) => m.role).join(',')),
            ['system,user,assistant,user', 'system,user,assistant,user']);
        check('stream history: retry still streams the answer', out.content, 'ok');
        await new Promise((r) => server.close(r));
    }

    {
        // Whole lines per chunk: tokens arrive in order, content assembles.
        const mock = await mockStreamingOllama([
            ndj('You '), ndj('drove '), ndj('42 '), ndj('miles.'), ndj('', true),
        ]);
        const tokens = [];
        const out = await chatAnswerStream({
            url: mock.url, model: 'm', system: 's', user: 'u',
            onToken: (t) => tokens.push(t),
        });
        check('stream: tokens in order', tokens, ['You ', 'drove ', '42 ', 'miles.']);
        check('stream: assembled content', out.content, 'You drove 42 miles.');
        check('stream: request asked for stream:true', mock.received[0].body.stream, true);
        check('stream: think disabled', mock.received[0].body.think, false);
        await mock.close();
    }
    {
        // Torn lines: one JSON object split across chunk boundaries, plus two
        // objects arriving in a single chunk. Reassembly must be exact.
        const a = ndj('Hel');
        const mock = await mockStreamingOllama([
            a.slice(0, 10),
            a.slice(10) + ndj('lo ') + ndj('wor'),
            ndj('ld!') + ndj('', true),
        ]);
        const tokens = [];
        const out = await chatAnswerStream({
            url: mock.url, model: 'm', system: 's', user: 'u',
            onToken: (t) => tokens.push(t),
        });
        check('stream: torn-line reassembly', out.content, 'Hello world!');
        check('stream: torn-line token count', tokens.length, 4);
        await mock.close();
    }
    {
        // Silence mid-stream beyond the idle timeout maps to 'timeout'.
        const mock = await mockStreamingOllama(
            [ndj('started '), ndj('then died')],
            { gapMs: 500 },
        );
        await checkRejects('stream: mid-stream silence times out',
            () => chatAnswerStream({
                url: mock.url, model: 'm', system: 's', user: 'u',
                idleTimeoutMs: 80, onToken: () => {},
            }), 'timeout');
        await mock.close();
    }
    {
        // External abort (the stop button) maps to 'aborted', not an error code.
        const mock = await mockStreamingOllama(
            [ndj('one '), ndj('two '), ndj('three '), ndj('', true)],
            { gapMs: 60 },
        );
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 90);
        await checkRejects('stream: external abort maps to aborted',
            () => chatAnswerStream({
                url: mock.url, model: 'm', system: 's', user: 'u',
                signal: controller.signal, onToken: () => {},
            }), 'aborted');
        await mock.close();
    }
    {
        // Older server rejects think → one retry without the flag, still streaming.
        let calls = 0;
        const received = [];
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                calls++;
                received.push(JSON.parse(raw));
                if ('think' in received[received.length - 1]) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'json: unknown field "think"' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                res.write(ndj('ok'));
                res.end(ndj('', true));
            });
        });
        const url = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
        const out = await chatAnswerStream({ url, model: 'm', system: 's', user: 'u', onToken: () => {} });
        check('stream: think retry happened once', calls, 2);
        check('stream: think retry succeeded', out.content, 'ok');
        await new Promise((r) => server.close(r));
    }
    {
        // A stream that ends with only whitespace is a bad_response.
        const mock = await mockStreamingOllama([ndj('  '), ndj('', true)]);
        await checkRejects('stream: blank content rejected',
            () => chatAnswerStream({ url: mock.url, model: 'm', system: 's', user: 'u', onToken: () => {} }),
            'bad_response');
        await mock.close();
    }
    await checkRejects('stream: unreachable maps to unreachable',
        () => chatAnswerStream({ url: 'http://127.0.0.1:1', model: 'm', system: 's', user: 'u', onToken: () => {} }),
        'unreachable');

    /* ---- checkOllama: the settings Test Connection path ---- */
    {
        const mock = await mockOllama({
            'GET /api/tags': () => [200, { models: [{ name: 'gemma4:e4b' }, { name: 'qwen3:4b' }] }],
            'GET /api/version': () => [200, { version: '0.12.1' }],
            'POST /api/show': () => [200, { capabilities: ['completion', 'tools', 'vision'] }],
        });
        const out = await checkOllama({ url: mock.url, model: 'gemma4:e4b' });
        check('check: full success shape', out, {
            reachable: true, version: '0.12.1', modelFound: true,
            models: ['gemma4:e4b', 'qwen3:4b'], tools: true,
        });
        await mock.close();
    }
    {
        const mock = await mockOllama({
            'GET /api/tags': () => [200, { models: [{ name: 'llama3:8b' }] }],
            'GET /api/version': () => [200, { version: '0.12.1' }],
        });
        const out = await checkOllama({ url: mock.url, model: 'gemma4:e4b' });
        check('check: missing model reported with available list', [out.modelFound, out.models], [false, ['llama3:8b']]);
        check('check: no /api/show call when model missing', out.tools, null);
        await mock.close();
    }
    {
        const mock = await mockOllama({
            'GET /api/tags': () => [200, { models: [{ name: 'oldmodel:7b' }] }],
            'GET /api/version': () => [200, { version: '0.1.0' }],
            'POST /api/show': () => [200, { license: '...' }], // pre-capabilities server
        });
        const out = await checkOllama({ url: mock.url, model: 'oldmodel:7b' });
        check('check: capability-less /api/show yields tools:null (warning, not failure)', out.tools, null);
        await mock.close();
    }
    {
        const mock = await mockOllama({
            'GET /api/tags': () => [200, { models: [{ name: 'gemma4:e4b' }] }],
            'GET /api/version': () => [200, { version: '0.12.1' }],
            'POST /api/show': () => [200, { capabilities: ['completion'] }],
        });
        const out = await checkOllama({ url: mock.url, model: 'gemma4:e4b' });
        check('check: model without tools capability yields tools:false', out.tools, false);
        await mock.close();
    }
    await checkRejects('check: unreachable throws (route layer converts it)',
        () => checkOllama({ url: 'http://127.0.0.1:1', model: 'x' }), 'unreachable');

    /* ---- OllamaError shape ---- */
    {
        const err = new OllamaError('timeout', 'msg', 'detail');
        check('OllamaError carries code and detail', [err.code, err.detail, err.name], ['timeout', 'detail', 'OllamaError']);
    }

    report('ollama.test');
}

main().catch((err) => { console.error(err); process.exit(1); });
