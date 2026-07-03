'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createNotificationsRouter = require('../../routes/notifications');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

const USER = { id: 1, company: 'ООО Заказчик', role: 'customer' };

test('уведомления: чужая компания получает 403 на чтение/очистку', async () => {
    const deps = baseDeps({ pool: fakePool([]), requireAuth: fakeAuth(USER) });
    const srv = await serve('/api/notifications', createNotificationsRouter(deps));
    try {
        const other = encodeURIComponent('ООО Чужие');
        assert.equal((await srv.request(`/api/notifications/${other}`)).status, 403);
        assert.equal((await srv.request(`/api/notifications/${other}/read`, { method: 'POST' })).status, 403);
        assert.equal((await srv.request(`/api/notifications/${other}`, { method: 'DELETE' })).status, 403);
    } finally { await srv.close(); }
});

test('уведомления: своя компания читает список и помечает прочитанным', async () => {
    const pool = fakePool([
        { match: /SELECT \* FROM notifications WHERE company/i, rows: [{ id: 1, company: 'ООО Заказчик', text: 'тест', read: false, created_at: new Date().toISOString() }] },
        { match: /UPDATE notifications SET read = true/i, rows: [] },
    ]);
    const deps = baseDeps({ pool, requireAuth: fakeAuth(USER) });
    const srv = await serve('/api/notifications', createNotificationsRouter(deps));
    try {
        const mine = encodeURIComponent('ООО Заказчик');
        const list = await srv.request(`/api/notifications/${mine}`);
        assert.equal(list.status, 200);
        assert.equal(list.json.length, 1);
        assert.equal(list.json[0].text, 'тест');
        assert.equal((await srv.request(`/api/notifications/${mine}/read`, { method: 'POST' })).status, 200);
    } finally { await srv.close(); }
});
