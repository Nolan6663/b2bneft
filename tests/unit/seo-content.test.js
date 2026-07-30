'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pageWordCount } = require('../../scripts/sync-category-pages');
const { CATEGORIES } = require('../../seo/categories-data');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('объём: категорийные страницы не тоньше 600 слов', () => {
    for (const c of CATEGORIES) {
        const n = pageWordCount(read(path.join('zakupki', `${c.slug}.html`)));
        assert.ok(n >= 600, `zakupki/${c.slug}.html: ${n} слов, нужно ≥ 600`);
    }
});

test('объём: лендинг не тоньше 800 слов', () => {
    const n = pageWordCount(read('landing.html'));
    assert.ok(n >= 800, `landing.html: ${n} слов, нужно ≥ 800`);
});

test('лендинг: перелинковка на все четыре категории', () => {
    const html = read('landing.html');
    for (const c of CATEGORIES) {
        assert.ok(html.includes(`/zakupki/${c.slug}`), `на лендинге нет ссылки на /zakupki/${c.slug}`);
    }
});

// План считал «Как работает ТехЗаказ» дублем текстовой секции и требовал её снести.
// На деле это интерактивная демо-модалка на 4 шага, открываемая кнопкой в герое, —
// в тексте страницы она ничего не дублирует. Владелец решил демо оставить,
// поэтому проверяем не отсутствие заголовка, а что демо цело и доступно с кнопки.
test('лендинг: интерактивное демо на месте и открывается кнопкой', () => {
    const html = read('landing.html');
    assert.match(html, /id="lp-demo-open"/, 'нет кнопки, открывающей демо');
    assert.match(html, /id="lp-demo"/, 'нет самой модалки демо');
    assert.match(html, /aria-controls="lp-demo"/, 'кнопка не связана с модалкой для скринридеров');
});

test('лендинг: устаревшего «1200+ заводов» нет', () => {
    assert.doesNotMatch(read('landing.html'), /1200\+/);
});

test('разметка: JSON-LD на лендинге и категориях парсится, FAQPage на месте', () => {
    const pages = ['landing.html', ...CATEGORIES.map(c => path.join('zakupki', `${c.slug}.html`))];
    for (const rel of pages) {
        const html = read(rel);
        const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
        assert.ok(blocks.length >= 1, `${rel}: нет JSON-LD`);
        // Лендинг описывает всё одним блоком с @graph, категорийные страницы — двумя
        // отдельными блоками. Собираем типы и там, и там.
        const types = [];
        const collect = (node) => {
            if (Array.isArray(node)) { node.forEach(collect); return; }
            if (!node || typeof node !== 'object') return;
            if (node['@type']) types.push(node['@type']);
            if (node['@graph']) collect(node['@graph']);
        };
        for (const raw of blocks) collect(JSON.parse(raw));
        assert.ok(types.includes('FAQPage'), `${rel}: среди типов нет FAQPage (${types.join(', ') || 'типов не найдено'})`);
    }
});
