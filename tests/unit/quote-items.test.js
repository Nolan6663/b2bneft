'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createLogisticsRouter = require('../../routes/logistics');
const { parseQuoteItems, itemsToPlaces, parseDeclaredValue, MAX_ITEMS } = require('../../lib/logistics/cargo');
const { itemLabels, totalsLabel, scopeNote } = require('../../lib/logistics/quote-doc');
const { fakePool, serve, baseDeps } = require('./helpers');

/* Опросный лист: несколько позиций разных габаритов.

   Появился по просьбе двух компаний через партнёра — «как у Деловых». Полный
   их лист повторить нельзя: публичный расчёт ДЛ принимает от нас объём и вес,
   и лишние поля вернули бы тот же ответ. Спрашиваем только то, что доедет:
   размеры каждой позиции, количество, негабарит и жёсткая упаковка (их берёт
   ПЭК) и объявленная стоимость (тоже ПЭК).

   Проверяем то, на чём это ломается: что количество разворачивается в места,
   что негодная позиция называет свой номер, что старый формат запроса не
   сломался, и что документ честно говорит, кто эти параметры учитывает. */

const CITY = { id: 1, name: 'Москва', codes: {} };
const CITY2 = { id: 2, name: 'Екатеринбург', codes: {} };
const QUOTES = [{ carrierName: 'ПЭК', service: 'auto', days: { min: 4, max: 6 }, price: { total: 21350, line: 13600 } }];

function router(spy = {}) {
    const pool = fakePool([
        { match: /FROM logistics_cities/i, rows: (sql, params) => {
            const q = String(params && params[0] || '').toLowerCase();
            return q.includes('екат') ? [CITY2] : [CITY];
        } },
        { match: /UPDATE logistics_cities/i, rows: [] },
    ]);
    return createLogisticsRouter(baseDeps({
        pool,
        quoteAll: async (_pool, params) => { spy.params = params; return { quotes: QUOTES, failed: [], fromCache: [] }; },
        dellinLookup: async () => null,
        vozovozLookup: async () => null,
        canAccessProposal: () => true,
    }));
}

test('количество разворачивается в места, флаги едут с каждым', () => {
    const { items } = parseQuoteItems({ items: [
        { length: 2, width: 1, height: 1.5, weight: 800, quantity: 2, oversized: true },
        { length: 0.5, width: 0.5, height: 0.5, weight: 40, quantity: 3, hardPack: true },
    ] });
    const places = itemsToPlaces(items);

    assert.equal(places.length, 5, 'два станка и три ящика — пять мест');
    assert.equal(places.filter(p => p.oversized).length, 2);
    assert.equal(places.filter(p => p.hardPack).length, 3);
    assert.deepEqual(places[0], { width: 1, length: 2, height: 1.5, weight: 800, oversized: true, hardPack: false });
});

test('негодная позиция называет свой номер, а не «проверьте данные»', () => {
    const res = parseQuoteItems({ items: [
        { length: 1, width: 1, height: 1, weight: 100 },
        { length: 1, width: 1, weight: 100 },
    ] });
    assert.match(res.error, /позиции 2/i);
});

test('пустые строки выбрасываются: человек добавил место и передумал', () => {
    const res = parseQuoteItems({ items: [
        { length: 1, width: 1, height: 1, weight: 100 },
        { length: '', width: '', height: '', weight: '' },
    ] });
    assert.equal(res.error, undefined);
    assert.equal(res.items.length, 1);
});

test('потолки: позиций и мест не бесконечно', () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, () => ({ length: 1, width: 1, height: 1, weight: 10 }));
    assert.match(parseQuoteItems({ items: many }).error, /Позиций больше/);

    const heavy = [{ length: 1, width: 1, height: 1, weight: 10, quantity: 100 }, { length: 1, width: 1, height: 1, weight: 10, quantity: 5 }];
    assert.match(parseQuoteItems({ items: heavy }).error, /мест больше/i);
});

test('объявленная стоимость: мусор превращается в ноль, а не в NaN', () => {
    assert.equal(parseDeclaredValue('250000'), 250000);
    assert.equal(parseDeclaredValue('дорого'), 0);
    assert.equal(parseDeclaredValue(-5), 0);
    assert.equal(parseDeclaredValue(undefined), 0);
});

test('расчёт по опросному листу доходит до перевозчиков целиком', async () => {
    const spy = {};
    const srv = await serve('/api/logistics', router(spy));
    try {
        const res = await srv.request('/api/logistics/public-quote', {
            method: 'POST',
            body: {
                from: 'Москва', to: 'Екатеринбург', declaredValue: 250000,
                items: [
                    { length: 2, width: 1, height: 1.5, weight: 800, quantity: 1, oversized: true },
                    { length: 0.5, width: 0.5, height: 0.5, weight: 40, quantity: 4 },
                ],
            },
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.items.length, 2, 'позиции возвращаются — по ним строится документ');
        assert.equal(res.json.declaredValue, 250000);
        assert.equal(spy.params.places.length, 5);
        assert.equal(spy.params.insurance, 250000, 'объявленная стоимость уходит перевозчику, который её принимает');
    } finally { await srv.close(); }
});

test('старый формат запроса продолжает работать', async () => {
    // Так шлёт вкладка, открытая до выкатки, и любой внешний клиент.
    const spy = {};
    const srv = await serve('/api/logistics', router(spy));
    try {
        const res = await srv.request('/api/logistics/public-quote', {
            method: 'POST',
            body: { from: 'Москва', to: 'Екатеринбург', weight: 57, length: 1, width: 0.8, height: 0.6, places: 3 },
        });
        assert.equal(res.status, 200);
        assert.equal(spy.params.places.length, 3);
        assert.equal(spy.params.insurance, 0);
    } finally { await srv.close(); }
});

test('документ перечисляет позиции и не молчит про то, кто их учитывает', () => {
    const items = [
        { length: 2, width: 1, height: 1.5, weight: 800, quantity: 2, oversized: true, hardPack: false },
        { length: 0.5, width: 0.5, height: 0.5, weight: 40, quantity: 3, oversized: false, hardPack: false },
    ];
    const labels = itemLabels(items);
    assert.equal(labels[0], '1. 2×1×1.5 м, 800 кг × 2 (негабарит)');
    assert.equal(labels[1], '2. 0.5×0.5×0.5 м, 40 кг × 3');
    assert.equal(totalsLabel(items), 'мест 5, 1720 кг, 6.375 м³');

    assert.match(scopeNote({ items, declaredValue: 250000 }), /только ПЭК/);
    assert.match(scopeNote({ items, declaredValue: 0 }), /негабарит/);
    assert.equal(scopeNote({ items: [items[1]], declaredValue: 0 }), '',
        'без флагов и стоимости оговорка не нужна — лишний текст читают хуже');
});
