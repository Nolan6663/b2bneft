'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonFromLlm, repairLlmJson } = require('../../lib/ai-client');

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

// Обе поломки ниже сняты с живых ответов GigaChat на генерации ТЗ 02.08.2026 —
// из-за них прод отдавал 500 «Не удалось разобрать ответ модели».
test('разбор ответа: лишний пустой литерал вместо запятой между полями', () => {
    const p = parseJsonFromLlm([
        '{',
        '  "title": "Манжеты уплотнительные РТИ",',
        '  "description": "1. Назначение\\n  Уплотнение соединений."',
        '  "",',
        '  "checklist": ["Проверить размеры"]',
        '}',
    ].join('\n'));
    assert.equal(p.title, 'Манжеты уплотнительные РТИ');
    assert.ok(p.description.includes('Уплотнение соединений'));
    assert.deepEqual(p.checklist, ['Проверить размеры']);
});

test('разбор ответа: живые переводы строки внутри значения', () => {
    const p = parseJsonFromLlm('{"title":"Шкаф НКУ","description":"1. Назначение: распределение.\n\n2. Ток: 400 А.\tIP54","checklist":["Проверить ГОСТ"]}');
    assert.equal(p.title, 'Шкаф НКУ');
    assert.ok(p.description.includes('\n\n2. Ток'));
    assert.ok(p.description.includes('\tIP54'));
});

test('разбор ответа: обе поломки разом и текст вокруг объекта', () => {
    const p = parseJsonFromLlm([
        'Вот ТЗ:',
        '{',
        '  "title": "Фланцы 09Г2С",',
        '  "description": "1. Назначение: соединение трубопроводов.',
        '2. Материал: сталь 09Г2С."',
        '  "",',
        '  "checklist": ["Сертификаты качества"]',
        '}',
        'Готово.',
    ].join('\n'));
    assert.equal(p.title, 'Фланцы 09Г2С');
    assert.ok(p.description.includes('2. Материал'));
});

test('починка не трогает валидный JSON и настоящие пустые значения', () => {
    const src = '{"title":"","description":"a\\nb","checklist":["",""]}';
    assert.equal(repairLlmJson(src), src);
    const p = parseJsonFromLlm(src);
    assert.equal(p.title, '');
    assert.equal(p.description, 'a\nb');
    assert.deepEqual(p.checklist, ['', '']);
});

test('неразбираемый ответ по-прежнему кидает ошибку, а не выдумывает объект', () => {
    assert.throws(() => parseJsonFromLlm('Извините, не могу помочь с этим запросом.'));
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
