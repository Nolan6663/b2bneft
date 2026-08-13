'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    quote,
    pickLocation,
    parseVozovozResponse,
    sizeOf,
} = require('../../lib/logistics/vozovoz');

/* Возовоз. Тесты идут по сохранённым живым ответам и в сеть не ходят.

   Капкан этого API один, но серьёзный: пункт задаётся названием, а названия у
   них неоднозначны — «Москва» это семь разных мест. Расчёт при этом проходит,
   а о том, что выбор сделан за нас, говорит только warnings в ответе. Поэтому
   здесь отдельно проверяется, что по названию мы не считаем вовсе, а ответ с
   предупреждением про location отбрасывается. */

const fixture = (name) => JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'logistics', name), 'utf8')
);

const DOOR = fixture('vozovoz-msk-ekb.json');
const TERMINAL = fixture('vozovoz-msk-ekb-terminal.json');
const MOSCOW_LOCATIONS = fixture('vozovoz-locations-moskva.json').response.data;
const DUBROVKA_LOCATIONS = fixture('vozovoz-locations-dubrovka.json').response.data;
const NO_TERMINAL = fixture('vozovoz-error-no-terminal.json');

const MOSCOW = { codes: { vozovoz: 'e90f1820-0128-11e5-80c7-00155d903d03' } };
const EKB = { codes: { vozovoz: '17e84adf-0128-11e5-80c7-00155d903d03' } };
const PLACES = [{ width: 1, length: 1, height: 1, weight: 500 }];

test('габариты уходят в килограммах и кубометрах, без пересчёта', () => {
    assert.deepEqual(sizeOf(PLACES), { quantity: 1, volume: 1, weight: 500 });
});

test('места суммируются, количество считается по списку', () => {
    const { quantity, volume, weight } = sizeOf([
        { width: 1, length: 1, height: 1, weight: 300 },
        { width: 1, length: 2, height: 0.5, weight: 700 },
    ]);
    assert.equal(quantity, 2);
    assert.equal(volume, 2);
    assert.equal(weight, 1000, 'вес остаётся в килограммах — в тонны его переводят Деловые Линии, не эти');
});

test('разбивка сходится с их собственным полем price', () => {
    const [auto] = parseVozovozResponse(DOOR);
    const { total, line, pickup, delivery, insurance } = auto.price;
    assert.equal(total + insurance, Math.round(Number(DOOR.response.price)),
        'итог со страховкой обязан совпасть с price — разошлось, значит состав ответа поменялся');
    assert.equal(line + pickup + delivery, total, 'разбивка на экране должна складываться в итог');
    assert.equal(insurance, 179);
    assert.equal(pickup, 3177);
    assert.equal(delivery, 1300);
});

test('страхование вынесено из итога, как у остальных перевозчиков', () => {
    const [auto] = parseVozovozResponse(DOOR);
    assert.equal(auto.price.total, 18260 - 179,
        'у трёх перевозчиков страховка считается по трём разным правилам — в общей колонке её быть не должно');
});

test('до терминала дешевле, чем до двери, и без услуг забора', () => {
    const [door] = parseVozovozResponse(DOOR, { doorFrom: true, doorTo: true });
    const [terminal] = parseVozovozResponse(TERMINAL, { doorFrom: false, doorTo: false });
    assert.ok(terminal.price.total < door.price.total);
    assert.equal(terminal.price.pickup, 0);
    assert.equal(terminal.price.delivery, 0);
    assert.equal(terminal.doorToDoor, false);
    assert.equal(door.doorToDoor, true);
});

test('срок разбирается диапазоном', () => {
    const [auto] = parseVozovozResponse(DOOR);
    assert.deepEqual(auto.days, { min: 3, max: 5 });
    assert.equal(auto.service, 'auto', 'экспресса и авиа у них в этом API нет');
});

test('ответ с предупреждением про location в расчёт не идёт', () => {
    const warned = {
        response: {
            ...DOOR.response,
            warnings: ['Данные узла "gateway.dispatch.location" по запросу "Москва" не содержат уникального значения'],
        },
    };
    assert.deepEqual(parseVozovozResponse(warned), [],
        'предупреждение означает, что пункт выбрали за нас: такая цена посчитана неизвестно откуда');
});

test('предупреждение не про location расчёт не отменяет', () => {
    const warned = { response: { ...DOOR.response, warnings: ['Тариф действует до конца месяца'] } };
    assert.equal(parseVozovozResponse(warned).length, 1);
});

test('«Москва» — семь записей, но терминал один: выбирать не из чего', () => {
    assert.equal(MOSCOW_LOCATIONS.length, 7);
    assert.equal(pickLocation(MOSCOW_LOCATIONS, 'Москва'), 'e90f1820-0128-11e5-80c7-00155d903d03');
});

test('«Дубровка» — двадцать совпадений и пять терминалов: не угадываем', () => {
    const terminals = new Set(DUBROVKA_LOCATIONS.map((l) => l.default_terminal && l.default_terminal.guid));
    assert.ok(terminals.size > 1, 'фикстура должна содержать настоящую неоднозначность');
    assert.equal(pickLocation(DUBROVKA_LOCATIONS, 'Дубровка'), null,
        'пять разных терминалов — цена до чужого конца страны хуже, чем её отсутствие');
});

test('пункт без терминала не выбирается', () => {
    assert.equal(pickLocation([{ name: 'Белый Яр', type: 'пгт' }], 'Белый Яр'), null);
});

test('частичное совпадение названия не считается совпадением', () => {
    const locations = [{
        name: 'Московский',
        type: 'г',
        default_terminal: { guid: 'x' },
    }];
    assert.equal(pickLocation(locations, 'Москва'), null);
});

test('без ключа перевозчик молча выпадает из расчёта', async () => {
    const saved = process.env.VOZOVOZ_TOKEN;
    delete process.env.VOZOVOZ_TOKEN;
    try {
        assert.deepEqual(await quote({ from: MOSCOW, to: EKB, places: PLACES }), []);
    } finally {
        if (saved !== undefined) process.env.VOZOVOZ_TOKEN = saved;
    }
});

test('без guid города расчёта нет, но и падения нет', async () => {
    process.env.VOZOVOZ_TOKEN = 'test';
    try {
        assert.deepEqual(await quote({ from: { codes: {} }, to: EKB, places: PLACES }), []);
        assert.deepEqual(await quote({ from: MOSCOW, to: EKB, places: [] }), []);
    } finally {
        delete process.env.VOZOVOZ_TOKEN;
    }
});

test('«сюда не возим» — это пустой ответ, а не поломка перевозчика', () => {
    // Ошибка 13001 приходит и на несуществующий город, и на город без
    // терминала. Превращать её в исключение нельзя: интерфейс сказал бы
    // «Возовоз не ответил», хотя он ответил, и вполне осмысленно.
    assert.equal(Number(NO_TERMINAL.error.code), 13001);
    assert.deepEqual(parseVozovozResponse(NO_TERMINAL), []);
});
