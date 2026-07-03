'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createReviewsRouter = require('../../routes/reviews');
const createFavoritesRouter = require('../../routes/favorites');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

const CUSTOMER = { id: 1, company: 'ООО Заказчик', role: 'customer' };

test('отзыв: 400 без обязательных полей', async () => {
    const deps = baseDeps({ pool: fakePool([]), requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/reviews', createReviewsRouter(deps));
    try {
        const r = await srv.request('/api/reviews', { method: 'POST', body: { orderId: 1 } });
        assert.equal(r.status, 400);
    } finally { await srv.close(); }
});

test('отзыв: 400 при оценке вне 1..5', async () => {
    const deps = baseDeps({ pool: fakePool([]), requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/reviews', createReviewsRouter(deps));
    try {
        const r = await srv.request('/api/reviews', { method: 'POST', body: { orderId: 1, toCompany: 'АО Завод', score: 7 } });
        assert.equal(r.status, 400);
    } finally { await srv.close(); }
});

test('отзыв: 403 без завершённой сделки с этим поставщиком', async () => {
    const pool = fakePool([
        { match: /SELECT 1 FROM proposals p JOIN orders o/i, rows: [] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/reviews', createReviewsRouter(deps));
    try {
        const r = await srv.request('/api/reviews', { method: 'POST', body: { orderId: 1, toCompany: 'АО Завод', score: 5 } });
        assert.equal(r.status, 403);
    } finally { await srv.close(); }
});

test('отзыв: сохраняется при валидной сделке, текст обрезается', async () => {
    const pool = fakePool([
        { match: /SELECT 1 FROM proposals p JOIN orders o/i, rows: [{ ok: 1 }] },
        { match: /INSERT INTO reviews/i, rows: [] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/reviews', createReviewsRouter(deps));
    try {
        const r = await srv.request('/api/reviews', {
            method: 'POST',
            body: { orderId: 1, toCompany: 'АО Завод', score: 5, text: 'x'.repeat(5000) },
        });
        assert.equal(r.status, 200);
        const ins = pool.calls.find(c => /INSERT INTO reviews/i.test(c.sql));
        assert.equal(ins.params[4].length, 1000, 'текст должен обрезаться до 1000');
    } finally { await srv.close(); }
});

test('отзывы компании: публичный список со средней оценкой', async () => {
    const pool = fakePool([
        { match: /FROM reviews\s+WHERE to_company/i, rows: [{ score: 5 }, { score: 4 }] },
    ]);
    const deps = baseDeps({ pool });
    const srv = await serve('/api/reviews', createReviewsRouter(deps));
    try {
        const r = await srv.request('/api/reviews/company/' + encodeURIComponent('АО Завод'));
        assert.equal(r.status, 200);
        assert.equal(r.json.count, 2);
        assert.equal(r.json.avg, 4.5);
    } finally { await srv.close(); }
});

test('избранное: 400 без companyId, 404 по несуществующей компании', async () => {
    const pool = fakePool([
        { match: /SELECT 1 FROM companies WHERE id/i, rows: [] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/favorites', createFavoritesRouter(deps));
    try {
        const r1 = await srv.request('/api/favorites', { method: 'POST', body: {} });
        assert.equal(r1.status, 400);
        const r2 = await srv.request('/api/favorites', { method: 'POST', body: { companyId: 999 } });
        assert.equal(r2.status, 404);
    } finally { await srv.close(); }
});

test('избранное: добавление 201, идемпотентно через ON CONFLICT', async () => {
    const pool = fakePool([
        { match: /SELECT 1 FROM companies WHERE id/i, rows: [{ ok: 1 }] },
        { match: /INSERT INTO favorites/i, rows: [] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/favorites', createFavoritesRouter(deps));
    try {
        const r = await srv.request('/api/favorites', { method: 'POST', body: { companyId: 7 } });
        assert.equal(r.status, 201);
        const ins = pool.calls.find(c => /INSERT INTO favorites/i.test(c.sql));
        assert.match(ins.sql, /ON CONFLICT/i);
    } finally { await srv.close(); }
});
