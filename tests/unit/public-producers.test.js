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
        // Настоящий rowToCompany (server.js:173) переименовывает флаги в camelCase и
        // не отдаёт snake_case-версии. Тождественная заглушка это скрывала: код, читающий
        // producer.verified_by_platform, в тестах «работал», а в проде отдавал бы всем verified:false.
        rowToCompany: (r) => {
            const { verified_by_platform, verified_egrul, ...rest } = r;
            return { ...rest, verifiedByPlatform: Boolean(verified_by_platform), verifiedEgrul: Boolean(verified_egrul) };
        },
        // Витрина классифицирует через lib/producer-categories, а не через общий
        // getProducerCategories из server.js. Заглушка нарочно возвращает пустой
        // список: если эндпоинт снова начнёт спрашивать её, выдача опустеет и
        // тесты ниже упадут.
        getProducerCategories: () => [],
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

test('заводы категории: повторный запрос не ходит в базу заново', async () => {
    const pool = fakePool([{ match: /FROM companies/i, rows: ROWS }]);
    const deps = baseDeps({
        pool,
        rowToCompany: (r) => {
            const { verified_by_platform, verified_egrul, ...rest } = r;
            return { ...rest, verifiedByPlatform: Boolean(verified_by_platform), verifiedEgrul: Boolean(verified_egrul) };
        },
        getProducerCategories: () => [],
    });
    const srv = await serve('/api', createPublicRouter(deps));
    try {
        const rti = encodeURIComponent('РТИ');
        const metall = encodeURIComponent('Металл');

        const first = await srv.request(`/api/public/producers?category=${rti}`);
        assert.equal(first.status, 200);
        const queriesAfterFirst = pool.calls.length;
        assert.equal(queriesAfterFirst, 1, 'первый запрос должен сходить в базу один раз');

        // Вторая категория обслуживается тем же прогоном: страницы четырёх категорий
        // индексируются поисковиками, каждый обход не должен читать 4300 строк заново.
        const second = await srv.request(`/api/public/producers?category=${metall}`);
        assert.equal(second.status, 200);
        assert.ok(second.json.some(p => p.id === 2), 'вторая категория должна отвечать по существу');

        const repeat = await srv.request(`/api/public/producers?category=${rti}`);
        assert.deepEqual(repeat.json, first.json, 'повтор должен отдавать то же самое');

        assert.equal(pool.calls.length, queriesAfterFirst, 'после первого прогона обращений к базе быть не должно');
    } finally { await srv.close(); }
});

test('заводы категории: пустой каталог не залипает в кэше', async () => {
    const pool = fakePool([{ match: /FROM companies/i, rows: [] }]);
    const deps = baseDeps({ pool, rowToCompany: (r) => r, getProducerCategories: () => [] });
    const srv = await serve('/api', createPublicRouter(deps));
    try {
        const url = '/api/public/producers?category=' + encodeURIComponent('РТИ');
        await srv.request(url);
        await srv.request(url);
        assert.equal(pool.calls.length, 2, 'пустую выдачу кэшировать нельзя — каталог мог ещё не импортироваться');
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
