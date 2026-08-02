'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OPERATIONS, operationBySlug, producerHasOperation } = require('../../seo/operations-data');
const {
    buildOperationTitle,
    buildOperationDescription,
    buildOperationRobots,
    buildOperationSsr,
    buildOperationJsonLd,
    MIN_INDEXABLE,
} = require('../../lib/equipment-seo');

const WELD = operationBySlug('svarka');

test('операции: слаги уникальны, латиница, у каждой есть текст и правило', () => {
    const slugs = OPERATIONS.map(o => o.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    for (const o of OPERATIONS) {
        assert.match(o.slug, /^[a-z-]+$/);
        assert.ok(o.match instanceof RegExp, `${o.slug}: нет правила поиска`);
        assert.ok(o.lead && o.lead.length > 20, `${o.slug}: нет пояснения`);
        assert.ok(o.genitive, `${o.slug}: нет родительного падежа`);
    }
});

test('совпадение операции: по специализации, продукции и списку станков', () => {
    assert.ok(producerHasOperation({ specialization: 'Сварные металлоконструкции' }, WELD));
    assert.ok(producerHasOperation({ products: 'сварка аппаратов' }, WELD));
    assert.ok(producerHasOperation({ equipment: ['Сварочный полуавтомат'] }, WELD));
    assert.ok(!producerHasOperation({ specialization: 'Резинотехнические изделия' }, WELD));
});

test('совпадение операции: продажа расходников не считается услугой', () => {
    const seller = { specialization: 'Сварочные электроды и проволока', products: 'электроды' };
    assert.ok(!producerHasOperation(seller, WELD), 'торговля электродами — не сварочные услуги');
});

test('лазер: «лазерная резка» ловится, «лазерная косметология» — нет', () => {
    const laser = operationBySlug('lazernaya-rezka');
    assert.ok(producerHasOperation({ products: 'Лазерная резка листа' }, laser));
    assert.ok(!producerHasOperation({ products: 'Лазерная косметология' }, laser));
});

test('title и description: с реальным числом и без обещаний про станки', () => {
    const title = buildOperationTitle(WELD, 65);
    assert.match(title, /Сварка/);
    assert.match(title, /65/);
    assert.ok(title.length <= 70, `title ${title.length} знаков`);

    const desc = buildOperationDescription(WELD, 65);
    assert.ok(desc.length <= 160, `description ${desc.length} знаков`);
    assert.ok(!/станк\w*\s+в\s+баз/i.test(desc), 'не заявляем базу станков, которой нет');
});

test('robots: операция без предприятий в индекс не идёт', () => {
    assert.equal(buildOperationRobots(0), 'noindex, follow');
    assert.equal(buildOperationRobots(MIN_INDEXABLE - 1), 'noindex, follow');
    assert.equal(buildOperationRobots(MIN_INDEXABLE), 'index, follow');
});

test('SSR: карточки со ссылкой на профиль и экранированием', () => {
    const html = buildOperationSsr(WELD, [
        { id: 7, company: 'ООО «Метиз»', city: 'Тюменская область', specialization: 'Сварные конструкции' },
        { id: 8, company: '<b>взлом</b>', city: 'Москва', products: 'сварка' },
    ]);
    assert.match(html, /\/p\/7/);
    assert.match(html, /Тюменская область/);
    assert.ok(!html.includes('<b>взлом</b>'));
    assert.match(html, /&lt;b&gt;/);
});

test('SSR: пустая операция объясняет пустоту, а не притворяется каталогом', () => {
    const html = buildOperationSsr(WELD, []);
    assert.match(html, /профил/i);
    assert.ok(!/<li class="zr-card"/.test(html));
});

test('JSON-LD: разбирается и несёт число позиций', () => {
    const parsed = JSON.parse(buildOperationJsonLd(WELD, 65, 'https://texzakaz.ru'));
    assert.equal(parsed['@type'], 'CollectionPage');
    assert.equal(parsed.mainEntity.numberOfItems, 65);
    assert.match(parsed.url, /\/oborudovanie\/svarka$/);
    assert.equal(parsed.breadcrumb.itemListElement.length, 3);
});
