'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkQuote, checkCarrier } = require('../../scripts/check-logistics');

/* Живая проверка перевозчиков (npm run check:logistics). Сам скрипт ходит в
   сеть, но его правила годности — обычные функции, и здесь они проверяются
   без сети.

   Смысл этих правил не в том, чтобы ловить изменение тарифа на 8%, а в том,
   чтобы поймать «формат ответа поехал, и мы разобрали мусор»: ноль вместо
   цены, миллион вместо тарифа, неразобранный срок. */

function goodQuote(extra = {}) {
    return {
        service: 'auto',
        price: { total: 17582, line: 12900, pickup: 2650, delivery: 1350, insurance: 682 },
        days: { min: 4, max: 7 },
        url: 'https://pecom.ru/calculator/',
        ...extra,
    };
}

test('нормальный ответ нареканий не вызывает', () => {
    assert.deepEqual(checkQuote(goodQuote()), []);
});

test('ноль вместо цены — сломанный разбор, а не бесплатная доставка', () => {
    const problems = checkQuote(goodQuote({ price: { total: 0 } }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /вне разумных границ/);
});

test('миллион за куб по России — тоже сломанный разбор', () => {
    assert.match(checkQuote(goodQuote({ price: { total: 1000000 } }))[0], /вне разумных границ/);
});

test('цена не число', () => {
    assert.match(checkQuote(goodQuote({ price: { total: null } }))[0], /не число/);
});

test('перевёрнутый и неправдоподобный срок', () => {
    assert.match(checkQuote(goodQuote({ days: { min: 9, max: 2 } }))[0], /неправдоподобно/);
    assert.match(checkQuote(goodQuote({ days: { min: 1, max: 400 } }))[0], /неправдоподобно/);
});

test('нет ссылки на оформление', () => {
    assert.match(checkQuote(goodQuote({ url: '' }))[0], /ссылки/);
});

test('упавший перевозчик помечается сбоем', async () => {
    const carrier = { CARRIER: 'x', CARRIER_NAME: 'X', quote: async () => { throw new Error('502'); } };
    const res = await checkCarrier(carrier);
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /запрос не прошёл/);
});

test('пустой ответ по эталонному маршруту — сбой', async () => {
    const carrier = { CARRIER: 'x', CARRIER_NAME: 'X', quote: async () => [] };
    const res = await checkCarrier(carrier);
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /ни одного варианта/);
});

test('ни у одного варианта не разобрался срок — сбой', async () => {
    const carrier = { CARRIER: 'x', CARRIER_NAME: 'X', quote: async () => [goodQuote({ days: null })] };
    const res = await checkCarrier(carrier);
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /срок не разобрался/);
});

test('исправный перевозчик проходит', async () => {
    const carrier = { CARRIER: 'x', CARRIER_NAME: 'X', quote: async () => [goodQuote()] };
    const res = await checkCarrier(carrier);
    assert.equal(res.ok, true);
    assert.deepEqual(res.problems, []);
});
