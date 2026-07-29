'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderFooter, applyFooter, hasFooterAnchor, normalizeEol } = require('../../scripts/sync-legal');
const { LEGAL, DOC_YEAR } = require('../../scripts/legal-data');

const TEMPLATE = '<footer>{{ORG_NAME}} ИНН {{INN}} ОГРНИП {{OGRNIP}} {{ADDRESS}} {{EMAIL}} © {{YEAR}}</footer>';

test('синк: плейсхолдеры заменяются реквизитами', () => {
    const html = renderFooter(TEMPLATE, LEGAL, DOC_YEAR);
    assert.match(html, /ИП Лапшина Диана Николаевна/);
    assert.match(html, /650112190630/);
    assert.match(html, /326650000001066/);
    assert.match(html, /info\.texzakaz@yandex\.com/);
    assert.match(html, new RegExp(`© ${DOC_YEAR}`));
    assert.doesNotMatch(html, /\{\{/, 'незаменённых плейсхолдеров остаться не должно');
});

test('синк: год берётся из константы, а не из системных часов', () => {
    assert.equal(typeof DOC_YEAR, 'number', 'DOC_YEAR должен быть явной константой');
    // Иначе 1 января все закоммиченные страницы разом станут «устаревшими» и заблокируют деплой.
    assert.equal(renderFooter('© {{YEAR}}', LEGAL, DOC_YEAR), `© ${DOC_YEAR}`);
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

test('синк: страница без маркеров и без </body> отмечается как непригодная, а не «синхронная»', () => {
    // applyFooter возвращает такую страницу без изменений — сама по себе она выглядела бы
    // синхронной, хотя футера на ней нет. Ловим её отдельной проверкой.
    assert.equal(hasFooterAnchor('<div>фрагмент</div>'), false);
    assert.equal(hasFooterAnchor('<html><body>текст</body></html>'), true);
    assert.equal(hasFooterAnchor('<div><!-- legal-footer:start -->Ф<!-- legal-footer:end --></div>'), true);
});

test('синк: CRLF-выкачка не считается расхождением', () => {
    const page = '<html>\n<body>текст</body>\n</html>';
    const synced = applyFooter(page, '<footer>Ф</footer>');
    const crlf = synced.replace(/\n/g, '\r\n');
    assert.notEqual(applyFooter(crlf, '<footer>Ф</footer>'), crlf, 'без нормализации CRLF даёт ложное расхождение');
    assert.equal(
        normalizeEol(applyFooter(crlf, '<footer>Ф</footer>')),
        normalizeEol(crlf),
        'после нормализации переводов строк страница синхронна',
    );
});
