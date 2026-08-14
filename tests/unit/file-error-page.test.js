'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createOrdersRouter = require('../../routes/orders');
const createProposalsRouter = require('../../routes/proposals');
const createExportRouter = require('../../routes/export');
const { wantsHtml } = require('../../lib/http-errors');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

/* Отказ по прямой ссылке на файл.

   Чертёж, файл КП, договор и выгрузки открываются переходом браузера, а не
   через apiFetch. Раньше любой отказ по такой ссылке приезжал на экран голым
   JSON — 14.08 завод прочитал это как поломку сайта. Проверяем обе стороны
   развилки: браузеру страница, fetch — прежний JSON, иначе интерфейс,
   разбирающий ответ, сломается сам. */

// Так Accept шлёт браузер при переходе по ссылке или window.open.
const NAV = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' };

const PRODUCER = { id: 2, company: 'ООО Завод', role: 'producer', email: 'z@t.ru', email_verified: true };

test('чертёж без доступа: переходу — страница, fetch — JSON', async () => {
    const make = () => createOrdersRouter(baseDeps({
        pool: fakePool([]),
        requireAuth: fakeAuth(PRODUCER),
        canAccessOrderDrawing: async () => false,
    }));

    const srv = await serve('/api/orders', make());
    try {
        const page = await srv.request('/api/orders/7/drawing', { headers: NAV });
        assert.equal(page.status, 403, 'правило доступа не меняется — меняется только вид ответа');
        assert.match(page.headers.get('content-type') || '', /text\/html/);
        const html = page.buf.toString('utf8');
        assert.match(html, /Нет доступа к чертежу этой закупки/, 'человек должен прочитать причину');
        assert.match(html, /href="\/index\.html"/, 'из тупика нужен выход в кабинет');
        assert.doesNotMatch(html, /^\s*\{/, 'на экран не должен приезжать JSON');

        const api = await srv.request('/api/orders/7/drawing');
        assert.equal(api.status, 403);
        assert.deepEqual(api.json, { error: 'Нет доступа к чертежу этой закупки' },
            'контракт API для fetch прежний');
    } finally { await srv.close(); }
});

test('файл КП, которого нет: переход получает страницу', async () => {
    const pool = fakePool([{ match: /FROM proposals p/i, rows: [] }]);
    const srv = await serve('/api/proposals', createProposalsRouter(baseDeps({ pool })));
    try {
        const page = await srv.request('/api/proposals/5/file', { headers: NAV });
        assert.equal(page.status, 404);
        assert.match(page.buf.toString('utf8'), /Файл не найден/);

        const api = await srv.request('/api/proposals/5/file');
        assert.deepEqual(api.json, { error: 'Файл не найден' });
    } finally { await srv.close(); }
});

test('договор по непринятому КП объясняет себя страницей, а не строкой JSON', async () => {
    const pool = fakePool([{
        match: /FROM proposals p/i,
        rows: [{ id: 5, company: 'ООО Завод', order_company: 'ООО Заказчик', status: 'Отправлено' }],
    }]);
    const srv = await serve('/api/proposals', createProposalsRouter(baseDeps({
        pool,
        canAccessProposal: () => true,
    })));
    try {
        const page = await srv.request('/api/proposals/5/contract.pdf', { headers: NAV });
        assert.equal(page.status, 400);
        assert.match(page.buf.toString('utf8'), /Договор доступен только по принятому КП/);
    } finally { await srv.close(); }
});

test('выгрузка 1С по чужой сделке — страница с отказом', async () => {
    const pool = fakePool([{
        match: /FROM proposals p/i,
        rows: [{ id: 5, customer: 'ООО Другой', price: 100 }],
    }]);
    const srv = await serve('/api/export', createExportRouter(baseDeps({ pool })));
    try {
        const page = await srv.request('/api/export/1c/5', { headers: NAV });
        assert.equal(page.status, 403);
        assert.match(page.buf.toString('utf8'), /Нет доступа/);

        const api = await srv.request('/api/export/1c/5');
        assert.deepEqual(api.json, { error: 'Нет доступа' });
    } finally { await srv.close(); }
});

test('развилка идёт по весу text/html, а не по факту его упоминания', () => {
    const req = (accept) => {
        const express = require('express');
        // req.accepts берём настоящий — самодельная проверка заголовка и была бы
        // тем местом, где всё разъедется.
        const proto = express.request;
        return Object.create(proto, { headers: { value: { accept } } });
    };
    assert.equal(wantsHtml(req('text/html,application/xhtml+xml,*/*;q=0.8')), true, 'переход браузера');
    assert.equal(wantsHtml(req('*/*')), false, 'fetch по умолчанию — JSON');
    assert.equal(wantsHtml(req('application/json')), false, 'явный JSON');
    assert.equal(wantsHtml(req(undefined)), false, 'без Accept — JSON');
    assert.equal(wantsHtml({}), false, 'req без accepts (не express) — JSON');
});
