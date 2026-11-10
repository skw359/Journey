'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test('Marco stops generating when the browser goes away', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const owner = await h.registerAdmin(env.origin);
    const saved = await owner.put('/api/ask/config', { json: { enabled: true, url: 'http://ollama.test:11434', model: 'test-model' } });
    assert.equal(saved.status, 200, saved.text);

    // A model that is slow to answer: each chat request stays open until the server drops it
    // (or, so a regression fails instead of hanging, until the test has given up waiting).
    const chats = [];
    h.outbound.handler = (url, init) => {
        if (!url.endsWith('/api/chat')) return null;
        const chat = { aborted: false };
        chats.push(chat);
        return new Promise((resolve, reject) => {
            const giveUp = setTimeout(() => reject(new Error('the test model was never cancelled')), 4000);
            init.signal.addEventListener('abort', () => {
                clearTimeout(giveUp);
                chat.aborted = true;
                reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
            });
        });
    };
    t.after(() => { h.outbound.handler = null; });

    const until = async (condition, label) => {
        const deadline = Date.now() + 3000;
        while (!condition()) {
            if (Date.now() > deadline) assert.fail(label);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    };

    for (const stream of [true, false]) {
        await t.test(stream ? 'the Stop button on a streamed answer' : 'a dropped connection on a plain request', async () => {
            const before = chats.length;
            const browser = new AbortController();
            const request = fetch(`${env.origin}/api/ask`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', cookie: owner.cookie },
                body: JSON.stringify({ question: 'How far did I travel this week?', stream }),
                signal: browser.signal,
            }).then((res) => res.text()).catch(() => null);

            await until(() => chats.length > before, 'the question never reached the model');
            assert.equal(chats.at(-1).aborted, false);
            browser.abort();
            await request;
            await until(() => chats.at(-1).aborted, 'the model request was left running after the browser went away');
        });
    }
});
