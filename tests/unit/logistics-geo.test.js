'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakePool } = require('./helpers');
const {
    normalizeCityName,
    extractQualifier,
    parsePecomTowns,
    pickCity,
    resolveCity,
    suggestCities,
    saveCities,
} = require('../../lib/logistics/geo');

/* Гео-слой расчёта доставки. Города в companies.city — свободный текст, который
   заполняли люди, а перевозчики ждут свои коды.

   Главное, что здесь проверяется, — что слой не угадывает. В справочнике ПЭК
   307 названий встречаются больше одного раза: «Белый Яр» есть под Абаканом и
   под Сургутом. Молчаливый выбор одного из двух означал бы цену доставки до
   города за 2500 км от нужного, и человек ей поверит. */

test('нормализация: регистр, ё и лишние пробелы', () => {
    assert.equal(normalizeCityName('  МоСквА '), 'москва');
    assert.equal(normalizeCityName('Орёл'), 'орел');
});

test('нормализация: срезаются префиксы населённых пунктов', () => {
    assert.equal(normalizeCityName('г. Москва'), 'москва');
    assert.equal(normalizeCityName('г Москва'), 'москва');
    assert.equal(normalizeCityName('пос. Северный'), 'северный');
    assert.equal(normalizeCityName('пгт Зеленоборский'), 'зеленоборский');
});

test('нормализация: одиночная буква внутри названия не считается префиксом', () => {
    assert.equal(normalizeCityName('Старый Оскол'), 'старый оскол');
    assert.equal(normalizeCityName('Гаврилов Посад'), 'гаврилов посад');
});

test('нормализация: скобочное уточнение района отбрасывается', () => {
    assert.equal(normalizeCityName('Белый Яр (Алтайский р-н)'), 'белый яр');
    assert.equal(normalizeCityName('Павловск (Санкт-Петербург)'), 'павловск');
});

test('нормализация: дефис и пробел равнозначны', () => {
    assert.equal(normalizeCityName('Ростов-на-Дону'), normalizeCityName('Ростов на Дону'));
    assert.equal(normalizeCityName('Санкт-Петербург'), 'санкт петербург');
});

test('нормализация: разговорные формы из профилей компаний', () => {
    const spb = normalizeCityName('Санкт-Петербург');
    assert.equal(normalizeCityName('СПб'), spb);
    assert.equal(normalizeCityName('питер'), spb);
    assert.equal(normalizeCityName('г. СПб'), spb);
    assert.equal(normalizeCityName('ЕКБ'), 'екатеринбург');
});

test('нормализация: пустое и мусорное дают пустой ключ', () => {
    assert.equal(normalizeCityName(''), '');
    assert.equal(normalizeCityName(null), '');
    assert.equal(normalizeCityName('   '), '');
    assert.equal(normalizeCityName('!!! ???'), '');
});

test('уточнение из скобок сохраняется отдельно от ключа', () => {
    assert.equal(extractQualifier('Белый Яр (Алтайский р-н)'), 'Алтайский р-н');
    assert.equal(extractQualifier('Москва'), '');
});

test('разбор справочника ПЭК: хаб отличается от населённого пункта', () => {
    const cities = parsePecomTowns({
        'Москва Восток': { '-446': 'Москва', '12345': 'Балашиха' },
        'Абакан': { '-584988': 'Абакан', '587941': 'Белый Яр (Алтайский р-н)' },
    });
    assert.equal(cities.length, 4);

    const moscow = cities.find((c) => c.name === 'Москва');
    assert.equal(moscow.pecomId, '-446');
    assert.equal(moscow.pecomHub, 'Москва Восток');
    assert.equal(moscow.isHub, true);

    const belyYar = cities.find((c) => c.searchKey === 'белый яр');
    assert.equal(belyYar.isHub, false);
    assert.equal(belyYar.qualifier, 'Алтайский р-н', 'уточнение нужно, чтобы человек выбрал нужный');
});

test('разбор справочника ПЭК: битый ответ не роняет разбор', () => {
    assert.deepEqual(parsePecomTowns(null), []);
    assert.deepEqual(parsePecomTowns('внезапно строка'), []);
    assert.deepEqual(parsePecomTowns({ 'Хаб': null }), []);
});

test('выбор: единственное совпадение', () => {
    const r = pickCity([{ id: 1, name: 'Балашиха', pecom_id: '12345', is_hub: false }]);
    assert.equal(r.status, 'ok');
    assert.equal(r.point.name, 'Балашиха');
});

test('выбор: хаб побеждает населённый пункт с тем же названием', () => {
    const r = pickCity([
        { id: 2, name: 'Дубровка', pecom_id: '-901', pecom_hub: 'Дубровка', is_hub: true },
        { id: 1, name: 'Дубровка', pecom_id: '900', pecom_hub: 'Брянск', is_hub: false },
    ]);
    assert.equal(r.status, 'ok');
    assert.equal(r.point.codes.pecom, '-901');
});

test('выбор: два одинаковых посёлка в разных концах страны — неоднозначность', () => {
    const r = pickCity([
        { id: 1, name: 'Белый Яр (Алтайский р-н)', qualifier: 'Алтайский р-н', pecom_id: '587941', pecom_hub: 'Абакан', is_hub: false },
        { id: 2, name: 'Белый Яр', pecom_id: '600100', pecom_hub: 'Сургут', is_hub: false },
    ]);
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.point, null, 'ни один не выбирается молча');
    assert.equal(r.candidates.length, 2);
    assert.equal(r.candidates[0].qualifier, 'Алтайский р-н', 'человеку показываем, чем они отличаются');
});

test('выбор: пусто — не найдено', () => {
    const r = pickCity([]);
    assert.equal(r.status, 'not_found');
    assert.equal(r.point, null);
});

test('resolveCity ищет по нормализованному ключу и отдаёт коды перевозчиков', async () => {
    const pool = fakePool([{
        match: /FROM logistics_cities/i,
        rows: [{ id: 7, name: 'Москва', qualifier: '', pecom_id: '-446', pecom_hub: 'Москва Восток', dellin_code: null, is_hub: true }],
    }]);

    const r = await resolveCity(pool, '  г. МОСКВА ');
    assert.equal(r.status, 'ok');
    assert.equal(r.point.codes.pecom, '-446');
    assert.equal(r.point.codes.dellin, null, 'кода Деловых Линий пока нет — это не ошибка');
    assert.equal(pool.calls[0].params[0], 'москва', 'в запрос уходит нормализованный ключ');
});

test('уточнение из скобок разводит двойников', async () => {
    const twins = [
        { id: 1, name: 'Белый Яр (Алтайский р-н)', qualifier: 'Алтайский р-н', pecom_id: '587941', pecom_hub: 'Абакан', is_hub: false },
        { id: 2, name: 'Белый Яр', qualifier: '', pecom_id: '600100', pecom_hub: 'Сургут', is_hub: false },
    ];
    const pool = fakePool([{ match: /FROM logistics_cities/i, rows: twins }]);

    const chosen = await resolveCity(pool, 'Белый Яр (Алтайский р-н)');
    assert.equal(chosen.status, 'ok', 'человек выбрал в подсказках — выбор надо уважать');
    assert.equal(chosen.point.codes.pecom, '587941');
});

test('без уточнения двойники по-прежнему требуют выбора', async () => {
    const twins = [
        { id: 1, name: 'Белый Яр (Алтайский р-н)', qualifier: 'Алтайский р-н', pecom_id: '587941', is_hub: false },
        { id: 2, name: 'Белый Яр', qualifier: '', pecom_id: '600100', is_hub: false },
    ];
    const pool = fakePool([{ match: /FROM logistics_cities/i, rows: twins }]);
    assert.equal((await resolveCity(pool, 'Белый Яр')).status, 'ambiguous');
});

test('уточнение, которого нет ни у одного кандидата, не отсекает всех', async () => {
    const pool = fakePool([{
        match: /FROM logistics_cities/i,
        rows: [{ id: 7, name: 'Москва', qualifier: '', pecom_id: '-446', is_hub: true }],
    }]);
    const found = await resolveCity(pool, 'Москва (Тверская область)');
    assert.equal(found.status, 'ok', 'мусор в скобках не должен ломать разрешение города');
    assert.equal(found.point.codes.pecom, '-446');
});

test('resolveCity: неизвестный город не даёт догадки', async () => {
    const pool = fakePool([{ match: /FROM logistics_cities/i, rows: [] }]);
    const r = await resolveCity(pool, 'Нью-Васюки');
    assert.equal(r.status, 'not_found');
});

test('resolveCity: пустой ввод не ходит в базу', async () => {
    const pool = fakePool([]);
    const r = await resolveCity(pool, '   ');
    assert.equal(r.status, 'not_found');
    assert.equal(pool.calls.length, 0);
});

test('suggestCities: слишком короткий запрос не ходит в базу', async () => {
    const pool = fakePool([]);
    assert.deepEqual(await suggestCities(pool, 'м'), []);
    assert.equal(pool.calls.length, 0);
});

test('suggestCities ищет по префиксу', async () => {
    const pool = fakePool([{
        match: /FROM logistics_cities/i,
        rows: [{ id: 7, name: 'Екатеринбург', qualifier: '', pecom_id: '-473', pecom_hub: 'Екатеринбург', is_hub: true }],
    }]);
    const found = await suggestCities(pool, 'екатер');
    assert.equal(found[0].name, 'Екатеринбург');
    assert.equal(pool.calls[0].params[0], 'екатер%');
});

test('код Деловых Линий добывается один раз и запоминается', async () => {
    const { fillDellinCode } = require('../../lib/logistics/geo');
    let lookups = 0;
    const pool = fakePool([{ match: /UPDATE logistics_cities/i, rows: [] }]);
    const point = { id: 7, name: 'Екатеринбург', codes: { pecom: '-473', dellin: null } };

    await fillDellinCode(pool, point, async () => { lookups += 1; return '6600000100000000000000000'; });
    assert.equal(point.codes.dellin, '6600000100000000000000000');
    assert.equal(pool.calls[0].params[0], '6600000100000000000000000');

    await fillDellinCode(pool, point, async () => { lookups += 1; return 'ещё раз'; });
    assert.equal(lookups, 1, 'код уже есть — второй раз не спрашиваем');
});

test('поиск кода упал — считаем без Деловых Линий, а не падаем', async () => {
    const { fillDellinCode } = require('../../lib/logistics/geo');
    const pool = fakePool([]);
    const point = { id: 7, name: 'Екатеринбург', codes: { pecom: '-473', dellin: null } };

    await fillDellinCode(pool, point, async () => { throw new Error('сеть'); });
    assert.equal(point.codes.dellin, null);
    assert.equal(pool.calls.length, 0, 'в базу ничего не пишем');
});

test('код не нашёлся — в базу пустое не пишем', async () => {
    const { fillDellinCode } = require('../../lib/logistics/geo');
    const pool = fakePool([]);
    const point = { id: 7, name: 'Нью-Васюки', codes: { pecom: '-1', dellin: null } };

    await fillDellinCode(pool, point, async () => null);
    assert.equal(pool.calls.length, 0);
});

test('saveCities пишет пачками, а не по запросу на город', async () => {
    const pool = fakePool([{ match: /INSERT INTO logistics_cities/i, rows: [] }]);
    const cities = Array.from({ length: 7 }, (_, i) => ({
        name: `Город ${i}`, qualifier: '', searchKey: `город ${i}`, pecomId: String(i), pecomHub: 'Хаб', isHub: false,
    }));

    const saved = await saveCities(pool, cities, 3);
    assert.equal(saved, 7);
    assert.equal(pool.calls.length, 3, '7 городов пачками по 3 — это три запроса');
    assert.equal(pool.calls[0].params.length, 18, 'по шесть параметров на город');
    assert.equal(pool.calls[2].params.length, 6, 'последняя пачка неполная');
    assert.match(pool.calls[0].sql, /ON CONFLICT \(pecom_id\)/, 'конфликт держится по id ПЭК, не по названию');
});
