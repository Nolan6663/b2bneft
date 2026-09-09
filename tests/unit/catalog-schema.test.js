'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildSystemKey,
    isIndexable,
    LANDING_STATUSES,
    INDEXABLE_STATUS,
    DEFAULT_THRESHOLDS,
} = require('../../lib/catalog-schema');

/* Системный ключ — единственное, что механически не даёт завести две страницы
   на один интент (Краулинговый бюджет §5, ТЗ §2.2). Если он начнёт собираться
   по-разному в разных местах, защита исчезнет молча: страницы появятся, а
   уникальность ключа их не поймает. */

test('ключ собирается по формуле «тип:интент:сущность»', () => {
    assert.equal(
        buildSystemKey({ pageType: 'service', intent: 'customer', entity: 'tokarnaya-obrabotka' }),
        'service:customer:tokarnaya-obrabotka'
    );
    assert.equal(
        buildSystemKey({ pageType: 'order', intent: 'executor', entity: 'izgotovlenie-valov' }),
        'order:executor:izgotovlenie-valov'
    );
});

test('пустые части не создают второй ключ на ту же страницу', () => {
    const withEmpties = buildSystemKey({
        pageType: 'product', intent: 'customer', entity: 'valy', extra: '', geo: '',
    });
    const plain = buildSystemKey({ pageType: 'product', intent: 'customer', entity: 'valy' });
    assert.equal(withEmpties, plain, 'иначе product:customer:valy:: разъедется с product:customer:valy');
    assert.equal(plain, 'product:customer:valy');
});

test('регистр и пробелы не плодят дубли ключей', () => {
    assert.equal(
        buildSystemKey({ pageType: 'Service', intent: ' Customer ', entity: 'Tokarnaya-Obrabotka' }),
        'service:customer:tokarnaya-obrabotka'
    );
});

test('гео и дополнительная сущность попадают в ключ', () => {
    assert.equal(
        buildSystemKey({ pageType: 'contractor', intent: 'customer', entity: 'tokarnaya-obrabotka', geo: 'moskva' }),
        'contractor:customer:tokarnaya-obrabotka:moskva'
    );
});

/* Один и тот же ответ про индексацию нужен в sitemap.xml, в meta robots и в
   перелинковке. Публичность страницы допуска не даёт — Краулинговый бюджет §2.2. */

test('в индекс пускает только published_index', () => {
    assert.equal(isIndexable({ status: 'published_index' }), true);
    for (const status of LANDING_STATUSES.filter(s => s !== INDEXABLE_STATUS)) {
        assert.equal(isIndexable({ status }), false, `${status} не должен попадать в индекс`);
    }
    assert.equal(isIndexable(null), false);
});

test('published_noindex публичен, но в Sitemap не идёт', () => {
    // Отдельным тестом, потому что это самая частая ошибка прочтения:
    // «страница же открыта, значит индексируется».
    assert.ok(LANDING_STATUSES.includes('published_noindex'));
    assert.equal(isIndexable({ status: 'published_noindex' }), false);
});

test('пороги заданы для всех типов страниц и числами', () => {
    const keys = new Set(DEFAULT_THRESHOLDS.map(([k]) => k));
    for (const required of [
        'threshold.service.demand', 'threshold.service.supply',
        'threshold.product.demand', 'threshold.product.supply',
        'threshold.contractor.demand', 'threshold.contractor.supply',
        'threshold.geo.demand', 'threshold.geo.supply',
        'threshold.orderhub.demand', 'threshold.orderhub.supply',
    ]) {
        assert.ok(keys.has(required), `нет порога ${required}`);
    }
    for (const [key, value] of DEFAULT_THRESHOLDS) {
        assert.match(value, /^\d+$/, `${key} должен быть числом, а не «${value}»`);
    }
});

test('стартовые пороги совпадают с ответом маркетинга', () => {
    const get = k => DEFAULT_THRESHOLDS.find(([key]) => key === k)[1];
    assert.equal(get('threshold.service.demand'), '20', 'услуга — от 20 показов');
    assert.equal(get('threshold.service.supply'), '3', 'услуга — от 3 исполнителей');
    assert.equal(get('threshold.contractor.supply'), '5', 'каталог подрядчиков — от 5 компаний');
    assert.equal(get('threshold.orderhub.window'), '90', 'хаб заказов — окно 90 дней');
});
