'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trimSubject } = require('../../lib/outreach');

test('тема письма: короткая остаётся как есть', () => {
    assert.equal(trimSubject('Прямые заказы на ТехЗаказ'), 'Прямые заказы на ТехЗаказ');
});

test('тема письма: длинная режется по границе слова, а не посреди', () => {
    // Реальный случай из outreach.log 29.07.2026: тема оборвалась на «оборудован».
    const raw = 'Присоединяйтесь к ТехЗаказу для поиска заказчиков щебнеочистительного оборудования';
    const out = trimSubject(raw);
    assert.ok(out.length <= 80, `длина ${out.length} должна быть не больше 80`);
    assert.ok(raw.startsWith(out), 'тема должна быть началом исходной строки');
    assert.doesNotMatch(out, /оборудован$/, 'слово не должно быть разрублено');
    // 82 знака: по границе слова отбрасывается только последнее слово «оборудования»
    assert.equal(out.split(' ').pop(), 'щебнеочистительного');
});

test('тема письма: хвостовая пунктуация после обрезки убирается', () => {
    const out = trimSubject('Оборудование для нефтесервиса, металлообработки, арматуры и электротехники — присоединяйтесь');
    assert.ok(out.length <= 80);
    assert.doesNotMatch(out, /[\s,;:—-]$/, 'не должно оканчиваться на запятую или тире');
});

test('тема письма: пробелы нормализуются, края обрезаются', () => {
    assert.equal(trimSubject('  Прямые   заказы  '), 'Прямые заказы');
});

test('тема письма: одно слово длиннее лимита режется жёстко, чтобы уложиться', () => {
    const out = trimSubject('А'.repeat(120));
    assert.equal(out.length, 80);
});

test('тема письма: пустое и мусорное на входе не роняют', () => {
    assert.equal(trimSubject(''), '');
    assert.equal(trimSubject(null), '');
    assert.equal(trimSubject(undefined), '');
});
