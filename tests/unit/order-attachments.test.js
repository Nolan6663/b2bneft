'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createOrdersRouter = require('../../routes/orders');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

/* К закупке цепляется несколько файлов. Проверяем три вещи, на которых это
   ломается: все файлы доезжают до базы, первый дублируется в старую колонку
   drawing (её читают уже размещённые заявки и старый код), а при правке
   выброшенные файлы удаляются из хранилища. */

const ORDER_ROW = { id: 7, title: 'Манжеты', category: 'РТИ', deadline: '2026-09-01', company: 'ООО Заказчик' };
const FILES = [
    { originalName: 'chertezh.pdf', storedName: 'drawings/a.pdf' },
    { originalName: 'foto1.jpg', storedName: 'drawings/b.jpg' },
    { originalName: 'foto2.jpg', storedName: 'drawings/c.jpg' },
];

/* Возвращает и роутер, и пул: параметры запросов проверяем по pool.calls. */
function router({ existing = [], saved = [], spy = {} } = {}) {
    const pool = fakePool([
        { match: /COUNT\(\*\)[\s\S]*FROM orders/i, rows: [{ n: 0 }] },
        { match: /INSERT INTO orders/i, rows: [ORDER_ROW] },
        { match: /UPDATE orders SET title/i, rows: [] },
        { match: /SELECT \* FROM orders WHERE id/i, rows: [ORDER_ROW] },
    ]);
    const instance = createOrdersRouter(baseDeps({
        pool,
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer', email: 'c@t.ru', email_verified: true }),
        persistUploads: async () => saved,
        parseOrderAttachments: () => existing,
        deleteDrawingFile: (f) => { (spy.deleted ||= []).push(f.storedName); },
        rowToOrder: (r) => ({ ...r, attachments: existing }),
        matchedProducers: async () => [],
        registryInviter: { inviteStubsForOrder: async () => 0 },
    }));
    return { instance, pool };
}

const findCall = (pool, re) => pool.calls.find(c => re.test(c.sql));

const BODY = { title: 'Манжеты', category: 'РТИ', deadline: '2026-09-01', description: 'полиуретан' };

test('все приложенные файлы уезжают в attachments, первый дублируется в drawing', async () => {
    const { instance, pool } = router({ saved: FILES });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal(res.status, 201);

        const insert = findCall(pool, /INSERT INTO orders/i);
        assert.ok(insert, 'INSERT не выполнился');
        const drawing = JSON.parse(insert.params[6]);
        const attachments = JSON.parse(insert.params[7]);
        assert.equal(attachments.length, 3);
        assert.equal(attachments[1].originalName, 'foto1.jpg');
        assert.equal(drawing.storedName, FILES[0].storedName, 'в drawing должен лечь первый файл');
    } finally { await srv.close(); }
});

test('закупка без файлов пишет null в обе колонки', async () => {
    const { instance, pool } = router({ saved: [] });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal(res.status, 201);
        const insert = findCall(pool, /INSERT INTO orders/i);
        assert.equal(insert.params[6], null);
        assert.equal(insert.params[7], null);
    } finally { await srv.close(); }
});

test('при правке файл, которого нет в keepFiles, удаляется из хранилища', async () => {
    const spy = {};
    const { instance, pool } = router({ existing: FILES, saved: [], spy });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7', {
            method: 'PUT',
            body: { ...BODY, keepFiles: `${FILES[0].storedName},${FILES[2].storedName}` },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(spy.deleted, [FILES[1].storedName], 'удалён должен быть ровно выброшенный файл');

        const update = findCall(pool, /UPDATE orders SET title/i);
        const attachments = JSON.parse(update.params[6]);
        assert.deepEqual(attachments.map(f => f.storedName), [FILES[0].storedName, FILES[2].storedName]);
    } finally { await srv.close(); }
});

test('без поля keepFiles старые вложения остаются на месте', async () => {
    const spy = {};
    const { instance, pool } = router({ existing: FILES, saved: [], spy });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7', { method: 'PUT', body: BODY });
        assert.equal(res.status, 200);
        assert.equal(spy.deleted, undefined, 'ничего удалять не должны');
        const attachments = JSON.parse(findCall(pool, /UPDATE orders SET title/i).params[6]);
        assert.equal(attachments.length, 3);
    } finally { await srv.close(); }
});
