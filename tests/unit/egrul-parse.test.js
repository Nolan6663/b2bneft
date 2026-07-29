'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickRegistryRow, mapRegistryRow } = require('../../lib/egrul-verify');

// Реальный ответ egrul.nalog.ru по ИНН 650112190630: действующее ИП и прекращённое
// по той же фамилии до её смены. Порядок строк реестром не гарантируется.
const ROWS_IP = [
    { r: '16.01.2026', i: '650112190630', k: 'fl', n: 'ЛАПШИНА ДИАНА НИКОЛАЕВНА', o: '326650000001066' },
    { r: '20.07.2021', i: '650112190630', k: 'fl', n: 'ГАЛИУЛЛИНА ДИАНА НИКОЛАЕВНА', o: '321650100015109', e: '24.07.2025' },
];

test('ЕГРЮЛ: из нескольких записей берётся действующая, а не первая', () => {
    const row = pickRegistryRow(ROWS_IP);
    assert.equal(row.o, '326650000001066');

    const reversed = pickRegistryRow([...ROWS_IP].reverse());
    assert.equal(reversed.o, '326650000001066', 'порядок строк не должен влиять на выбор');
});

test('ЕГРЮЛ: запись разбирается в данные для верификации', () => {
    const data = mapRegistryRow(pickRegistryRow(ROWS_IP));
    assert.deepEqual(data, {
        name: 'ЛАПШИНА ДИАНА НИКОЛАЕВНА',
        active: true,
        regDate: '2026-01-16',
        ogrn: '326650000001066',
    });
});

test('ЕГРЮЛ: прекращённая деятельность даёт active=false', () => {
    const terminated = mapRegistryRow({ r: '20.07.2021', n: 'ГАЛИУЛЛИНА ДИАНА НИКОЛАЕВНА', o: '321650100015109', e: '24.07.2025' });
    assert.equal(terminated.active, false);
});

// Реальная строка по ИНН 7707083893: `g` — руководитель, не ликвидация.
test('ЕГРЮЛ: указанный руководитель не считается ликвидацией', () => {
    const sber = {
        r: '16.08.2002', n: 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "СБЕРБАНК РОССИИ"', o: '1027700132195',
        g: 'ПРЕЗИДЕНТ, ПРЕДСЕДАТЕЛЬ ПРАВЛЕНИЯ: Греф Герман Оскарович',
    };
    assert.equal(mapRegistryRow(sber).active, true);
    assert.equal(pickRegistryRow([sber]).o, '1027700132195');
});

test('ЕГРЮЛ: пустой и битый ответ не роняют разбор', () => {
    assert.equal(pickRegistryRow([]), null);
    assert.equal(pickRegistryRow(null), null);
    assert.equal(mapRegistryRow(null), null);
    assert.equal(mapRegistryRow({ n: 'БЕЗ ДАТЫ', o: '' }).regDate, null);
    assert.equal(mapRegistryRow({ n: 'БЕЗ ОГРН' }).ogrn, '');
});

test('ЕГРЮЛ: ОГРН приводится к строке, ведущие нули не теряются', () => {
    assert.equal(mapRegistryRow({ n: 'X', o: 326650000001066 }).ogrn, '326650000001066');
});
