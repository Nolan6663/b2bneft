'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createOrdersRouter = require('../../routes/orders');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

/* Запрос доступа к чертежу.

   Появился из-за замкнутого круга: чертёж открывался заводу после подачи КП, а
   КП требует цену — значит цену просили назвать вслепую. Первый же живой завод
   в это упёрся и решил, что сайт сломан.

   Проверяем то, на чём такой шаг ломается: запись именная, повтор не спамит
   заказчика, по закрытой заявке чертёж не выдаётся вовсе. */

const ACTIVE_ORDER = { id: 7, title: 'Крышка корпуса', company: 'ООО Заказчик', status: 'Активный' };
const PRODUCER = { id: 2, company: 'ООО Завод', role: 'producer', email: 'z@t.ru', email_verified: true };

function router({ order = ACTIVE_ORDER, inserted = [{ id: 1 }], access = [], spy = {} } = {}) {
    const pool = fakePool([
        { match: /INSERT INTO order_drawing_requests/i, rows: inserted },
        { match: /SELECT order_id FROM order_drawing_requests/i, rows: access },
    ]);
    const instance = createOrdersRouter(baseDeps({
        pool,
        requireAuth: fakeAuth(PRODUCER),
        getOrderAccessRow: async () => order,
        addNotification: async (company, text) => { (spy.notified ||= []).push({ company, text }); },
    }));
    return { instance, pool, spy };
}

test('завод открывает чертёж без подачи КП — запись именная', async () => {
    const { instance, pool, spy } = router();
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/drawing-access', { method: 'POST' });
        assert.equal(res.status, 200);

        const insert = pool.calls.find(c => /INSERT INTO order_drawing_requests/i.test(c.sql));
        assert.ok(insert, 'запись о запросе не создана');
        assert.deepEqual(insert.params, [7, 'ООО Завод'], 'в записи должны быть заявка и компания');
        assert.match(insert.sql, /ON CONFLICT \(order_id, company\) DO NOTHING/i,
            'повторный запрос не должен падать на уникальном индексе');

        assert.equal(spy.notified.length, 1, 'заказчик должен узнать, кто открыл его чертёж');
        assert.equal(spy.notified[0].company, 'ООО Заказчик');
        assert.match(spy.notified[0].text, /ООО Завод/);
    } finally { await srv.close(); }
});

test('повторное открытие того же чертежа заказчика не дёргает', async () => {
    // ON CONFLICT DO NOTHING вернёт пустой RETURNING — записи не появилось.
    const { instance, spy } = router({ inserted: [] });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/drawing-access', { method: 'POST' });
        assert.equal(res.status, 200, 'для завода это по-прежнему успех: доступ у него есть');
        assert.equal(spy.notified, undefined, 'второе уведомление о том же заводе — спам');
    } finally { await srv.close(); }
});

test('по закрытой заявке чертёж не выдаётся', async () => {
    for (const status of ['Отменена', 'Закрыта']) {
        const { instance, pool } = router({ order: { ...ACTIVE_ORDER, status } });
        const srv = await serve('/api/orders', instance);
        try {
            const res = await srv.request('/api/orders/7/drawing-access', { method: 'POST' });
            assert.equal(res.status, 409, `статус «${status}» должен закрывать доступ`);
            assert.equal(pool.calls.filter(c => /INSERT INTO order_drawing_requests/i.test(c.sql)).length, 0,
                'по закрытой заявке запись создаваться не должна — это был бы просто слив чертежа');
        } finally { await srv.close(); }
    }
});

test('несуществующая заявка — 404, а не молчаливая запись', async () => {
    const { instance } = router({ order: null });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/999/drawing-access', { method: 'POST' });
        assert.equal(res.status, 404);
    } finally { await srv.close(); }
});

test('заказчику этот путь закрыт', async () => {
    const pool = fakePool([{ match: /INSERT INTO order_drawing_requests/i, rows: [{ id: 1 }] }]);
    const instance = createOrdersRouter(baseDeps({
        pool,
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer' }),
        getOrderAccessRow: async () => ACTIVE_ORDER,
    }));
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/drawing-access', { method: 'POST' });
        assert.equal(res.status, 403);
    } finally { await srv.close(); }
});

test('список открытых чертежей отдаётся интерфейсу — по нему он решает, рисовать ли ссылки', async () => {
    const { instance, pool } = router({ access: [{ order_id: 7 }, { order_id: 12 }] });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/drawing-access');
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, [7, 12]);

        const select = pool.calls.find(c => /SELECT order_id FROM order_drawing_requests/i.test(c.sql));
        assert.deepEqual(select.params, ['ООО Завод'], 'список должен быть только по своей компании');
    } finally { await srv.close(); }
});
