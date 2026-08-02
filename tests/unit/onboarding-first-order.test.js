'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createOrdersRouter = require('../../routes/orders');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

// Мастер приводит человека к публикации до подтверждения email. Первая закупка
// проходит, но наружу ничего не летит — иначе одна мусорная регистрация
// разошлась бы письмами по живым заводам.
const ORDER_ROW = { id: 10, title: 'Манжеты', category: 'РТИ', deadline: '2026-09-01', company: 'ООО Заказчик' };

function router({ ordersCount = 0, verified = false, spy = {} } = {}) {
    const deps = baseDeps({
        pool: fakePool([
            { match: /COUNT\(\*\)[\s\S]*FROM orders/i, rows: [{ n: ordersCount }] },
            { match: /INSERT INTO orders/i, rows: [ORDER_ROW] },
        ]),
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer', email: 'c@t.ru', email_verified: verified }),
        requireVerifiedEmail: (req, res, next) => {
            if (req.user.email_verified) return next();
            return res.status(403).json({ error: 'Подтвердите email' });
        },
        matchedProducers: async () => [{ company: 'ООО Рези', score: 80, reasons: ['совпадение по продукции'] }],
        addNotification: async (...a) => { (spy.notifications ||= []).push(a); },
        notifyCompanyEmail: async (...a) => { (spy.emails ||= []).push(a); },
        registryInviter: { inviteStubsForOrder: async () => { (spy.invites ||= []).push(1); return 1; } },
    });
    return createOrdersRouter(deps);
}

const BODY = { title: 'Манжеты', category: 'РТИ', deadline: '2026-09-01', description: 'полиуретан' };

test('первая закупка публикуется без подтверждённого email', async () => {
    const srv = await serve('/api/orders', router({ ordersCount: 0, verified: false }));
    try {
        const res = await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal(res.status, 201);
        assert.equal(res.json.id, 10);
    } finally { await srv.close(); }
});

test('вторая закупка без подтверждённого email — 403', async () => {
    const srv = await serve('/api/orders', router({ ordersCount: 1, verified: false }));
    try {
        const res = await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal(res.status, 403);
    } finally { await srv.close(); }
});

test('пока email не подтверждён: письма и инвайты не уходят, уведомление в кабинете есть', async () => {
    const spy = {};
    const srv = await serve('/api/orders', router({ ordersCount: 0, verified: false, spy }));
    try {
        await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal((spy.emails || []).length, 0, 'письма о матче не отправляем');
        assert.equal((spy.invites || []).length, 0, 'инвайты заводам не отправляем');
        assert.equal((spy.notifications || []).length, 1, 'уведомление внутри платформы остаётся');
    } finally { await srv.close(); }
});

test('придержанная закупка помечается флагом outbound_pending', async () => {
    let insertParams = null;
    const deps = baseDeps({
        pool: fakePool([
            { match: /COUNT\(\*\)[\s\S]*FROM orders/i, rows: [{ n: 0 }] },
            { match: /INSERT INTO orders/i, rows: (sql, params) => { insertParams = { sql, params }; return [ORDER_ROW]; } },
        ]),
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer', email: 'c@t.ru', email_verified: false }),
        requireVerifiedEmail: (req, res, next) => next(),
        matchedProducers: async () => [],
        registryInviter: { inviteStubsForOrder: async () => 0 },
    });
    const srv = await serve('/api/orders', createOrdersRouter(deps));
    try {
        await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.ok(/outbound_pending/i.test(insertParams.sql), 'колонка должна быть в INSERT');
        assert.ok(insertParams.params.includes(true), 'флаг придержанной рассылки должен быть true');
    } finally { await srv.close(); }
});

test('с подтверждённым email рассылки работают как раньше', async () => {
    const spy = {};
    const srv = await serve('/api/orders', router({ ordersCount: 3, verified: true, spy }));
    try {
        const res = await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal(res.status, 201);
        assert.equal((spy.emails || []).length, 1);
        assert.equal((spy.invites || []).length, 1);
    } finally { await srv.close(); }
});
