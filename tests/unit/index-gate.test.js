'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../../lib/catalog-settings');
const { evaluate, canTransition } = require('../../lib/index-gate');

afterEach(() => settings.resetForTesting());

/* Проверка перед переводом страницы в индекс — «Краулинговый бюджет» §12.
   Смысл не в запрете публиковать, а в том, чтобы редактор видел все условия
   сразу и не вспоминал их по памяти из документа на шестьдесят пять страниц. */

const landing = (over = {}) => ({ page_type: 'service', url: '/uslugi/tokarnaya-obrabotka', ...over });

test('страница с достаточным предложением готова к индексации', () => {
    const r = evaluate(landing(), { supply: 5, demand: 30, hasUniqueContent: true, inboundLinks: 3 });
    assert.equal(r.ready, true);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.warnings.length, 0);
});

test('нехватка предложения блокирует и называет цифру', () => {
    const r = evaluate(landing(), { supply: 1, demand: 30, hasUniqueContent: true });
    assert.equal(r.ready, false);
    const fail = r.blocking.find(c => /предложения/i.test(c.title));
    assert.ok(fail, 'должен быть пункт про предложение');
    assert.match(fail.detail, /Сейчас 1/);
});

test('дубль системного ключа блокирует — это и есть каннибализация', () => {
    const r = evaluate(landing(), { supply: 9, hasUniqueContent: true, duplicateKey: '/uslugi/tokarka' });
    assert.equal(r.ready, false);
    assert.ok(r.blocking.some(c => /ключ/i.test(c.title)));
});

test('дубль адреса блокирует отдельно от ключа', () => {
    const r = evaluate(landing(), { supply: 9, hasUniqueContent: true, duplicateUrl: '/uslugi/tokarka' });
    assert.equal(r.ready, false);
    assert.ok(r.blocking.some(c => /Адрес уникален/i.test(c.title)));
});

test('страница без собственного содержания в индекс не идёт', () => {
    const r = evaluate(landing(), { supply: 9, hasUniqueContent: false });
    assert.equal(r.ready, false);
    assert.ok(r.blocking.some(c => /содержание/i.test(c.title)));
});

test('непроставленная частотность предупреждает, но не блокирует', () => {
    // Данных о спросе у платформы нет — их приносит SEO-специалист извне.
    // Блокировать по ним значит блокировать всё подряд.
    const r = evaluate(landing(), { supply: 9, demand: 0, hasUniqueContent: true, inboundLinks: 1 });
    assert.equal(r.ready, true, 'спрос не должен блокировать');
    assert.ok(r.warnings.some(c => /спрос/i.test(c.title)));
    assert.match(r.warnings.find(c => /спрос/i.test(c.title)).detail, /уточните у SEO/i);
});

test('страница без входящих ссылок получает предупреждение', () => {
    const r = evaluate(landing(), { supply: 9, demand: 30, hasUniqueContent: true, inboundLinks: 0 });
    assert.equal(r.ready, true);
    assert.ok(r.warnings.some(c => /перелинковк/i.test(c.title)));
});

test('у каждого типа страницы свой порог', () => {
    // Каталог подрядчиков требует пяти компаний, изделие — трёх.
    const asProduct = evaluate(landing({ page_type: 'product' }), { supply: 3, hasUniqueContent: true });
    const asContractor = evaluate(landing({ page_type: 'contractor' }), { supply: 3, hasUniqueContent: true });
    assert.equal(asProduct.ready, true);
    assert.equal(asContractor.ready, false, 'каталогу подрядчиков трёх компаний мало');
});

test('пороги берутся из настроек, а не из кода', () => {
    settings.setForTesting({ 'threshold.service.supply': 10 });
    const r = evaluate(landing(), { supply: 5, hasUniqueContent: true });
    assert.equal(r.ready, false);
    assert.equal(r.thresholds.supply, 10);
});

// ─────────────────── Переходы между статусами ───────────────────

test('из черновика нельзя прыгнуть сразу в индекс', () => {
    // «Краулинговый бюджет» §3: перевод в index — отдельное управляемое
    // действие, а не следствие создания страницы.
    const r = canTransition('draft', 'published_index');
    assert.equal(r.allowed, false);
    assert.match(r.why, /Сначала опубликуйте с noindex/);
});

test('нормальный путь публикации разрешён', () => {
    assert.equal(canTransition('draft', 'preview').allowed, true);
    assert.equal(canTransition('preview', 'published_noindex').allowed, true);
    assert.equal(canTransition('published_noindex', 'published_index').allowed, true);
});

test('из индекса можно закрыться, объединить и заархивировать', () => {
    for (const to of ['published_noindex', 'merged', 'archived']) {
        assert.equal(canTransition('published_index', to).allowed, true, to);
    }
});

test('архивную страницу нельзя вернуть сразу в индекс', () => {
    assert.equal(canTransition('archived', 'published_index').allowed, false);
    assert.equal(canTransition('archived', 'published_noindex').allowed, true, 'но вернуть в публичный контур можно');
});

test('неизвестный статус отвергается', () => {
    const r = canTransition('draft', 'опубликовать');
    assert.equal(r.allowed, false);
    assert.match(r.why, /Неизвестный статус/);
});

test('переход в тот же статус безвреден', () => {
    assert.equal(canTransition('published_index', 'published_index').allowed, true);
});
