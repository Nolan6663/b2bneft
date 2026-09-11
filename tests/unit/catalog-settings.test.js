'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../../lib/catalog-settings');
const { buildRegionRobots, isRegionIndexable, MIN_INDEXABLE } = require('../../lib/region-seo');
const { buildOperationRobots } = require('../../lib/equipment-seo');
const { robotsFor } = require('../../lib/catalog-schema');

afterEach(() => settings.resetForTesting());

/* Маркетинг потребовал (ответ на вопрос 1), чтобы пороги были настройкой, а не
   числом в коде: «пороги являются стартовыми и хранятся как настройки». Тесты
   сторожат обе стороны сделки — что настройка действительно влияет на решение
   и что без неё поведение остаётся прежним. */

test('без загруженных настроек работает значение по умолчанию', () => {
    settings.resetForTesting();
    assert.equal(settings.getThreshold('threshold.geo.supply', MIN_INDEXABLE), 5);
    assert.equal(buildRegionRobots(5), 'index, follow');
    assert.equal(buildRegionRobots(4), 'noindex, follow');
});

test('порог из настроек меняет решение об индексации региона', () => {
    settings.setForTesting({ 'threshold.geo.supply': 10 });
    assert.equal(buildRegionRobots(5), 'noindex, follow', 'при пороге 10 пять предприятий мало');
    assert.equal(buildRegionRobots(10), 'index, follow');

    settings.setForTesting({ 'threshold.geo.supply': 3 });
    assert.equal(buildRegionRobots(3), 'index, follow', 'порог снижен — страница открывается');
});

test('карта сайта и мета-тег спрашивают один и тот же предикат', () => {
    // Это главный риск правки: если карта сравнивает с константой, а страница —
    // с настройкой, робота зовут туда, где стоит noindex.
    settings.setForTesting({ 'threshold.geo.supply': 8 });
    for (const n of [0, 5, 7, 8, 20]) {
        const inSitemap = isRegionIndexable(n);
        const onPage = buildRegionRobots(n) === 'index, follow';
        assert.equal(inSitemap, onPage, `расхождение при ${n} предприятиях`);
    }
});

test('у оборудования свой ключ, гео-порог на него не влияет', () => {
    settings.setForTesting({ 'threshold.geo.supply': 99, 'threshold.equipment.supply': 2 });
    const bare = { processes: [], faq: [] };
    assert.equal(buildOperationRobots(2, bare), 'index, follow');
    assert.equal(buildOperationRobots(1, bare), 'noindex, follow');
});

test('мусор в настройке не открывает индексацию настежь', () => {
    settings.setForTesting({ 'threshold.geo.supply': 'пять' });
    // Number('пять') = NaN, а любое сравнение с NaN ложно: без защиты
    // buildRegionRobots(0) вернул бы noindex, но и buildRegionRobots(1000) тоже.
    assert.equal(buildRegionRobots(5), 'index, follow', 'должен сработать запасной порог 5');
    assert.equal(buildRegionRobots(4), 'noindex, follow');
});

test('отрицательное значение игнорируется', () => {
    settings.setForTesting({ 'threshold.geo.supply': -1 });
    assert.equal(buildRegionRobots(0), 'noindex, follow', 'порог -1 не должен пускать пустые страницы');
});

/* Мета-тег посадочной страницы из реестра. */

test('meta robots посадочной следует из её статуса', () => {
    assert.equal(robotsFor({ status: 'published_index' }), 'index, follow');
    assert.equal(robotsFor({ status: 'published_noindex' }), 'noindex, follow');
    assert.equal(robotsFor({ status: 'draft' }), 'noindex, follow');
    assert.equal(robotsFor(null), 'noindex, follow');
});

test('follow остаётся и у неиндексируемых страниц', () => {
    // Иначе связанные разделы станут недостижимы для обхода.
    for (const status of ['draft', 'preview', 'published_noindex']) {
        assert.match(robotsFor({ status }), /follow$/);
    }
});
