'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    quote,
    pickCityCode,
    parseDellinResponse,
    sizeOf,
} = require('../../lib/logistics/dellin');

/* Деловые Линии. Тесты идут по сохранённому живому ответу и в сеть не ходят.

   Два капкана этого API проверяются здесь отдельно, потому что оба не приводят
   к ошибке и потому опаснее обычной поломки:
   вес в тоннах (500 вместо 0.5 — правдоподобная цена за несуществующий груз)
   и код города (почтовый индекс молча превращает маршрут в Майкоп → Майкоп). */

const FIXTURE = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'logistics', 'dellin-msk-ekb.json'), 'utf8')
);

const MOSCOW = { codes: { dellin: '7700000000000000000000000' } };
const EKB = { codes: { dellin: '6600000100000000000000000' } };
const PLACES = [{ width: 1, length: 1, height: 1, weight: 500 }];

test('вес переводится в тонны, объём считается из габаритов', () => {
    assert.deepEqual(sizeOf(PLACES), { volume: 1, weightTons: 0.5 });
});

test('вес суммируется по всем местам', () => {
    const { weightTons, volume } = sizeOf([
        { width: 1, length: 1, height: 1, weight: 300 },
        { width: 1, length: 2, height: 0.5, weight: 700 },
    ]);
    assert.equal(weightTons, 1, '300 + 700 кг = 1 тонна');
    assert.equal(volume, 2);
});

test('итог наземной доставки сходится с их собственным полем price', () => {
    const [auto] = parseDellinResponse(FIXTURE);
    assert.equal(auto.service, 'auto');
    assert.equal(auto.price.total, Math.round(Number(FIXTURE.price)),
        'состав ответа поменялся: наша формула больше не даёт их же итог');
});

test('разбивка складывается в итог без остатка', () => {
    const [auto] = parseDellinResponse(FIXTURE);
    const { total, line, pickup, delivery, insurance } = auto.price;
    assert.equal(line + pickup + delivery + insurance, total,
        'иначе на экране разбивка не сойдётся с показанной суммой');
});

test('три способа доставки — наземный, экспресс и авиа', () => {
    const quotes = parseDellinResponse(FIXTURE);
    assert.deepEqual(quotes.map((q) => q.service), ['auto', 'express', 'avia']);
    assert.equal(quotes[0].days.min, 5);
    assert.equal(quotes[1].days.min, 4, 'экспресс быстрее наземного');
});

test('срок, которого в ответе нет, не выдумывается', () => {
    const avia = parseDellinResponse(FIXTURE).find((q) => q.service === 'avia');
    assert.equal(avia.days, null, 'у авиа в ответе нет time — в таблице будет прочерк');
});

test('без забора и доставки в итог идёт только плечо со страховкой', () => {
    const [auto] = parseDellinResponse(FIXTURE, { doorFrom: false, doorTo: false });
    assert.equal(auto.price.pickup, 0);
    assert.equal(auto.price.delivery, 0);
    assert.equal(auto.doorToDoor, false);
    assert.equal(auto.price.total, auto.price.line + auto.price.insurance);
});

test('ошибки перевозчика дают пустой список, а не выдуманную цену', () => {
    assert.deepEqual(parseDellinResponse({ errors: { derivalpoint: 'Код КЛАДР не найден' } }), []);
    assert.deepEqual(parseDellinResponse(null), []);
    assert.deepEqual(parseDellinResponse({}), []);
});

// --- выбор кода города ------------------------------------------------------

const SEARCH_RESULT = [
    { code: '6600000100000000000000000', aString: 'Екатеринбург г (Свердловская обл.)', searchString: 'Екатеринбург', isTerminal: 1 },
    { code: '7200100098900000000000000', aString: '310 км Екатеринбург-Тюмень автодорога (Тюменская обл.)', searchString: '310 км Екатеринбург-Тюмень', isTerminal: 0 },
];

test('из выдачи берётся город, а не автодорога с похожим названием', () => {
    assert.equal(pickCityCode(SEARCH_RESULT, 'Екатеринбург'), '6600000100000000000000000');
});

test('при равных названиях предпочитается город с терминалом', () => {
    const code = pickCityCode([
        { code: 'AAA', searchString: 'Дубровка', isTerminal: 0 },
        { code: 'BBB', searchString: 'Дубровка', isTerminal: 1 },
    ], 'Дубровка');
    assert.equal(code, 'BBB');
});

test('точного совпадения нет — кода нет', () => {
    assert.equal(pickCityCode(SEARCH_RESULT, 'Нью-Васюки'), null);
    assert.equal(pickCityCode([], 'Москва'), null);
    assert.equal(pickCityCode(null, 'Москва'), null);
});

// --- расчёт -----------------------------------------------------------------

test('без ключа перевозчик молча выпадает, а не роняет расчёт', async () => {
    const saved = process.env.DELLIN_APP_KEY;
    delete process.env.DELLIN_APP_KEY;
    try {
        assert.deepEqual(await quote({ from: MOSCOW, to: EKB, places: PLACES }), []);
    } finally {
        if (saved !== undefined) process.env.DELLIN_APP_KEY = saved;
    }
});

test('без кода города в сеть не ходим', async () => {
    process.env.DELLIN_APP_KEY = process.env.DELLIN_APP_KEY || 'test-key';
    assert.deepEqual(await quote({ from: MOSCOW, to: { codes: {} }, places: PLACES }), []);
    assert.deepEqual(await quote({ from: MOSCOW, to: EKB, places: [] }), []);
    assert.deepEqual(await quote({ from: MOSCOW, to: EKB, places: [{ width: 0, length: 0, height: 0, weight: 0 }] }), []);
});
