'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuctionsRouter = require('../../routes/auctions');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

const CUSTOMER = { id: 1, company: 'ООО Заказчик', role: 'customer' };
const PRODUCER = { id: 2, company: 'АО Завод', role: 'producer' };

test('создание аукциона: 403 для поставщика', async () => {
    const deps = baseDeps({ pool: fakePool([]), requireAuth: fakeAuth(PRODUCER) });
    const srv = await serve('/api/auctions', createAuctionsRouter(deps));
    try {
        const r = await srv.request('/api/auctions', { method: 'POST', body: { orderId: 1, startPrice: 100 } });
        assert.equal(r.status, 403);
    } finally { await srv.close(); }
});

test('создание аукциона: 400 без orderId/startPrice', async () => {
    const deps = baseDeps({ pool: fakePool([]), requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/auctions', createAuctionsRouter(deps));
    try {
        const r = await srv.request('/api/auctions', { method: 'POST', body: { orderId: 1 } });
        assert.equal(r.status, 400);
    } finally { await srv.close(); }
});

test('создание аукциона: 409 когда по заявке уже есть активный', async () => {
    const pool = fakePool([
        { match: /FROM orders WHERE id = \$1 AND company = \$2/i, rows: [{ id: 1, company: 'ООО Заказчик' }] },
        { match: /FROM auctions WHERE order_id = \$1 AND status = 'active'/i, rows: [{ id: 5 }] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/auctions', createAuctionsRouter(deps));
    try {
        const r = await srv.request('/api/auctions', { method: 'POST', body: { orderId: 1, startPrice: 100000 } });
        assert.equal(r.status, 409);
    } finally { await srv.close(); }
});

test('ставка: 403 для заказчика', async () => {
    const deps = baseDeps({ pool: fakePool([]), requireAuth: fakeAuth(CUSTOMER) });
    const srv = await serve('/api/auctions', createAuctionsRouter(deps));
    try {
        const r = await srv.request('/api/auctions/5/bid', { method: 'POST', body: { price: 90, days: 10 } });
        assert.equal(r.status, 403);
    } finally { await srv.close(); }
});

test('ставка: 400 когда цена не ниже текущей лучшей', async () => {
    const pool = fakePool([
        { match: /FROM auctions WHERE id = \$1 AND status = 'active'/i, rows: [{ id: 5, current_best: '100000' }] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(PRODUCER) });
    const srv = await serve('/api/auctions', createAuctionsRouter(deps));
    try {
        const r = await srv.request('/api/auctions/5/bid', { method: 'POST', body: { price: 100000, days: 10 } });
        assert.equal(r.status, 400);
        assert.match(r.json.error, /ниже текущей/);
    } finally { await srv.close(); }
});

test('ставка: 404 по завершённому аукциону', async () => {
    const pool = fakePool([
        { match: /FROM auctions WHERE id = \$1 AND status = 'active'/i, rows: [] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(PRODUCER) });
    const srv = await serve('/api/auctions', createAuctionsRouter(deps));
    try {
        const r = await srv.request('/api/auctions/5/bid', { method: 'POST', body: { price: 90000, days: 10 } });
        assert.equal(r.status, 404);
    } finally { await srv.close(); }
});

test('ставка: успешная понижает current_best и пишет bid', async () => {
    const pool = fakePool([
        { match: /FROM auctions WHERE id = \$1 AND status = 'active'/i, rows: [{ id: 5, current_best: '100000' }] },
        { match: /INSERT INTO auction_bids/i, rows: [{ id: 9, price: 90000, days: 10, created_at: new Date().toISOString() }] },
        { match: /UPDATE auctions SET current_best/i, rows: [] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(PRODUCER) });
    const srv = await serve('/api/auctions', createAuctionsRouter(deps));
    try {
        const r = await srv.request('/api/auctions/5/bid', { method: 'POST', body: { price: 90000, days: 10 } });
        assert.equal(r.status, 200);
        assert.equal(r.json.id, 9);
        const update = pool.calls.find(c => /UPDATE auctions SET current_best/i.test(c.sql));
        assert.ok(update, 'нет UPDATE current_best');
        assert.equal(update.params[0], 90000);
        assert.equal(update.params[1], 'АО Завод');
    } finally { await srv.close(); }
});
