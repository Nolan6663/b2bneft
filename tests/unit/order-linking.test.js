'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectEntities, applyLinks, orderText, AUTO } = require('../../lib/order-linking');

/* Связи заявки со справочником заменили поиск подстроки по заголовку. Прежний
   способ давал «вальцовку» в ответ на «вал» и «нарезку резьбы» в ответ на
   «резку»: исполнитель приходил из поиска за одним, а видел другое. */

const SERVICES = [
    { id: 1, name: 'Токарная обработка', synonyms: ['токарка', 'точение'] },
    { id: 2, name: 'Фрезерная обработка' },
    { id: 3, name: 'Лазерная резка' },
];
const PRODUCTS = [
    { id: 10, name: 'Валы' },
    { id: 11, name: 'Фланцы' },
];

const detect = (order) => detectEntities(order, SERVICES, PRODUCTS);

test('в разбор идут заголовок, категория и описание', () => {
    const text = orderText({ title: 'Вал ступенчатый', category: 'Металлообработка', description: 'Точение и шлифовка' });
    assert.match(text, /Вал ступенчатый/);
    assert.match(text, /Металлообработка/);
    assert.match(text, /Точение/);
});

test('заявка связывается и с изделием, и с услугой', () => {
    const r = detect({ title: 'Вал ступенчатый Ø40', description: 'Токарная обработка, сталь 45, 40 шт' });
    assert.deepEqual(r.products, [10]);
    assert.deepEqual(r.services, [1]);
});

test('синоним в описании засчитывается', () => {
    const r = detect({ title: 'Деталь по чертежу', description: 'Нужно точение' });
    assert.deepEqual(r.services, [1]);
});

test('однокоренной мусор не создаёт связь', () => {
    // Ровно тот случай, ради которого уходили от поиска подстроки.
    assert.deepEqual(detect({ title: 'Вальцовка листа', description: '' }).products, []);
    assert.deepEqual(detect({ title: 'Нарезка резьбы', description: '' }).services, [],
        '«резка» без «лазерной» — не лазерная резка');
});

test('пустая заявка не связывается ни с чем', () => {
    assert.deepEqual(detect({ title: '', description: '' }), { services: [], products: [] });
    assert.deepEqual(detect({}), { services: [], products: [] });
});

/* Запись связей. Главное требование — не затирать выбор человека: ТЗ §6.8
   разрешает ручное исправление, а исправление, которое переписывают обратно,
   исправлением не является. */

function fakeClient() {
    const calls = [];
    return { calls, async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
}

test('прежний автоматический разбор снимается перед новым', () => {
    // Заголовок могли переписать, и старые связи больше не верны.
    const c = fakeClient();
    return applyLinks(c, 7, { services: [1], products: [] }).then(() => {
        const del = c.calls.filter(x => /DELETE FROM order_/i.test(x.sql));
        assert.equal(del.length, 2, 'чистятся обе таблицы связей');
        for (const d of del) {
            assert.equal(d.params[1], AUTO, 'удаляются только автоматические связи');
            assert.match(d.sql, /confirmation = \$2/);
        }
    });
});

test('ручные связи заказчика переживают повторный разбор', async () => {
    const c = fakeClient();
    await applyLinks(c, 7, { services: [1, 2], products: [10] });
    const inserts = c.calls.filter(x => /INSERT INTO order_/i.test(x.sql));
    assert.equal(inserts.length, 3);
    for (const i of inserts) {
        assert.match(i.sql, /ON CONFLICT DO NOTHING/i, 'выбор заказчика не перетирается');
        assert.equal(i.params[2], AUTO);
    }
});

test('разбор без совпадений не оставляет мусорных вставок', async () => {
    const c = fakeClient();
    const res = await applyLinks(c, 7, { services: [], products: [] });
    assert.deepEqual(res, { services: 0, products: 0 });
    assert.equal(c.calls.filter(x => /INSERT/i.test(x.sql)).length, 0);
});
