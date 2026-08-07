'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakePool } = require('./helpers');
const { quoteAll, cacheKey, sortQuotes } = require('../../lib/logistics');

/* Реестр перевозчиков. Все API здесь чужие и публичные, гарантий доступности
   нет ни у кого — поэтому главное, что проверяется, это что один упавший
   перевозчик не уносит с собой весь расчёт. */

function fakeCarrier(name, behaviour) {
    return {
        CARRIER: name,
        CARRIER_NAME: name.toUpperCase(),
        quote: behaviour,
    };
}

function quoteOf(carrier, total) {
    return {
        carrier, carrierName: carrier.toUpperCase(), service: 'auto',
        price: { total, line: total, pickup: 0, delivery: 0, insurance: 0 },
        days: { min: 3, max: 5 }, doorToDoor: true, url: 'https://example.test/',
    };
}

const PARAMS = {
    from: { id: 1, codes: { pecom: '-446' } },
    to: { id: 2, codes: { pecom: '-473' } },
    places: [{ width: 1, length: 1, height: 1, weight: 500 }],
};

const noCache = { useCache: false };

test('упавший перевозчик выпадает в failed, остальные считаются', async () => {
    const carriers = [
        fakeCarrier('alfa', async () => [quoteOf('alfa', 5000)]),
        fakeCarrier('beta', async () => { throw new Error('502 Bad Gateway'); }),
    ];
    const res = await quoteAll(fakePool([]), PARAMS, { carriers, ...noCache });

    assert.equal(res.quotes.length, 1);
    assert.equal(res.quotes[0].carrier, 'alfa');
    assert.deepEqual(res.failed, ['BETA']);
});

test('зависший перевозчик снимается по таймауту и не держит остальных', async () => {
    const carriers = [
        fakeCarrier('alfa', async () => [quoteOf('alfa', 5000)]),
        fakeCarrier('slow', () => new Promise(() => {})),   // не ответит никогда
    ];
    const res = await quoteAll(fakePool([]), PARAMS, { carriers, timeoutMs: 40, ...noCache });

    assert.equal(res.quotes.length, 1);
    assert.deepEqual(res.failed, ['SLOW']);
});

test('когда молчат все, расчёт не падает — возвращается пусто и список молчунов', async () => {
    const carriers = [
        fakeCarrier('alfa', async () => { throw new Error('сеть'); }),
        fakeCarrier('beta', async () => { throw new Error('сеть'); }),
    ];
    const res = await quoteAll(fakePool([]), PARAMS, { carriers, ...noCache });

    assert.deepEqual(res.quotes, []);
    assert.deepEqual(res.failed, ['ALFA', 'BETA']);
});

test('пустой ответ — это не отказ: перевозчик просто не возит по маршруту', async () => {
    const carriers = [
        fakeCarrier('alfa', async () => []),
        fakeCarrier('beta', async () => [quoteOf('beta', 7000)]),
    ];
    const res = await quoteAll(fakePool([]), PARAMS, { carriers, ...noCache });

    assert.equal(res.quotes.length, 1);
    assert.deepEqual(res.failed, [], 'ALFA не ошибся, ему просто нечего предложить');
});

test('предложения сортируются по итоговой цене', async () => {
    const carriers = [
        fakeCarrier('alfa', async () => [quoteOf('alfa', 9000), quoteOf('alfa', 3000)]),
        fakeCarrier('beta', async () => [quoteOf('beta', 5000)]),
    ];
    const res = await quoteAll(fakePool([]), PARAMS, { carriers, ...noCache });
    assert.deepEqual(res.quotes.map((q) => q.price.total), [3000, 5000, 9000]);
});

test('повторный запрос берётся из кэша, к перевозчику не ходим', async () => {
    let calls = 0;
    const carrier = fakeCarrier('alfa', async () => { calls += 1; return [quoteOf('alfa', 5000)]; });

    const stored = new Map();
    const pool = fakePool([
        { match: /SELECT payload FROM logistics_quotes_cache/i, rows: (sql, params) => {
            const hit = stored.get(params[0]);
            return hit ? [{ payload: hit }] : [];
        } },
        { match: /INSERT INTO logistics_quotes_cache/i, rows: (sql, params) => {
            stored.set(params[0], params[2]);
            return [];
        } },
    ]);

    const first = await quoteAll(pool, PARAMS, { carriers: [carrier] });
    const second = await quoteAll(pool, PARAMS, { carriers: [carrier] });

    assert.equal(calls, 1, 'второй раз перевозчика не спрашивали');
    assert.deepEqual(second.quotes, first.quotes);
    assert.deepEqual(second.fromCache, ['alfa']);
    assert.deepEqual(first.fromCache, [], 'первый расчёт был живым');
});

test('сбой записи в кэш не ломает расчёт', async () => {
    const carrier = fakeCarrier('alfa', async () => [quoteOf('alfa', 5000)]);
    const pool = fakePool([
        { match: /SELECT payload FROM logistics_quotes_cache/i, rows: [] },
        { match: /INSERT INTO logistics_quotes_cache/i, rows: () => { throw new Error('база недоступна'); } },
    ]);

    const res = await quoteAll(pool, PARAMS, { carriers: [carrier] });
    assert.equal(res.quotes.length, 1, 'кэш — ускорение, а не источник правды');
});

test('испорченная запись в кэше игнорируется, считаем заново', async () => {
    let calls = 0;
    const carrier = fakeCarrier('alfa', async () => { calls += 1; return [quoteOf('alfa', 5000)]; });
    const pool = fakePool([
        { match: /SELECT payload FROM logistics_quotes_cache/i, rows: [{ payload: '{битый json' }] },
        { match: /INSERT INTO logistics_quotes_cache/i, rows: [] },
    ]);

    const res = await quoteAll(pool, PARAMS, { carriers: [carrier] });
    assert.equal(calls, 1);
    assert.equal(res.quotes.length, 1);
});

test('ключ кэша различает груз, маршрут и заказанные услуги', () => {
    const base = cacheKey('pecom', PARAMS);

    assert.equal(base, cacheKey('pecom', { ...PARAMS }), 'один и тот же запрос — один ключ');
    assert.notEqual(base, cacheKey('dellin', PARAMS), 'у каждого перевозчика свой кэш');
    assert.notEqual(base, cacheKey('pecom', { ...PARAMS, to: { id: 99 } }), 'другой город');
    assert.notEqual(base, cacheKey('pecom', { ...PARAMS, doorTo: false }), 'без доставки до двери');
    assert.notEqual(base, cacheKey('pecom', { ...PARAMS, insurance: 100000 }), 'со страховкой');
    assert.notEqual(
        base,
        cacheKey('pecom', { ...PARAMS, places: [{ width: 1, length: 1, height: 1, weight: 501 }] }),
        'вес не округляется: округление меняет тарифную ступень'
    );
});

test('сортировка не портит исходный массив', () => {
    const input = [quoteOf('a', 900), quoteOf('b', 100)];
    const sorted = sortQuotes(input);
    assert.deepEqual(sorted.map((q) => q.price.total), [100, 900]);
    assert.deepEqual(input.map((q) => q.price.total), [900, 100]);
});
