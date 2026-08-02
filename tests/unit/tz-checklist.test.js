'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonFromLlm } = require('../../lib/ai-client');

// Чек-лист приходит от модели то строками, то объектами. Логика приведения живёт
// в generateProcurementTz; здесь проверяем разбор ответа и саму нормализацию тем
// же способом, каким её делает функция.
function normalizeChecklist(parsed) {
    return Array.isArray(parsed.checklist)
        ? parsed.checklist
            .map(item => {
                if (item && typeof item === 'object') {
                    const head = String(item.title || item.name || '').trim();
                    const body = String(item.description || item.text || '').trim();
                    return [head, body].filter(Boolean).join(': ');
                }
                return String(item == null ? '' : item).trim();
            })
            .filter(Boolean)
            .slice(0, 6)
        : [];
}

test('разбор ответа: голый JSON', () => {
    const p = parseJsonFromLlm('{"title":"Манжеты","description":"текст","checklist":["раз"]}');
    assert.equal(p.title, 'Манжеты');
});

test('разбор ответа: JSON в markdown-обёртке', () => {
    const p = parseJsonFromLlm('```json\n{"title":"Фланцы","description":"д"}\n```');
    assert.equal(p.title, 'Фланцы');
});

test('разбор ответа: пояснение вокруг объекта', () => {
    const p = parseJsonFromLlm('Вот ТЗ:\n{"title":"Втулки","description":"д"}\nГотово.');
    assert.equal(p.title, 'Втулки');
});

test('чек-лист объектами не превращается в [object Object]', () => {
    const items = normalizeChecklist({
        checklist: [
            { title: 'Технические характеристики', description: 'уточнить твёрдость' },
            { name: 'Сроки', text: 'согласовать дату отгрузки' },
        ],
    });
    assert.deepEqual(items, [
        'Технические характеристики: уточнить твёрдость',
        'Сроки: согласовать дату отгрузки',
    ]);
    assert.ok(!items.join(' ').includes('[object'));
});

test('чек-лист строками остаётся строками, пустые пункты выбрасываются', () => {
    assert.deepEqual(normalizeChecklist({ checklist: ['раз', '', '  ', 'два'] }), ['раз', 'два']);
});

test('чек-лист длиннее шести пунктов обрезается', () => {
    const items = normalizeChecklist({ checklist: Array.from({ length: 10 }, (_, i) => `пункт ${i}`) });
    assert.equal(items.length, 6);
});

test('чек-листа нет — получаем пустой массив, а не падение', () => {
    assert.deepEqual(normalizeChecklist({}), []);
    assert.deepEqual(normalizeChecklist({ checklist: 'строка' }), []);
});
