'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createLogisticsRouter = require('../../routes/logistics');
const { fakePool, serve, baseDeps, fakeAuth } = require('./helpers');

/* Роут расчёта доставки по КП.

   Отдельного внимания стоят отказы. Расчёт не состоится по многим причинам, и
   человеку важно знать, чинится это его действием или нет: «завод не указал
   габариты» и «город не распознан» требуют разного, а общее «не удалось»
   не требует ничего и потому бесполезно. */

const PROPOSAL = {
    id: 1, company: 'ООО Завод', order_company: 'ООО Заказчик', price: 100000,
    cargo_weight: 500, cargo_length: 1.2, cargo_width: 0.8, cargo_height: 0.6, cargo_places: 2,
};

// Перевозчиков подменяем: тесты не ходят в сеть.
const fakeQuoteAll = async (pool, params) => ({
    quotes: [{
        carrier: 'pecom', carrierName: 'ПЭК', service: 'auto',
        price: { total: 17582, line: 12900, pickup: 2650, delivery: 1350, insurance: 682 },
        days: { min: 4, max: 7 }, doorToDoor: true, url: 'https://pecom.ru/calculator/',
    }],
    failed: [],
    fromCache: [],
    params,
});

function router({ proposal = PROPOSAL, cities = {}, companies = null, quoteAll = fakeQuoteAll } = {}) {
    const pool = fakePool([
        { match: /FROM proposals p/i, rows: proposal ? [proposal] : [] },
        { match: /FROM companies WHERE company = ANY/i, rows: companies || [
            { company: 'ООО Завод', city: 'Москва' },
            { company: 'ООО Заказчик', city: 'Екатеринбург' },
        ] },
        { match: /FROM logistics_cities/i, rows: (sql, params) => cities[params[0]] || [] },
        { match: /logistics_quotes_cache/i, rows: [] },
    ]);
    return createLogisticsRouter(baseDeps({
        pool,
        quoteAll,
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer', email: 'z@t.ru' }),
        canAccessProposal: (user, p) => p.company === user.company || p.order_company === user.company,
    }));
}

const MOSCOW = [{ id: 1, name: 'Москва', qualifier: '', pecom_id: '-446', pecom_hub: 'Москва Восток', dellin_code: null, is_hub: true }];
const EKB = [{ id: 2, name: 'Екатеринбург', qualifier: '', pecom_id: '-473', pecom_hub: 'Екатеринбург', dellin_code: null, is_hub: true }];

test('подсказки городов доступны гостю: город спрашивают до регистрации', async () => {
    const pool = fakePool([{
        match: /FROM logistics_cities/i,
        rows: [{ id: 2, name: 'Екатеринбург', qualifier: '', pecom_id: '-473', pecom_hub: 'Екатеринбург', is_hub: true }],
    }]);
    const app = await serve('/api/logistics', createLogisticsRouter(baseDeps({
        pool,
        // Гость: requireAuth сюда не подставляем вовсе, роут должен обойтись optionalAuth
        optionalAuth: (req, res, next) => next(),
    })));
    try {
        const res = await app.request('/api/logistics/cities?q=екат');
        assert.equal(res.status, 200);
        assert.equal(res.json[0].name, 'Екатеринбург');
    } finally { await app.close(); }
});

test('короткий запрос подсказок не ходит в базу', async () => {
    const pool = fakePool([]);
    const app = await serve('/api/logistics', createLogisticsRouter(baseDeps({
        pool,
        optionalAuth: (req, res, next) => next(),
    })));
    try {
        const res = await app.request('/api/logistics/cities?q=е');
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, []);
        assert.equal(pool.calls.length, 0);
    } finally { await app.close(); }
});

// --- публичный калькулятор /dostavka -----------------------------------------

function publicRouter({ cities = {}, quoteAll = fakeQuoteAll } = {}) {
    const pool = fakePool([
        { match: /FROM logistics_cities/i, rows: (sql, params) => cities[params[0]] || [] },
        { match: /logistics_quotes_cache/i, rows: [] },
        { match: /UPDATE logistics_cities/i, rows: [] },
    ]);
    return createLogisticsRouter(baseDeps({ pool, quoteAll, dellinLookup: async () => null }));
}

const BOX = { from: 'Москва', to: 'Екатеринбург', length: 1, width: 1, height: 1, weight: 500 };
const CITIES = { 'москва': MOSCOW, 'екатеринбург': EKB };

test('публичный расчёт: считает без авторизации', async () => {
    const app = await serve('/api/logistics', publicRouter({ cities: CITIES }));
    try {
        const res = await app.request('/api/logistics/public-quote', { method: 'POST', body: BOX });
        assert.equal(res.status, 200);
        assert.equal(res.json.from.name, 'Москва');
        assert.equal(res.json.quotes[0].price.total, 17582);
    } finally { await app.close(); }
});

test('публичный расчёт: неполные габариты отсекаются до похода к перевозчикам', async () => {
    let called = false;
    const app = await serve('/api/logistics', publicRouter({
        cities: CITIES,
        quoteAll: async () => { called = true; return { quotes: [], failed: [], fromCache: [] }; },
    }));
    try {
        const res = await app.request('/api/logistics/public-quote', { method: 'POST', body: { ...BOX, height: '' } });
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'no_cargo');
        assert.equal(called, false, 'чужой API не дёргаем ради заведомо негодного запроса');
    } finally { await app.close(); }
});

test('публичный расчёт: невозможный вес не уходит перевозчику', async () => {
    const app = await serve('/api/logistics', publicRouter({ cities: CITIES }));
    try {
        const res = await app.request('/api/logistics/public-quote', { method: 'POST', body: { ...BOX, weight: 999999 } });
        assert.equal(res.status, 422, '20 тонн — потолок сборного груза');
    } finally { await app.close(); }
});

test('публичный расчёт: город не найден — сказано какой', async () => {
    const app = await serve('/api/logistics', publicRouter({ cities: { 'москва': MOSCOW } }));
    try {
        const res = await app.request('/api/logistics/public-quote', { method: 'POST', body: BOX });
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'to_city');
        assert.match(res.json.error, /Екатеринбург/);
    } finally { await app.close(); }
});

test('публичный расчёт: город-двойник просит уточнить и отдаёт варианты', async () => {
    const twins = [
        { id: 3, name: 'Белый Яр (Алтайский р-н)', qualifier: 'Алтайский р-н', pecom_id: '587941', is_hub: false },
        { id: 4, name: 'Белый Яр', qualifier: '', pecom_id: '600100', is_hub: false },
    ];
    const app = await serve('/api/logistics', publicRouter({ cities: { ...CITIES, 'белый яр': twins } }));
    try {
        const res = await app.request('/api/logistics/public-quote', { method: 'POST', body: { ...BOX, from: 'Белый Яр' } });
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'from_city');
        assert.equal(res.json.candidates.length, 2, 'человеку нужно из чего выбирать');
    } finally { await app.close(); }
});

test('публичный расчёт: один и тот же город с обеих сторон', async () => {
    const app = await serve('/api/logistics', publicRouter({ cities: CITIES }));
    try {
        const res = await app.request('/api/logistics/public-quote', { method: 'POST', body: { ...BOX, to: 'Москва' } });
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'same_city');
    } finally { await app.close(); }
});

test('публичный расчёт: до терминала считается без забора и доставки', async () => {
    let seen = null;
    const app = await serve('/api/logistics', publicRouter({
        cities: CITIES,
        quoteAll: async (pool, params) => { seen = params; return { quotes: [], failed: [], fromCache: [] }; },
    }));
    try {
        const res = await app.request('/api/logistics/public-quote', {
            method: 'POST', body: { ...BOX, doorFrom: false, doorTo: false },
        });
        assert.equal(seen.doorFrom, false);
        assert.equal(seen.doorTo, false);
        assert.equal(res.json.doorTo, false);
    } finally { await app.close(); }
});

test('публичный расчёт: несколько мест разворачиваются в груз', async () => {
    let seen = null;
    const app = await serve('/api/logistics', publicRouter({
        cities: CITIES,
        quoteAll: async (pool, params) => { seen = params; return { quotes: [], failed: [], fromCache: [] }; },
    }));
    try {
        await app.request('/api/logistics/public-quote', { method: 'POST', body: { ...BOX, places: 3 } });
        assert.equal(seen.places.length, 3);
    } finally { await app.close(); }
});

test('без габаритов расчёта нет, и сказано, что делать', async () => {
    const app = await serve('/api/logistics', router({
        proposal: { ...PROPOSAL, cargo_weight: null, cargo_length: null, cargo_width: null, cargo_height: null },
    }));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'no_cargo');
        assert.match(res.json.error, /габарит/i);
    } finally { await app.close(); }
});

test('чужое предложение не показывается', async () => {
    const app = await serve('/api/logistics', createLogisticsRouter(baseDeps({
        pool: fakePool([{ match: /FROM proposals p/i, rows: [{ ...PROPOSAL, company: 'ООО Другой', order_company: 'ООО Третий' }] }]),
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer' }),
        canAccessProposal: () => false,
    })));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(res.status, 403);
    } finally { await app.close(); }
});

test('несуществующее предложение — 404', async () => {
    const app = await serve('/api/logistics', router({ proposal: null }));
    try {
        assert.equal((await app.request('/api/logistics/quote?proposalId=99')).status, 404);
    } finally { await app.close(); }
});

test('без номера предложения — 400', async () => {
    const app = await serve('/api/logistics', router());
    try {
        assert.equal((await app.request('/api/logistics/quote')).status, 400);
    } finally { await app.close(); }
});

test('пустой город в профиле завода назван прямо', async () => {
    const app = await serve('/api/logistics', router({
        companies: [{ company: 'ООО Завод', city: '' }, { company: 'ООО Заказчик', city: 'Екатеринбург' }],
    }));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'from_city');
        assert.match(res.json.error, /Завод не указал город/i);
    } finally { await app.close(); }
});

test('нераспознанный город заказчика назван отдельно от города завода', async () => {
    const app = await serve('/api/logistics', router({ cities: { 'москва': MOSCOW } }));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'to_city', 'город завода распознан, споткнулись на заказчике');
        assert.match(res.json.error, /Екатеринбург/);
    } finally { await app.close(); }
});

test('город-двойник не выбирается молча, а просит уточнить', async () => {
    const app = await serve('/api/logistics', router({
        companies: [{ company: 'ООО Завод', city: 'Белый Яр' }, { company: 'ООО Заказчик', city: 'Екатеринбург' }],
        cities: {
            'белый яр': [
                { id: 3, name: 'Белый Яр (Алтайский р-н)', qualifier: 'Алтайский р-н', pecom_id: '587941', pecom_hub: 'Абакан', is_hub: false },
                { id: 4, name: 'Белый Яр', qualifier: '', pecom_id: '600100', pecom_hub: 'Сургут', is_hub: false },
            ],
        },
    }));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'from_city');
        assert.match(res.json.error, /несколько/i);
    } finally { await app.close(); }
});

test('груз собирается по количеству мест и уходит перевозчику', async () => {
    let seen = null;
    const app = await serve('/api/logistics', router({
        cities: { 'москва': MOSCOW, 'екатеринбург': EKB },
        quoteAll: async (pool, params) => { seen = params; return { quotes: [], failed: [], fromCache: [] }; },
    }));
    try {
        await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(seen.places.length, 2, 'в КП два места');
        assert.deepEqual(seen.places[0], { width: 0.8, length: 1.2, height: 0.6, weight: 500 });
        assert.equal(seen.from.codes.pecom, '-446');
        assert.equal(seen.to.codes.pecom, '-473');
        assert.equal(seen.insurance, 100000, 'страхуем на цену предложения');
    } finally { await app.close(); }
});

test('забор и доставка включены по умолчанию', async () => {
    let seen = null;
    const app = await serve('/api/logistics', router({
        cities: { 'москва': MOSCOW, 'екатеринбург': EKB },
        quoteAll: async (pool, params) => { seen = params; return { quotes: [], failed: [], fromCache: [] }; },
    }));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(seen.doorFrom, true);
        assert.equal(seen.doorTo, true);
        assert.equal(res.json.doorFrom, true, 'интерфейс должен знать, что посчитано');
    } finally { await app.close(); }
});

test('до терминала: флаги доходят до перевозчиков и возвращаются в ответе', async () => {
    let seen = null;
    const app = await serve('/api/logistics', router({
        cities: { 'москва': MOSCOW, 'екатеринбург': EKB },
        quoteAll: async (pool, params) => { seen = params; return { quotes: [], failed: [], fromCache: [] }; },
    }));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1&doorFrom=0&doorTo=0');
        assert.equal(seen.doorFrom, false);
        assert.equal(seen.doorTo, false);
        assert.equal(res.json.doorTo, false);
    } finally { await app.close(); }
});

test('снять можно только один конец маршрута', async () => {
    let seen = null;
    const app = await serve('/api/logistics', router({
        cities: { 'москва': MOSCOW, 'екатеринбург': EKB },
        quoteAll: async (pool, params) => { seen = params; return { quotes: [], failed: [], fromCache: [] }; },
    }));
    try {
        await app.request('/api/logistics/quote?proposalId=1&doorTo=0');
        assert.equal(seen.doorFrom, true, 'завод везёт как раньше');
        assert.equal(seen.doorTo, false, 'заказчик забирает сам');
    } finally { await app.close(); }
});

test('никто не ответил — это не ошибка, а пустой список с именами молчунов', async () => {
    const app = await serve('/api/logistics', router({
        cities: { 'москва': MOSCOW, 'екатеринбург': EKB },
        quoteAll: async () => ({ quotes: [], failed: ['ПЭК'], fromCache: [] }),
    }));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.quotes, []);
        assert.deepEqual(res.json.failed, ['ПЭК']);
    } finally { await app.close(); }
});

test('маршрут разобран — перевозчики опрошены, ответ собран', async () => {
    const app = await serve('/api/logistics', router({ cities: { 'москва': MOSCOW, 'екатеринбург': EKB } }));
    try {
        const res = await app.request('/api/logistics/quote?proposalId=1');
        assert.equal(res.status, 200);
        assert.equal(res.json.from.name, 'Москва');
        assert.equal(res.json.to.name, 'Екатеринбург');
        assert.equal(res.json.cargo.weight, 500);
        assert.equal(res.json.quotes[0].price.total, 17582);
        assert.deepEqual(res.json.failed, []);
    } finally { await app.close(); }
});
