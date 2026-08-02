'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuthRouter = require('../../routes/auth');
const { fakePool, serve, baseDeps } = require('./helpers');

// Закупки, размещённые до подтверждения email, ждут рассылки. Подтверждение
// отпускает их ровно один раз — флаг снимается тем же запросом, что выбирает
// заказы, поэтому двойной клик по ссылке из письма не даёт двойной рассылки.
const ORDER_ROW = { id: 10, title: 'Манжеты', category: 'РТИ', company: 'ООО Заказчик', outbound_pending: true };

function router({ pending = [], spy = {} } = {}) {
    let released = false;
    return createAuthRouter(baseDeps({
        pool: fakePool([
            { match: /FROM email_verification_tokens/i, rows: [{ user_id: 1, token: 'tok' }] },
            { match: /UPDATE users SET email_verified/i, rows: [] },
            { match: /DELETE FROM email_verification_tokens/i, rows: [] },
            { match: /SELECT company FROM users/i, rows: [{ company: 'ООО Заказчик' }] },
            {
                match: /UPDATE orders SET outbound_pending/i,
                rows: () => {
                    if (released) return [];
                    released = true;
                    return pending;
                },
            },
        ]),
        rowToOrder: (r) => r,
        matchedProducers: async () => [{ company: 'ООО Рези', score: 80, reasons: ['совпадение по продукции'] }],
        notifyCompanyEmail: async (...a) => { (spy.emails ||= []).push(a); },
        registryInviter: { inviteStubsForOrder: async () => { (spy.invites ||= []).push(1); return 1; } },
    }));
}

// Рассылка идёт фоном, чтобы не задерживать ответ — ждём её появления, а не спим.
async function waitFor(fn, ms = 1500) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 10));
    }
    return false;
}

test('подтверждение email отправляет придержанные письма по заказу', async () => {
    const spy = {};
    const srv = await serve('/api/auth', router({ pending: [ORDER_ROW], spy }));
    try {
        const res = await srv.request('/api/auth/verify-email', { method: 'POST', body: { token: 'tok' } });
        assert.equal(res.status, 200);
        assert.ok(await waitFor(() => (spy.emails || []).length === 1), 'письмо о матче должно уйти');
        assert.ok(await waitFor(() => (spy.invites || []).length === 1), 'инвайты по заказу должны уйти');
    } finally { await srv.close(); }
});

test('подтверждение email без придержанных заказов ничего не шлёт', async () => {
    const spy = {};
    const srv = await serve('/api/auth', router({ pending: [], spy }));
    try {
        const res = await srv.request('/api/auth/verify-email', { method: 'POST', body: { token: 'tok' } });
        assert.equal(res.status, 200);
        await new Promise(r => setTimeout(r, 100));
        assert.equal((spy.emails || []).length, 0);
        assert.equal((spy.invites || []).length, 0);
    } finally { await srv.close(); }
});

test('повторное подтверждение не рассылает второй раз', async () => {
    const spy = {};
    const srv = await serve('/api/auth', router({ pending: [ORDER_ROW], spy }));
    try {
        await srv.request('/api/auth/verify-email', { method: 'POST', body: { token: 'tok' } });
        assert.ok(await waitFor(() => (spy.emails || []).length === 1));
        await srv.request('/api/auth/verify-email', { method: 'POST', body: { token: 'tok' } });
        await new Promise(r => setTimeout(r, 150));
        assert.equal((spy.emails || []).length, 1, 'второй раз письма не уходят');
    } finally { await srv.close(); }
});
