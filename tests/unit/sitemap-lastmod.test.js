'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderSitemap, isoDay, latest } = require('../../lib/sitemap');

/* Главный сторож здесь — отсутствие lastmod там, где даты нет.
 *
 * До этой правки карта сайта проставляла всем 4500 адресам сегодняшнее число:
 * каждый день робот слышал, что обновился весь сайт. Если однажды вернётся
 * `lastmod: new Date()` по умолчанию, эти тесты должны упасть первыми. */

test('lastmod не выводится, когда даты изменения нет', () => {
    const xml = renderSitemap('https://texzakaz.ru', [
        { url: '/', priority: '1.0', changefreq: 'weekly' },
        { url: '/privacy', priority: '0.3', changefreq: 'yearly', lastmod: null },
    ]);
    assert.ok(!xml.includes('<lastmod>'), 'проставлена дата, которой мы не знаем');
    assert.ok(xml.includes('<loc>https://texzakaz.ru/</loc>'));
    assert.ok(xml.includes('<changefreq>yearly</changefreq>'));
});

test('lastmod выводится датой изменения карточки, а не датой запроса', () => {
    const xml = renderSitemap('https://texzakaz.ru', [
        { url: '/p/17', priority: '0.5', changefreq: 'weekly', lastmod: new Date('2026-07-04T10:20:30Z') },
    ]);
    assert.ok(xml.includes('<lastmod>2026-07-04</lastmod>'));
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(!xml.includes(`<lastmod>${today}</lastmod>`), 'дата подменена сегодняшней');
});

test('битая дата не превращается в сегодняшнюю', () => {
    assert.equal(isoDay('не дата'), null);
    assert.equal(isoDay(''), null);
    assert.equal(isoDay(undefined), null);
    const xml = renderSitemap('https://texzakaz.ru', [{ url: '/p/1', lastmod: 'не дата' }]);
    assert.ok(!xml.includes('<lastmod>'));
});

test('дата страницы-списка — самая свежая из её предприятий', () => {
    const best = latest([
        new Date('2026-01-05T00:00:00Z'),
        null,
        new Date('2026-08-19T00:00:00Z'),
        'не дата',
        new Date('2026-03-01T00:00:00Z'),
    ]);
    assert.equal(isoDay(best), '2026-08-19');
    assert.equal(latest([]), null);
    assert.equal(latest([null, undefined]), null);
});

test('карта сайта остаётся валидным XML: экранирование и порядок тегов', () => {
    const xml = renderSitemap('https://texzakaz.ru/', [
        { url: '/oborudovanie/tokarka?a=1&b=2', priority: '0.6', changefreq: 'weekly', lastmod: '2026-08-19' },
    ]);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('&amp;b=2'), 'амперсанд не экранирован — карта не разберётся');
    assert.ok(!xml.includes('texzakaz.ru//oborudovanie'), 'двойной слэш в адресе');
    // Порядок обязателен по схеме sitemaps.org: loc → lastmod → changefreq → priority.
    const order = ['<loc>', '<lastmod>', '<changefreq>', '<priority>'].map(t => xml.indexOf(t));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
});
