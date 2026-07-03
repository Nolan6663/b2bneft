'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createDealsRouter = require('../../routes/deals');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

const PRODUCER = { id: 2, company: 'АО Завод', role: 'producer' };
const CUSTOMER = { id: 1, company: 'ООО Заказчик', role: 'customer' };

const DEAL_ROW = {
    id: 42, order_id: 7, company: 'АО Завод', status: 'Выигран',
    customer_company: 'ООО Заказчик', order_title: 'Манжеты',
    delivery_stage: 'КП принят', completion_status: 'active',
};

function makeDeps({ user, dealRow = DEAL_ROW }) {
    const pool = fakePool([
        { match: /FROM proposals p JOIN orders o/i, rows: dealRow ? [dealRow] : [] },
        { match: /UPDATE proposals SET delivery_stage/i, rows: [] },
        { match: /UPDATE proposals SET completion_status/i, rows: [] },
        { match: /INSERT INTO delivery_events/i, rows: [] },
    ]);
    return { pool, deps: baseDeps({ pool, requireAuth: fakeAuth(user) }) };
}

test('этап: 400 на несуществующий этап', async () => {
    const { deps } = makeDeps({ user: PRODUCER });
    const srv = await serve('/api/deals', createDealsRouter(deps));
    try {
        const r = await srv.request('/api/deals/42/delivery/stage', { method: 'POST', body: { stage: 'Телепортирован' } });
        assert.equal(r.status, 400);
    } finally { await srv.close(); }
});

test('этап: 404 если сделка не «Выигран»', async () => {
    const { deps } = makeDeps({ user: PRODUCER, dealRow: null });
    const srv = await serve('/api/deals', createDealsRouter(deps));
    try {
        const r = await srv.request('/api/deals/42/delivery/stage', { method: 'POST', body: { stage: 'В производстве' } });
        assert.equal(r.status, 404);
    } finally { await srv.close(); }
});

test('этап: заказчик не может двигать производственные этапы', async () => {
    const { deps } = makeDeps({ user: CUSTOMER });
    const srv = await serve('/api/deals', createDealsRouter(deps));
    try {
        const r = await srv.request('/api/deals/42/delivery/stage', { method: 'POST', body: { stage: 'В производстве' } });
        assert.equal(r.status, 403);
    } finally { await srv.close(); }
});

test('этап: «Принят заказчиком» может поставить только заказчик', async () => {
    const { deps } = makeDeps({ user: PRODUCER });
    const srv = await serve('/api/deals', createDealsRouter(deps));
    try {
        const r = await srv.request('/api/deals/42/delivery/stage', { method: 'POST', body: { stage: 'Принят заказчиком' } });
        assert.equal(r.status, 403);
    } finally { await srv.close(); }
});

test('этап: нельзя откатиться назад', async () => {
    const { deps } = makeDeps({
        user: PRODUCER,
        dealRow: { ...DEAL_ROW, delivery_stage: 'Отгружен' },
    });
    const srv = await serve('/api/deals', createDealsRouter(deps));
    try {
        const r = await srv.request('/api/deals/42/delivery/stage', { method: 'POST', body: { stage: 'В производстве' } });
        assert.equal(r.status, 400);
        assert.match(r.json.error, /предыдущий этап/);
    } finally { await srv.close(); }
});

test('этап: поставщик двигает вперёд, событие пишется', async () => {
    const { deps, pool } = makeDeps({ user: PRODUCER });
    const srv = await serve('/api/deals', createDealsRouter(deps));
    try {
        const r = await srv.request('/api/deals/42/delivery/stage', {
            method: 'POST',
            body: { stage: 'В производстве', notes: 'запустили', trackingNumber: '' },
        });
        assert.equal(r.status, 200);
        const upd = pool.calls.find(c => /UPDATE proposals SET delivery_stage/i.test(c.sql));
        assert.equal(upd.params[0], 'В производстве');
        const ev = pool.calls.find(c => /INSERT INTO delivery_events/i.test(c.sql));
        assert.equal(ev.params[1], 'В производстве');
        assert.equal(ev.params[3], 'АО Завод');
    } finally { await srv.close(); }
});

test('этап: «Принят заказчиком» завершает сделку', async () => {
    const { deps, pool } = makeDeps({
        user: CUSTOMER,
        dealRow: { ...DEAL_ROW, delivery_stage: 'Доставлен' },
    });
    const srv = await serve('/api/deals', createDealsRouter(deps));
    try {
        const r = await srv.request('/api/deals/42/delivery/stage', { method: 'POST', body: { stage: 'Принят заказчиком' } });
        assert.equal(r.status, 200);
        const done = pool.calls.find(c => /UPDATE proposals SET completion_status/i.test(c.sql));
        assert.ok(done, 'completion_status должен обновиться');
    } finally { await srv.close(); }
});
