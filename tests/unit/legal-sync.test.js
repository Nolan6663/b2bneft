'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderFooter, applyFooter } = require('../../scripts/sync-legal');
const { LEGAL } = require('../../scripts/legal-data');

const TEMPLATE = '<footer>{{ORG_NAME}} ИНН {{INN}} ОГРНИП {{OGRNIP}} {{ADDRESS}} {{EMAIL}} © {{YEAR}}</footer>';

test('синк: плейсхолдеры заменяются реквизитами', () => {
    const html = renderFooter(TEMPLATE, LEGAL, 2026);
    assert.match(html, /ИП Лапшина Диана Николаевна/);
    assert.match(html, /650112190630/);
    assert.match(html, /326650000001066/);
    assert.match(html, /info\.texzakaz@yandex\.com/);
    assert.match(html, /© 2026/);
    assert.doesNotMatch(html, /\{\{/, 'незаменённых плейсхолдеров остаться не должно');
});

test('синк: футер вставляется перед </body>, если маркеров ещё нет', () => {
    const page = '<html><body><div>контент</div></body></html>';
    const out = applyFooter(page, '<footer>Ф</footer>');
    assert.match(out, /<!-- legal-footer:start -->[\s\S]*<footer>Ф<\/footer>[\s\S]*<!-- legal-footer:end -->/);
    assert.ok(out.indexOf('legal-footer:end') < out.indexOf('</body>'), 'футер должен быть внутри body');
});

test('синк: повторный прогон не плодит копии', () => {
    const page = '<html><body><div>контент</div></body></html>';
    const once = applyFooter(page, '<footer>Ф</footer>');
    const twice = applyFooter(once, '<footer>Ф</footer>');
    assert.equal(twice, once);
    assert.equal(twice.match(/legal-footer:start/g).length, 1);
});

test('синк: смена реквизитов заменяет старый блок, а не добавляет новый', () => {
    const page = '<html><body>текст</body></html>';
    const old = applyFooter(page, '<footer>СТАРЫЙ</footer>');
    const fresh = applyFooter(old, '<footer>НОВЫЙ</footer>');
    assert.match(fresh, /НОВЫЙ/);
    assert.doesNotMatch(fresh, /СТАРЫЙ/);
    assert.equal(fresh.match(/legal-footer:start/g).length, 1);
});

test('синк: страница без </body> не портится', () => {
    const page = '<div>фрагмент</div>';
    assert.equal(applyFooter(page, '<footer>Ф</footer>'), page);
});
