'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createNotificationsRouter = require('../../routes/notifications');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

/* Счётчик колокольчика.

   Это самый частый запрос в системе: раз в 12 секунд из каждой открытой
   вкладки. Раньше ради одного числа приезжал весь список уведомлений
   компании — за всё время и с текстами. Проверяем, что счётчик считает в
   базе, что чужую компанию по-прежнему не отдаём и что список не забыл про
   потолок. */

const USER = { id: 1, company: 'ООО Заказчик', role: 'customer' };

function router(rows) {
    return createNotificationsRouter(baseDeps({
        pool: fakePool([
            { match: /SELECT COUNT\(\*\)/i, rows: [{ n: 4 }] },
            { match: /SELECT \* FROM notifications/i, rows: rows || [] },
        ]),
        requireAuth: fakeAuth(USER),
    }));
}

test('колокольчик получает число, а не список', async () => {
    const instance = router();
    const srv = await serve('/api/notifications', instance);
    try {
        const res = await srv.request(`/api/notifications/${encodeURIComponent('ООО Заказчик')}/unread-count`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, { unread: 4 });
    } finally { await srv.close(); }
});

test('считает непрочитанные в базе, а не выгружает всё ради фильтра', async () => {
    const pool = fakePool([{ match: /SELECT COUNT\(\*\)/i, rows: [{ n: 0 }] }]);
    const instance = createNotificationsRouter(baseDeps({ pool, requireAuth: fakeAuth(USER) }));
    const srv = await serve('/api/notifications', instance);
    try {
        await srv.request(`/api/notifications/${encodeURIComponent('ООО Заказчик')}/unread-count`);
        const q = pool.calls[0];
        assert.match(q.sql, /read = false/i);
        assert.deepEqual(q.params, ['ООО Заказчик']);
        assert.doesNotMatch(q.sql, /SELECT \*/i, 'тексты уведомлений счётчику не нужны');
    } finally { await srv.close(); }
});

test('чужой счётчик не отдаётся', async () => {
    const instance = router();
    const srv = await serve('/api/notifications', instance);
    try {
        const res = await srv.request('/api/notifications/%D0%A7%D1%83%D0%B6%D0%B0%D1%8F/unread-count');
        assert.equal(res.status, 403);
    } finally { await srv.close(); }
});

test('список уведомлений отдаётся с потолком', async () => {
    const pool = fakePool([{ match: /SELECT \* FROM notifications/i, rows: [] }]);
    const instance = createNotificationsRouter(baseDeps({ pool, requireAuth: fakeAuth(USER) }));
    const srv = await serve('/api/notifications', instance);
    try {
        await srv.request(`/api/notifications/${encodeURIComponent('ООО Заказчик')}`);
        assert.match(pool.calls[0].sql, /LIMIT \d+/i, 'без потолка список растёт только вверх');
    } finally { await srv.close(); }
});
