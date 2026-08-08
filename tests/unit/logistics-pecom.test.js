'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    quote,
    parsePecomResponse,
    buildQuery,
    parseDays,
    parseDaysFromHtml,
} = require('../../lib/logistics/pecom');

/* Расчёт доставки ПЭК. Тесты идут по сохранённому живому ответу, в сеть не
   ходят: их гоняет деплойный гейт, и падение чужого сайта не должно
   останавливать нашу выкатку. Живая проверка — scripts/check-logistics.js.

   Фикстура снята 2026-08-08: Москва → Екатеринбург, одно место 1 м³, 500 кг,
   страховка на 100 000 ₽. */

const FIXTURE = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'logistics', 'pecom-msk-ekb.json'), 'utf8')
);

const MOSCOW = { codes: { pecom: '-446' } };
const EKB = { codes: { pecom: '-473' } };

test('запрос: места идут повторяющимися параметрами в нужном порядке', () => {
    const q = buildQuery({
        from: '-446', to: '-473', insurance: 100000,
        places: [{ width: 1, length: 2, height: 0.5, weight: 500 }],
    });
    assert.match(q, /places\[0\]\[\]=1&places\[0\]\[\]=2&places\[0\]\[\]=0\.5&places\[0\]\[\]=1&places\[0\]\[\]=500&places\[0\]\[\]=0&places\[0\]\[\]=0/);
    assert.match(q, /take\[town\]=-446/);
    assert.match(q, /deliver\[town\]=-473/);
    assert.match(q, /strah=100000/);
});

test('запрос: объём считается из габаритов, если не задан явно', () => {
    const q = buildQuery({ from: '-446', to: '-473', places: [{ width: 2, length: 3, height: 0.5, weight: 100 }] });
    assert.match(q, /places\[0\]\[\]=2&places\[0\]\[\]=3&places\[0\]\[\]=0\.5&places\[0\]\[\]=3&/, '2 × 3 × 0.5 = 3 м³');
});

test('запрос: несколько мест нумеруются отдельно', () => {
    const q = buildQuery({
        from: '-446', to: '-473',
        places: [{ width: 1, length: 1, height: 1, weight: 100 }, { width: 2, length: 2, height: 1, weight: 300 }],
    });
    assert.match(q, /places\[1\]\[\]=2/);
});

test('запрос: страховка не передаётся, если не заказана', () => {
    const q = buildQuery({ from: '-446', to: '-473', insurance: 0, places: [{ width: 1, length: 1, height: 1, weight: 10 }] });
    assert.doesNotMatch(q, /strah=/);
});

test('разбор: авто и авиа — два отдельных варианта', () => {
    const quotes = parsePecomResponse(FIXTURE);
    assert.equal(quotes.length, 2);
    assert.deepEqual(quotes.map((q) => q.service), ['auto', 'avia']);
});

test('разбор: составляющие цены совпадают с живым ответом', () => {
    const [auto] = parsePecomResponse(FIXTURE);
    assert.equal(auto.price.line, 12900, 'перевозка Москва — Екатеринбург');
    assert.equal(auto.price.pickup, 2650, 'забор груза');
    assert.equal(auto.price.delivery, 1350, 'доставка получателю');
    assert.equal(auto.price.insurance, 682, 'страхование, 681.6 округляется');
});

test('страхование в итог не входит: у перевозчиков разная база', () => {
    const [auto] = parsePecomResponse(FIXTURE);
    assert.equal(auto.price.total, 12900 + 2650 + 1350, 'итог — только перевозка');
    assert.ok(auto.price.insurance > 0, 'но саму сумму страховки показываем');
});

test('разбор: срок берётся из структурного поля', () => {
    const [auto] = parsePecomResponse(FIXTURE);
    assert.deepEqual(auto.days, { min: 4, max: 7 });
});

test('разбор: у авиа свой срок из своего блока', () => {
    const [, avia] = parsePecomResponse(FIXTURE);
    assert.equal(avia.price.line, 91500);
    assert.deepEqual(avia.days, { min: 1, max: 5 }, 'авиа быстрее — это и есть смысл показывать оба варианта');
});

test('разбор: без забора и доставки в итог идёт только плечо', () => {
    const [auto] = parsePecomResponse(FIXTURE, { doorFrom: false, doorTo: false });
    assert.equal(auto.price.pickup, 0);
    assert.equal(auto.price.delivery, 0);
    assert.equal(auto.price.total, 12900);
    assert.equal(auto.doorToDoor, false);
});

test('разбор: забор без доставки считается отдельно', () => {
    const [auto] = parsePecomResponse(FIXTURE, { doorFrom: true, doorTo: false });
    assert.equal(auto.price.pickup, 2650);
    assert.equal(auto.price.delivery, 0);
});

test('разбор: страхование ищется по названию, а не по номеру ADD_N', () => {
    const moved = { ...FIXTURE };
    delete moved.ADD_3;
    moved.ADD_1 = { '1': 'Страхование', '2': '', '3': 681.6 };
    const [auto] = parsePecomResponse(moved);
    assert.equal(auto.price.insurance, 682, 'услуга переехала в другой слот — сумма всё равно найдена');
});

test('разбор: посторонняя услуга не считается страхованием', () => {
    const other = { ...FIXTURE };
    delete other.ADD_3;
    other.ADD_1 = { '1': 'Обрешётка', '2': '', '3': 5000 };
    const [auto] = parsePecomResponse(other);
    assert.equal(auto.price.insurance, 0, 'обрешётка — не страховка');
});

test('разбор: ошибка перевозчика даёт пустой список, а не выдуманную цену', () => {
    assert.deepEqual(parsePecomResponse({ error: 'Направление не обслуживается' }), []);
});

test('разбор: мусор вместо ответа не роняет модуль', () => {
    assert.deepEqual(parsePecomResponse(null), []);
    assert.deepEqual(parsePecomResponse('внезапно строка'), []);
    assert.deepEqual(parsePecomResponse({}), []);
});

test('разбор: нулевая цена не считается предложением', () => {
    assert.deepEqual(parsePecomResponse({ auto: ['Стоимость', 'Маршрут', 0] }), []);
});

test('срок: структурное поле важнее разметки', () => {
    assert.deepEqual(parseDays({ periods_days: '3 - 5', periods: 'Количество суток в пути: 9 - 9' }), { min: 3, max: 5 });
});

test('срок: разметка разбирается, когда структурного поля нет', () => {
    const html = '<br/><p><b>Количество суток в пути</b>: <span class="periods"><span>4 - 7</span></span></p>';
    assert.deepEqual(parseDaysFromHtml(html), { min: 4, max: 7 });
});

test('срок: одно число — это и минимум, и максимум', () => {
    assert.deepEqual(parseDays({ periods_days: '5' }), { min: 5, max: 5 });
});

test('срок: неразобранная разметка даёт null, а не выдуманное число', () => {
    assert.equal(parseDaysFromHtml('<p>уточняйте у менеджера</p>'), null);
    assert.equal(parseDays({}), null);
});

test('расчёт: без кода города перевозчик молча выпадает', async () => {
    assert.deepEqual(await quote({ from: MOSCOW, to: { codes: {} }, places: [{ width: 1, length: 1, height: 1, weight: 10 }] }), []);
    assert.deepEqual(await quote({ from: null, to: EKB, places: [{ width: 1, length: 1, height: 1, weight: 10 }] }), []);
});

test('расчёт: без габаритов в сеть не ходим', async () => {
    assert.deepEqual(await quote({ from: MOSCOW, to: EKB, places: [] }), []);
});
