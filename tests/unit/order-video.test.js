'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createOrdersRouter = require('../../routes/orders');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

/* Видео к заявке грузится отдельным запросом, уже после публикации: ролик
   весит сотни мегабайт, и обрыв на нём не должен отменять саму закупку.
   Проверяем правила вокруг этого — чужую заявку не тронуть, второе видео не
   приложить, а приложенное попадает в attachments с пометкой kind: video. */

const ORDER_ROW = { id: 7, title: 'Манжеты', company: 'ООО Заказчик' };
const VIDEO = { originalName: 'uzel.mp4', storedName: 'video-1.mp4', kind: 'video', size: 12345 };

function router({ existing = [], company = 'ООО Заказчик', file = { path: '/tmp/x.mp4', originalname: 'uzel.mp4', mimetype: 'video/mp4' } } = {}) {
    const pool = fakePool([
        { match: /SELECT \* FROM orders WHERE id/i, rows: [{ ...ORDER_ROW, company }] },
        { match: /UPDATE orders SET drawing/i, rows: [] },
    ]);
    const instance = createOrdersRouter(baseDeps({
        pool,
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer', email_verified: true }),
        /* multer в юнитах не гоняем: middleware просто кладёт готовый файл */
        handleVideoUpload: (req, res, next) => { req.file = file; next(); },
        persistVideo: async () => VIDEO,
        parseOrderAttachments: () => existing,
        rowToOrder: (r) => ({ ...r, attachments: existing }),
    }));
    return { instance, pool };
}

const findCall = (pool, re) => pool.calls.find(c => re.test(c.sql));

test('видео добавляется к заявке и помечается kind: video', async () => {
    const { instance, pool } = router();
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/video', { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        const upd = findCall(pool, /UPDATE orders SET drawing/i);
        assert.ok(upd, 'вложения должны сохраниться');
        const attachments = JSON.parse(upd.params[1]);
        assert.equal(attachments.length, 1);
        assert.equal(attachments[0].kind, 'video');
        assert.equal(attachments[0].storedName, 'video-1.mp4');
    } finally { await srv.close(); }
});

test('видео встаёт рядом с чертежами, не затирая их', async () => {
    const drawings = [{ originalName: 'chertezh.pdf', storedName: 'a.pdf' }];
    const { instance, pool } = router({ existing: drawings });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/video', { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        const attachments = JSON.parse(findCall(pool, /UPDATE orders SET drawing/i).params[1]);
        assert.deepEqual(attachments.map(f => f.storedName), ['a.pdf', 'video-1.mp4']);
        /* в старой колонке drawing по-прежнему первый файл — чертёж, не видео */
        assert.equal(JSON.parse(findCall(pool, /UPDATE orders SET drawing/i).params[0]).storedName, 'a.pdf');
    } finally { await srv.close(); }
});

test('второе видео к заявке не принимается', async () => {
    const { instance } = router({ existing: [VIDEO] });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/video', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /уже приложено видео/);
    } finally { await srv.close(); }
});

test('к чужой заявке видео не приложить', async () => {
    const { instance } = router({ company: 'ООО Другая' });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/video', { method: 'POST', body: {} });
        assert.equal(res.status, 403);
    } finally { await srv.close(); }
});

test('без файла — понятная ошибка, а не пятисотка', async () => {
    /* именно null: undefined подставит значение по умолчанию, и файл окажется на месте */
    const { instance } = router({ file: null });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/video', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /Файл не получен/);
    } finally { await srv.close(); }
});

test('предел вложений соблюдается и для видео', async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ originalName: `f${i}.pdf`, storedName: `f${i}.pdf` }));
    const { instance } = router({ existing: full });
    const srv = await serve('/api/orders', instance);
    try {
        const res = await srv.request('/api/orders/7/video', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /уже приложено 10 файлов/);
    } finally { await srv.close(); }
});
