'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test('smoke: register, upload, list, maps, fun stats', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);

    const owner = await h.registerAdmin(env.origin);
    const status = await owner.get('/api/auth/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.isAuthenticated, true);
    assert.equal(status.data.user.isAdmin, true);

    const up = await h.uploadJourney(owner, h.journeyZip(h.lineRows()));
    assert.equal(up.status, 201, up.text);
    assert.equal(up.data.saved, true);

    const list = await owner.get('/api/routes');
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);

    const atlas = await owner.get('/api/alltime-map-data?maxPoints=100');
    assert.equal(atlas.status, 200, atlas.text);
    assert.equal(atlas.data.routes.length, 1);
    assert.equal(atlas.data.routes[0].coordinates.length, 100);

    const detail = await owner.get('/api/alltime-map-data?maxPoints=1000&bounds=40.7,-74.1,40.9,-73.8');
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.data.routes.length, 1);

    const heat = await owner.get('/api/heatmap-grid?zoom=12&bounds=40.7,-74.1,40.9,-73.8');
    assert.equal(heat.status, 200, heat.text);
    assert.ok(heat.data.cells.length > 0);

    const fun = await owner.get('/api/fun-stats');
    assert.equal(fun.status, 200, fun.text);
    assert.equal(fun.data.totalRoutes, 1);
});
