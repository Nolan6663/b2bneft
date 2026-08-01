'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createFavoritesRouter = require('../../routes/favorites');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

const USER = { id: 1, company: 'ООО Заказчик', role: 'customer' };

function srvWith(pool) {
    return serve('/api/favorites', createFavoritesRouter(baseDeps({ pool, requireAuth: fakeAuth(USER) })));
}

test('сохранённые поиски: список только своей компании', async () => {
    const pool = fakePool([
        { match: /FROM saved_searches/i, rows: [
            { id: 3, name: 'РТИ в Тюмени', params: '{"search":"","categories":["РТИ"],"region":"Тюмень"}', created_at: '2026-08-02T00:00:00Z' },
        ] },
    ]);
    const srv = await srvWith(pool);
    try {
        const r = await srv.request('/api/favorites/searches');
        assert.equal(r.status, 200);
        assert.equal(r.json.length, 1);
        assert.equal(r.json[0].name, 'РТИ в Тюмени');
        assert.deepEqual(r.json[0].params.categories, ['РТИ'], 'params должны приходить объектом, а не строкой');
        const sel = pool.calls.find(c => /FROM saved_searches/i.test(c.sql));
        assert.deepEqual(sel.params, ['ООО Заказчик'], 'выборка привязана к компании из сессии');
    } finally { await srv.close(); }
});

test('сохранённые поиски: 400 без названия', async () => {
    const srv = await srvWith(fakePool([]));
    try {
        const r = await srv.request('/api/favorites/searches', { method: 'POST', body: { params: { search: 'РТИ' } } });
        assert.equal(r.status, 400);
    } finally { await srv.close(); }
});

test('сохранённые поиски: 400 если параметры не объект', async () => {
    const srv = await srvWith(fakePool([]));
    try {
        const r = await srv.request('/api/favorites/searches', { method: 'POST', body: { name: 'Поиск', params: 'РТИ' } });
        assert.equal(r.status, 400);
    } finally { await srv.close(); }
});

test('сохранённые поиски: сохраняется, название обрезается до 80 знаков', async () => {
    const pool = fakePool([
        { match: /SELECT COUNT/i, rows: [{ count: 2 }] },
        { match: /INSERT INTO saved_searches/i, rows: [{ id: 11 }] },
    ]);
    const srv = await srvWith(pool);
    try {
        const r = await srv.request('/api/favorites/searches', {
            method: 'POST',
            body: { name: 'я'.repeat(200), params: { search: 'манжеты', categories: ['РТИ'] } },
        });
        assert.equal(r.status, 201);
        assert.equal(r.json.id, 11);
        const ins = pool.calls.find(c => /INSERT INTO saved_searches/i.test(c.sql));
        assert.equal(ins.params[1].length, 80);
        assert.equal(JSON.parse(ins.params[2]).search, 'манжеты');
    } finally { await srv.close(); }
});

test('сохранённые поиски: больше двадцати не заводим', async () => {
    const pool = fakePool([
        { match: /SELECT COUNT/i, rows: [{ count: 20 }] },
    ]);
    const srv = await srvWith(pool);
    try {
        const r = await srv.request('/api/favorites/searches', {
            method: 'POST',
            body: { name: 'Ещё один', params: {} },
        });
        assert.equal(r.status, 409);
        assert.ok(!pool.calls.some(c => /INSERT INTO saved_searches/i.test(c.sql)), 'вставки быть не должно');
    } finally { await srv.close(); }
});

test('сохранённые поиски: удаление ограничено своей компанией', async () => {
    const pool = fakePool([
        { match: /DELETE FROM saved_searches/i, rows: [] },
    ]);
    const srv = await srvWith(pool);
    try {
        const r = await srv.request('/api/favorites/searches/11', { method: 'DELETE' });
        assert.equal(r.status, 200);
        const del = pool.calls.find(c => /DELETE FROM saved_searches/i.test(c.sql));
        assert.deepEqual(del.params, ['ООО Заказчик', 11]);
    } finally { await srv.close(); }
});

test('сохранённые поиски: битый JSON в базе не роняет список', async () => {
    const pool = fakePool([
        { match: /FROM saved_searches/i, rows: [{ id: 5, name: 'Кривой', params: '{не json', created_at: null }] },
    ]);
    const srv = await srvWith(pool);
    try {
        const r = await srv.request('/api/favorites/searches');
        assert.equal(r.status, 200);
        assert.deepEqual(r.json[0].params, {});
    } finally { await srv.close(); }
});
