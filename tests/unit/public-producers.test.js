'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPublicRouter = require('../../routes/public');
const { fakePool, serve, baseDeps } = require('./helpers');

const ROWS = [
    { id: 1, company: 'ООО Рези', city: 'Казань', role: 'producer', specialization: 'Резинотехнические изделия', products: 'манжеты', verified_by_platform: true, verified_egrul: false },
    { id: 2, company: 'ООО Металл', city: 'Челябинск', role: 'producer', specialization: 'Металлообработка', products: 'токарная обработка', verified_by_platform: false, verified_egrul: false },
    { id: 3, company: 'ООО Уплотнения', city: 'Пермь', role: 'producer', specialization: 'Уплотнения и прокладки', products: '', verified_by_platform: false, verified_egrul: true },
];

function router(rows = ROWS) {
    const deps = baseDeps({
        pool: fakePool([{ match: /FROM companies/i, rows }]),
        rowToCompany: (r) => r,
        // как в server.js:809 — по словам специализации
        getProducerCategories: (p) => {
            const text = `${p.specialization || ''} ${p.products || ''}`.toLowerCase();
            const out = [];
            if (/резин|уплотн|манжет/.test(text)) out.push('РТИ');
            if (/металл|токар|фрезер/.test(text)) out.push('Металл');
            return out;
        },
    });
    return createPublicRouter(deps);
}

test('заводы категории: отдаются только совпавшие по категории', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/producers?category=' + encodeURIComponent('РТИ'));
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.map(p => p.id).sort(), [1, 3]);
        assert.equal(res.json.find(p => p.id === 1).verified, true, 'verified_by_platform должен давать verified');
        assert.equal(res.json.find(p => p.id === 3).verified, true, 'verified_egrul тоже даёт verified');
    } finally { await srv.close(); }
});

test('заводы категории: limit ограничивает выдачу и не пускает мусор', async () => {
    const srv = await serve('/api', router());
    try {
        const one = await srv.request('/api/public/producers?category=' + encodeURIComponent('РТИ') + '&limit=1');
        assert.equal(one.json.length, 1);
        const huge = await srv.request('/api/public/producers?category=' + encodeURIComponent('РТИ') + '&limit=999');
        assert.ok(huge.json.length <= 24, 'верхний предел выдачи — 24');
        const junk = await srv.request('/api/public/producers?category=' + encodeURIComponent('РТИ') + '&limit=abc');
        assert.equal(junk.status, 200, 'битый limit не должен ломать ответ');
    } finally { await srv.close(); }
});

test('заводы категории: без параметра category — 400', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/producers');
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});

test('заводы категории: ничего не совпало — пустой массив, не ошибка', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/producers?category=' + encodeURIComponent('Электрооборудование'));
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, []);
    } finally { await srv.close(); }
});
