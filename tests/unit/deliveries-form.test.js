'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'deliveries.html'), 'utf8');

/* Форма расчёта доставки жила без собственных стилей: глобальные правила задают
   инпуту только рамку и шрифт, поэтому поле оставалось шириной «по умолчанию»,
   не тянулось на ячейку сетки, а подпись вставала слева и липла к рамке.
   Выглядело как съехавшая вёрстка (замечание владельца 19.08.2026).

   Тесты сторожат не красоту, а те три условия, без которых она снова разъедется. */

test('раскладка: у каждой подписи есть своя обёртка с полем', () => {
    // Голый <label> рядом с <input> — это и есть та самая «подпись сбоку».
    const bare = [...html.matchAll(/<div>\s*<label[^>]*>[^<]*<\/label>\s*<input/g)];
    assert.equal(bare.length, 0, 'подпись с полем лежат в голом <div> — поле не растянется на ячейку');
});

test('раскладка: поле занимает всю ширину своей ячейки', () => {
    assert.match(html, /\.dv-field > input \{ width: 100%; \}/,
        'без этого правила инпут остаётся шириной по умолчанию и сетка едет');
    assert.match(html, /\.dv-field \{ display: flex; flex-direction: column;/,
        'подпись должна стоять над полем, а не слева от него');
});

test('раскладка: колонки габаритов переносятся по месту, а не по ширине окна', () => {
    /* Контент уже окна на ширину сайдбара, и он ещё и сворачивается. Брейкпоинт
       по окну в такой ситуации врёт: поля должны переноситься тогда, когда
       перестали помещаться в свой контейнер. */
    assert.match(html, /\.dv-grid-dims\s+\{ grid-template-columns: repeat\(auto-fit,/);
    assert.doesNotMatch(html, /@media[^{]*\{\s*\.dv-grid-dims \{ grid-template-columns: repeat\(\d/,
        'вернулся брейкпоинт по ширине окна — он не знает про сайдбар');
});

test('плитки считают доставки и подписаны как доставки', () => {
    // Подписаны были «сделки», а считаются доставки — чужая цифра на своей странице.
    const tiles = html.slice(html.indexOf('class="kpi-row"'), html.indexOf('Все доставки'));
    assert.match(tiles, /Всего доставок/);
    assert.doesNotMatch(tiles, /Всего сделок/);
});

test('в строке груза количество отделено от габаритов', () => {
    /* Пятое поле в ряду из четырёх переносилось само и читалось как сломанная
       вёрстка. «Одинаковых мест» — множитель, а не размер: ему своя строка. */
    const row = html.slice(html.indexOf('row.innerHTML'), html.indexOf('row.querySelector'));
    const dims = row.slice(row.indexOf('dv-grid-dims'), row.indexOf('dv-place-foot'));
    assert.ok(dims.includes('data-f="length"') && dims.includes('data-f="weight"'), 'габариты не на месте');
    assert.ok(!dims.includes('data-f="quantity"'), 'количество снова попало в сетку габаритов');
});
