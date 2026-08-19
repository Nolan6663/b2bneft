'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickCity } = require('../../lib/logistics/geo');
const { quoteAll } = require('../../lib/logistics');
const { buildQuotesWorkbook } = require('../../lib/logistics/quote-xlsx');

/* Два замечания с живого расчёта Зеленоград → Химки (18.08.2026).

   Первое: «сам город активен, но не даёт закрепить». Город и его промзона
   лежат в справочнике с одним ключом и оба не терминалы — выбрать можно было
   только промзону, потому что у неё есть уточнение.

   Второе: «лидером оказался ПЭК, других я не вижу». Двое других не ответили
   не потому, что отказались, а потому что их не спросили: кода города нет.
   В ответе при этом было failed: [] — мы и сами не различали эти случаи. */

const row = (id, name, qualifier, is_hub) => ({ id, name, qualifier, is_hub, pecom_id: String(id) });

test('город побеждает свою промзону', () => {
    const picked = pickCity([
        row(2310, 'Зеленоград', '', false),
        row(2482, 'Зеленоград (промзона)', 'промзона', false),
    ]);
    assert.equal(picked.status, 'ok');
    assert.equal(picked.point.name, 'Зеленоград');
});

test('настоящие двойники по-прежнему спрашивают человека', () => {
    // У обоих есть уточнение — какой из них имелся в виду, знает только он.
    const picked = pickCity([
        row(1, 'Белый Яр (Алтайский р-н)', 'Алтайский р-н', false),
        row(2, 'Белый Яр (Верхнекетский р-н)', 'Верхнекетский р-н', false),
    ]);
    assert.equal(picked.status, 'ambiguous');
    assert.equal(picked.candidates.length, 2);
});

test('район — не часть города: тут по-прежнему выбирает человек', () => {
    /* Граница нового правила. «(промзона)» — часть Зеленограда, а
       «(Алтайский р-н)» — отдельный посёлок с тем же именем. Расширить
       правило на районы значит однажды молча увезти груз не туда. */
    const picked = pickCity([
        row(1, 'Белый Яр', '', false),
        row(2, 'Белый Яр (Алтайский р-н)', 'Алтайский р-н', false),
    ]);
    assert.equal(picked.status, 'ambiguous');
});

test('терминал по-прежнему сильнее правила о городе', () => {
    // Хаб выигрывает раньше: там есть терминал, и человек почти наверняка про него.
    const picked = pickCity([
        row(1, 'Дубровка', '', false),
        row(2, 'Дубровка (Всеволожский р-н)', 'Всеволожский р-н', true),
    ]);
    assert.equal(picked.status, 'ok');
    assert.equal(picked.point.name, 'Дубровка (Всеволожский р-н)');
});

test('молчание перевозчика отличается от отказа', async () => {
    const pool = { async query() { return { rows: [] }; } };
    const carriers = [
        { CARRIER: 'pecom', CARRIER_NAME: 'ПЭК', quote: async () => [{ carrierName: 'ПЭК', price: { total: 5560 } }] },
        // Нет кода города — модуль честно возвращает пустоту, а не ошибку.
        { CARRIER: 'dellin', CARRIER_NAME: 'Деловые Линии', quote: async () => [] },
        { CARRIER: 'vozovoz', CARRIER_NAME: 'Возовоз', quote: async () => { throw new Error('502'); } },
    ];
    const res = await quoteAll(pool, { from: {}, to: {}, places: [] }, { carriers, useCache: false });

    assert.equal(res.quotes.length, 1);
    assert.deepEqual(res.failed, ['Возовоз'], 'упал — значит можно попробовать позже');
    assert.deepEqual(res.silent, ['Деловые Линии'], 'не спросили — ждать нечего, справочник не изменится');
});

test('в книге сказано и про неответивших, и про тех, кто маршрут не считает', () => {
    const wb = buildQuotesWorkbook({
        from: { name: 'Зеленоград' }, to: { name: 'Химки' },
        items: [{ length: 1, width: 0.8, height: 0.6, weight: 57, quantity: 1 }],
        doorFrom: true, doorTo: true,
        quotes: [{ carrierName: 'ПЭК', service: 'auto', days: null, price: { total: 5560, line: 500 } }],
        failed: ['Возовоз'],
        silent: ['Деловые Линии'],
    });
    const text = [];
    wb.getWorksheet('Доставка').eachRow((r) => r.eachCell((c) => text.push(String(c.value))));
    const all = text.join(' | ');

    assert.match(all, /Не ответили на запрос: Возовоз/);
    assert.match(all, /Не считают этот маршрут: Деловые Линии/);
});
