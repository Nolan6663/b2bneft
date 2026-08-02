'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPublicRouter = require('../../routes/public');
const { fakePool, serve, baseDeps } = require('./helpers');

// Гостевые эндпоинты мастера: их зовёт человек без аккаунта, поэтому проверяем
// не только выдачу, но и то, что наружу не уходят контакты предприятий.
const MATCHES = [
    { company: 'ООО Рези', city: 'Казань', products: 'манжеты, кольца', phone: '+7 900 000-00-00', email: 'z@rezi.ru', website: 'rezi.ru', score: 82 },
    { company: 'ООО Уплотнения', city: 'Пермь', products: 'уплотнения', phone: '+7 901 000-00-00', email: 'p@upl.ru', website: 'upl.ru', score: 61 },
];

function router(overrides = {}) {
    return createPublicRouter(baseDeps({
        pool: fakePool([{ match: /FROM companies/i, rows: [] }]),
        matchedProducers: async () => MATCHES.concat(
            Array.from({ length: 20 }, (_, i) => ({ company: `Завод ${i}`, city: 'Омск', products: 'детали', score: 40 }))
        ),
        ...overrides,
    }));
}

test('подбор для гостя: отдаёт счётчик и не больше шести карточек', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/match-preview', {
            method: 'POST',
            body: { title: 'Манжеты', category: 'РТИ', description: 'полиуретан, 25 МПа' },
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.total, 22);
        assert.equal(res.json.items.length, 6);
        assert.equal(res.json.items[0].company, 'ООО Рези');
    } finally { await srv.close(); }
});

test('подбор для гостя: контакты предприятий не утекают', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/match-preview', {
            method: 'POST',
            body: { title: 'Манжеты', category: 'РТИ', description: 'полиуретан' },
        });
        const dump = JSON.stringify(res.json);
        for (const secret of ['+7 900 000-00-00', 'z@rezi.ru', 'rezi.ru']) {
            assert.ok(!dump.includes(secret), `в ответе не должно быть ${secret}`);
        }
    } finally { await srv.close(); }
});

test('подбор для гостя: без описания и названия — 400', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/match-preview', { method: 'POST', body: { category: 'РТИ' } });
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});

test('поиск по ИНН: находит стаб и отдаёт только публичные поля', async () => {
    const rows = [{
        id: 7, company: 'АО Ижнефтемаш', city: 'Ижевск', products: 'насосы', specialization: 'Нефтепромысловое оборудование',
        source: 'gisp-pp719', claimed: false, phone: '+7 902 000-00-00', email: 'info@izh.ru', website: 'izh.ru',
    }];
    const srv = await serve('/api', router({ pool: fakePool([{ match: /FROM companies/i, rows }]) }));
    try {
        const res = await srv.request('/api/public/company-by-inn?inn=1832000000');
        assert.equal(res.status, 200);
        assert.equal(res.json.found, true);
        assert.equal(res.json.company.company, 'АО Ижнефтемаш');
        const dump = JSON.stringify(res.json);
        assert.ok(!dump.includes('info@izh.ru') && !dump.includes('+7 902 000-00-00'), 'контакты стаба наружу не отдаём');
    } finally { await srv.close(); }
});

test('поиск по ИНН: мусор вместо ИНН — 400, ничего не найдено — found=false', async () => {
    const srv = await serve('/api', router({ pool: fakePool([{ match: /FROM companies/i, rows: [] }]) }));
    try {
        assert.equal((await srv.request('/api/public/company-by-inn?inn=123')).status, 400);
        const none = await srv.request('/api/public/company-by-inn?inn=7728000000');
        assert.equal(none.status, 200);
        assert.equal(none.json.found, false);
    } finally { await srv.close(); }
});
