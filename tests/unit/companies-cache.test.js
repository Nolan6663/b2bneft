'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const companiesCache = require('../../lib/companies-cache');
const createPublicRouter = require('../../routes/public');
const createCompaniesRouter = require('../../routes/companies');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

/* Кэш каталога.

   Каталог одинаков для всех вошедших, поэтому кэшируется целиком. Проверяем
   не «работает ли кэш», а то, из-за чего кэши потом проклинают: что правка
   профиля видна сразу, а не через пять минут — иначе завод решит, что она не
   сохранилась. */

const PRODUCERS = [
    { id: 1, company: 'ООО Завод', role: 'producer', verified_by_platform: true },
    { id: 2, company: 'ООО Другой', role: 'producer', verified_by_platform: false },
];

function catalogApp() {
    const pool = fakePool([{ match: /FROM companies/i, rows: PRODUCERS }]);
    const router = createPublicRouter(baseDeps({
        pool,
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer' }),
        rowToCompany: (r) => r,
    }));
    return { pool, router };
}

test('второй заход в каталог до базы не идёт', async () => {
    companiesCache.invalidate();
    const { pool, router } = catalogApp();
    const srv = await serve('/api', router);
    try {
        const first = await srv.request('/api/catalog');
        const second = await srv.request('/api/catalog');

        assert.equal(first.status, 200);
        assert.deepEqual(second.json, first.json, 'из кэша должно приезжать то же самое');
        assert.equal(pool.calls.filter(c => /FROM companies/i.test(c.sql)).length, 1,
            'второй запрос к базе — значит кэша нет');
    } finally { await srv.close(); }
});

test('правка профиля сбрасывает кэш сразу, а не по таймеру', async () => {
    companiesCache.invalidate();
    const { pool, router } = catalogApp();
    const srv = await serve('/api', router);
    try {
        await srv.request('/api/catalog');

        // Ровно то, что делает PUT /companies/:id после UPDATE.
        companiesCache.invalidate();

        await srv.request('/api/catalog');
        assert.equal(pool.calls.filter(c => /FROM companies/i.test(c.sql)).length, 2,
            'после правки каталог обязан перечитаться, иначе человек увидит старый профиль');
    } finally { await srv.close(); }
});

test('правка профиля действительно зовёт сброс', async () => {
    companiesCache.invalidate();
    companiesCache.set('catalog', ['старое']);

    const pool = fakePool([
        { match: /SELECT \* FROM companies WHERE id/i, rows: [{ id: 1, company: 'ООО Завод', role: 'producer' }] },
        { match: /UPDATE companies SET/i, rows: [] },
    ]);
    const router = createCompaniesRouter(baseDeps({
        pool,
        requireAuth: fakeAuth({ id: 1, company: 'ООО Завод', role: 'producer' }),
        rowToCompany: (r) => r,
        enrichCompany: async (c) => c,
        enrichCompanies: async (list) => list,
    }));
    const srv = await serve('/api/companies', router);
    try {
        const res = await srv.request('/api/companies/1', { method: 'PUT', body: { about: 'Новое описание' } });
        assert.equal(res.status, 200);
        assert.equal(companiesCache.get('catalog', 60000), null, 'кэш пережил правку профиля');
    } finally { await srv.close(); }
});

test('запись живёт не дольше своего TTL', () => {
    companiesCache.invalidate();
    companiesCache.set('ключ', [1, 2, 3]);
    assert.deepEqual(companiesCache.get('ключ', 60000), [1, 2, 3]);
    assert.equal(companiesCache.get('ключ', 0), null, 'нулевой TTL — просроченная запись');
});
