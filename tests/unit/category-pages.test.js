'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    renderCategoryPage, stripLegalBlock, preserveLegalBlock, pageWordCount,
    LEGAL_START, LEGAL_END,
} = require('../../scripts/sync-category-pages');
const { CATEGORIES } = require('../../seo/categories-data');

const RTI = CATEGORIES.find(c => c.slug === 'rti');

test('рендер: страница содержит канонический URL и не меняет его', () => {
    const html = renderCategoryPage(RTI);
    assert.match(html, /<link rel="canonical" href="https:\/\/texzakaz\.ru\/zakupki\/rti">/);
});

test('рендер: h1, интро, позиции и FAQ попадают в разметку', () => {
    const html = renderCategoryPage(RTI);
    assert.ok(html.includes(RTI.h1), 'нет h1');
    assert.ok(html.includes(RTI.intro.slice(0, 40)), 'нет интро');
    assert.ok(html.includes(RTI.positions[0].name), 'нет первой позиции');
    assert.ok(html.includes(RTI.faq[0].q), 'нет первого вопроса FAQ');
    for (const item of RTI.checklist) assert.ok(html.includes(item), `нет пункта чеклиста: ${item}`);
});

test('рендер: категория для грида закупок берётся из dbCategory', () => {
    const html = renderCategoryPage(RTI);
    // Шаблон объявляет `var CATEGORY = "РТИ";` — имя кодируется уже в браузере,
    // поэтому ищем именно объявление, а не результат encodeURIComponent.
    assert.ok(html.includes(`var CATEGORY = ${JSON.stringify(RTI.dbCategory)}`), 'грид не знает категорию БД');
    assert.match(html, /\/api\/orders\/public\?category=/, 'нет запроса открытых закупок');
    assert.match(html, /\/api\/public\/producers\?category=/, 'нет запроса заводов для пустого состояния');
});

test('рендер: JSON-LD парсится и содержит FAQPage и BreadcrumbList', () => {
    const html = renderCategoryPage(RTI);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(blocks.length >= 1, 'нет ни одного блока JSON-LD');
    const types = [];
    for (const raw of blocks) {
        const parsed = JSON.parse(raw); // упадёт, если разметка битая
        types.push(parsed['@type']);
        if (parsed.breadcrumb) types.push(parsed.breadcrumb['@type']);
    }
    assert.ok(types.includes('FAQPage'), `среди типов нет FAQPage: ${types.join(', ')}`);
    assert.ok(types.includes('BreadcrumbList'), `среди типов нет BreadcrumbList: ${types.join(', ')}`);
});

test('рендер: старого футера с 2024 годом на странице нет', () => {
    const html = renderCategoryPage(RTI);
    assert.doesNotMatch(html, /© 2024/);
    assert.doesNotMatch(html, /class="zc-footer"/, 'устаревший zc-footer должен быть убран');
});

test('рендер: объём видимого текста не меньше 600 слов', () => {
    for (const c of CATEGORIES) {
        const n = pageWordCount(renderCategoryPage(c));
        assert.ok(n >= 600, `${c.slug}: ${n} слов, нужно ≥ 600`);
    }
});

test('юридический блок: вырезается и переносится в новую версию страницы', () => {
    const legal = `${LEGAL_START}\n<footer>реквизиты</footer>\n${LEGAL_END}`;
    const oldHtml = `<html><body><p>старое</p>\n${legal}\n</body></html>`;
    const newHtml = '<html><body><p>новое</p>\n</body></html>';

    assert.doesNotMatch(stripLegalBlock(oldHtml), /реквизиты/);

    const merged = preserveLegalBlock(oldHtml, newHtml);
    assert.match(merged, /новое/);
    assert.match(merged, /реквизиты/);
    assert.equal(merged.match(new RegExp(LEGAL_START, 'g')).length, 1, 'блок не должен дублироваться');
    assert.ok(merged.indexOf(LEGAL_END) < merged.indexOf('</body>'), 'блок должен остаться внутри body');
});

test('юридический блок: если его не было, страница остаётся без него', () => {
    const merged = preserveLegalBlock('<html><body>без блока</body></html>', '<html><body>новое</body></html>');
    assert.doesNotMatch(merged, new RegExp(LEGAL_START));
    assert.match(merged, /новое/);
});

test('подсчёт слов: скрипты, стили и комментарии не считаются', () => {
    const html = '<html><head><style>.a{color:red}</style><script>var x=1;</script></head><body><!-- коммент --><p>одно два три</p></body></html>';
    assert.equal(pageWordCount(html), 3);
});
