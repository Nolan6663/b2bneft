'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const createPublicRouter = require('../../routes/public');
const companiesCache = require('../../lib/companies-cache');
const { fakePool, serve, baseDeps } = require('./helpers');

/* Кэш карты переехал из замыкания роутера в общий модуль (lib/companies-cache):
   его должны сбрасывать правки профилей, а до них роутер не дотягивался. Плата
   за это — состояние живёт между тестами, поэтому чистим его руками. */
beforeEach(() => companiesCache.invalidate());

const ROWS = [
    { id: 1, company: 'ООО Первый', city: 'Казань', role: 'producer', lat: 55.79, lng: 49.11 },
    { id: 2, company: 'ООО Второй', city: 'Пермь', role: 'producer', lat: 58.01, lng: 56.23 },
];

function deps(rows) {
    return baseDeps({
        pool: fakePool([{ match: /FROM companies/i, rows }]),
        rowToCompany: (r) => r,
        getProducerCategories: () => ['Металл'],
        getCityProductionPoint: (city) => ({ lat: 55, lng: 49, region: city || '' }),
        offsetProductionPoint: (point) => point,
    });
}

test('карта: второй запрос отдаётся из кэша, без обращения к базе', async () => {
    const d = deps(ROWS);
    const srv = await serve('/api', createPublicRouter(d));
    try {
        const first = await srv.request('/api/map');
        assert.equal(first.status, 200);
        assert.ok(first.json.length, 'карта должна вернуть точки');
        assert.equal(d.pool.calls.length, 1);

        const second = await srv.request('/api/map');
        assert.deepEqual(second.json, first.json, 'повтор должен отдать то же самое');
        assert.equal(d.pool.calls.length, 1, 'второй запрос не должен читать 4300 строк заново');
    } finally { await srv.close(); }
});

test('карта: пустая выдача не залипает в кэше', async () => {
    const d = deps([]);
    const srv = await serve('/api', createPublicRouter(d));
    try {
        await srv.request('/api/map');
        await srv.request('/api/map');
        assert.equal(d.pool.calls.length, 2, 'пока карта пуста, кэшировать нечего — геокодирование может доехать позже');
    } finally { await srv.close(); }
});
