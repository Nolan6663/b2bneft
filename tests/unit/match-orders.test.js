'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPublicRouter = require('../../routes/public');
const { fakePool, serve, baseDeps } = require('./helpers');

/* Подбор закупок под профиль завода. До этого мастер завода звал
   match-preview — подбор ПРЕДПРИЯТИЙ под заявку — и показывал число
   конкурентов под подписью «подходит закупок». Здесь проверяем, что считаются
   именно закупки и что в выдачу не попадают закрытые и просроченные. */

const ORDERS = [
    { id: 1, title: 'Манжеты РТИ', category: 'РТИ', quantity: 200, deadline: '2026-12-01', description: 'полиуретан, уплотнения' },
    { id: 2, title: 'Фрезеровка корпусов', category: 'Металл', quantity: 50, deadline: '2026-12-01', description: 'фрезерные работы по чертежу' },
];

function router({ orders = ORDERS, score = (order, profile) => (String(order.description || '').includes('полиуретан') ? 80 : 0) } = {}) {
    const pool = fakePool([
        { match: /FROM orders/i, rows: orders },
    ]);
    const instance = createPublicRouter(baseDeps({
        pool,
        computeMatchScore: score,
        rowToOrder: (r) => r,
    }));
    return { instance, pool };
}

const PROFILE = { products: 'манжеты и кольца из полиуретана', capabilities: ['rti'], specialization: 'РТИ' };

test('считаются закупки, а не предприятия', async () => {
    const { instance } = router();
    const srv = await serve('/api', instance);
    try {
        const res = await srv.request('/api/public/match-orders', { method: 'POST', body: PROFILE });
        assert.equal(res.status, 200);
        assert.equal(res.json.total, 1, 'подошла одна закупка из двух');
        assert.equal(res.json.items[0].title, 'Манжеты РТИ');
        assert.equal(res.json.items[0].id, 1);
    } finally { await srv.close(); }
});

test('в запросе к базе стоит фильтр по активным и по сроку', async () => {
    const { instance, pool } = router();
    const srv = await serve('/api', instance);
    try {
        await srv.request('/api/public/match-orders', { method: 'POST', body: PROFILE });
        const q = pool.calls.find(c => /FROM orders/i.test(c.sql));
        assert.match(q.sql, /status = 'Активный'/, 'закрытые закупки в подбор не идут');
        assert.match(q.sql, /deadline/, 'просроченные тоже');
    } finally { await srv.close(); }
});

test('пустой профиль — 400, к базе не ходим', async () => {
    const { instance, pool } = router();
    const srv = await serve('/api', instance);
    try {
        const res = await srv.request('/api/public/match-orders', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
        assert.equal(pool.calls.length, 0);
    } finally { await srv.close(); }
});

test('ни одна закупка не подошла — ноль, а не пустая ошибка', async () => {
    const { instance } = router({ score: () => 0 });
    const srv = await serve('/api', instance);
    try {
        const res = await srv.request('/api/public/match-orders', { method: 'POST', body: PROFILE });
        assert.equal(res.status, 200);
        assert.equal(res.json.total, 0);
        assert.deepEqual(res.json.items, []);
    } finally { await srv.close(); }
});

test('в выдаче не больше шести карточек, но total считает все', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...ORDERS[0], id: i + 1, title: `Заявка ${i + 1}` }));
    const { instance } = router({ orders: many, score: () => 50 });
    const srv = await serve('/api', instance);
    try {
        const res = await srv.request('/api/public/match-orders', { method: 'POST', body: PROFILE });
        assert.equal(res.json.total, 12);
        assert.equal(res.json.items.length, 6);
    } finally { await srv.close(); }
});
