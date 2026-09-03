'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/* ТЗ, 8.2: «При нулевом результате — возможность разместить заказ». Пустая
 * выдача каталога до сих пор была тупиком: человек сформулировал потребность,
 * получил «ничего не нашлось» и уходил. Чего нет в каталоге, у нас часто нет в
 * профилях, а не в стране, — и закупка находит завод там, где поиск не нашёл. */

test('пустая выдача каталога предлагает разместить закупку', () => {
    const src = read('catalog.html');
    assert.match(src, /ничего не нашлось/, 'текст пустой выдачи на месте');
    assert.match(src, /index\.html\?create=1&title=\$\{encodeURIComponent\(query\)\}/,
        'из пустой выдачи должен быть выход в создание закупки с перенесённым запросом');
});

test('кабинет заказчика открывает форму и подставляет название из запроса', () => {
    const src = read('index.html');
    assert.match(src, /params\.get\('create'\) === '1'/);
    assert.match(src, /params\.get\('title'\)/, 'название закупки берётся из адреса');
    assert.match(src, /getElementById\('orderName'\)\.value = title/);
    // Обрезка обязательна: адресную строку правит кто угодно, а поле названия
    // уезжает в заголовок закупки и в письма заводам.
    assert.match(src, /slice\(0, 200\)/, 'название из адреса должно обрезаться');
});

test('нулевая выдача попадает в журнал и в лог редакции', () => {
    const src = read('routes', 'ai.js');
    assert.match(src, /if \(!found\) console\.warn/, 'редакция должна видеть запрос без результатов');
    assert.match(src, /resultsCount: found/, 'число результатов пишется в журнал');
});
