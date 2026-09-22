'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../../lib/catalog-settings');
const contractors = require('../../lib/contractors-seo');

afterEach(() => settings.resetForTesting());

/* Каталог подрядчиков — четвёртая страница кластера. Её нельзя было писать до
   22.09: адрес /podryadchiki/ в приложении «Архитектура публичных страниц»
   описан дважды и с противоположными смыслами. Маркетинг подтвердил вариант
   «витрина подрядчиков для заказчика», ролевые лендинги уехали на
   /zakazchikam/ и /ispolnitelyam/. */

const PRODUCT = { id: 4, slug: 'valy', name: 'Валы', kind: 'product', genitive: 'валов' };
const SERVICE = { id: 1, slug: 'tokarnaya-obrabotka', name: 'Токарная обработка', kind: 'service' };

const company = (over = {}) => ({
    id: 7, company: 'ООО «Станкозавод»', city: 'Челябинск',
    specialization: 'Токарная и фрезерная обработка', claimed: true, ...over,
});

// ─────────────────── Порог наполнения ───────────────────

test('порог берётся из настроек, а не из кода', () => {
    settings.setForTesting({ 'threshold.contractor.supply': 8 });
    assert.deepEqual(contractors.supplyRule(), { minCompanies: 8 });
    assert.equal(contractors.meetsSupply(7), false);
    assert.equal(contractors.meetsSupply(8), true);
});

test('без настроек работает значение из ответа маркетинга', () => {
    settings.resetForTesting();
    assert.deepEqual(contractors.supplyRule(), { minCompanies: 5 });
});

test('опубликованный каталог без предприятий закрывается сам', () => {
    // Иначе в индексе висит витрина, на которой нечего выбирать.
    const landing = { status: 'published_index' };
    assert.equal(contractors.robotsForCatalog(landing, 5), 'index, follow');
    assert.equal(contractors.robotsForCatalog(landing, 4), 'noindex, follow');
    assert.equal(contractors.robotsForCatalog(landing, 0), 'noindex, follow');
});

test('наполнение ужесточает статус, но не смягчает', () => {
    assert.equal(contractors.robotsForCatalog({ status: 'published_noindex' }, 100), 'noindex, follow');
    assert.equal(contractors.robotsForCatalog({ status: 'draft' }, 100), 'noindex, follow');
    assert.equal(contractors.robotsForCatalog(null, 100), 'noindex, follow');
});

test('карта сайта и мета-тег отвечают одинаково', () => {
    // Расхождение между ними — прямой путь к «просканировано, не проиндексировано».
    for (const n of [0, 4, 5, 60]) {
        const landing = { status: 'published_index' };
        assert.equal(
            contractors.catalogInSitemap(landing, n),
            contractors.robotsForCatalog(landing, n) === 'index, follow',
            `при ${n} предприятиях`
        );
    }
});

// ─────────────────── Заголовки ───────────────────

test('родительный падеж из справочника даёт название, которым страницу и назвали', () => {
    assert.equal(contractors.buildH1(PRODUCT), 'Производители валов');
});

test('без падежа заголовок не склоняет название', () => {
    // «Производители Валы» — именно то, чего здесь быть не должно.
    const bare = { ...PRODUCT, genitive: '' };
    assert.equal(contractors.buildH1(bare), 'Производители: Валы');
    assert.ok(!/Производители Валы/.test(contractors.buildH1(bare)));
});

test('услугу выполняют, а не производят', () => {
    // «Производители токарной обработки» — бессмыслица.
    assert.equal(contractors.buildH1(SERVICE), 'Исполнители: Токарная обработка');
    assert.equal(
        contractors.buildH1({ ...SERVICE, genitive: 'токарной обработки' }),
        'Исполнители токарной обработки'
    );
});

test('лишнее существительное в поле редактора не удваивается', () => {
    const typed = { ...PRODUCT, genitive: 'производители валов' };
    assert.equal(contractors.buildH1(typed), 'Производители валов');
});

test('title держится в пределах выдачи', () => {
    const long = { ...SERVICE, name: 'Электроэрозионная проволочная и прошивная обработка' };
    assert.ok(contractors.buildTitle(long, 37).length <= 60, contractors.buildTitle(long, 37));
    assert.ok(contractors.buildDescription(long, 37, 12).length <= 160);
});

test('число предприятий в title переживает обрезку', () => {
    // Ради него на ссылку и кликают; под нож идёт название.
    const long = { ...SERVICE, name: 'Электроэрозионная проволочная и прошивная обработка' };
    assert.match(contractors.buildTitle(long, 37), /37/);
});

// ─────────────────── Содержание ───────────────────

test('пустой каталог не обещает несуществующих предприятий', () => {
    const html = contractors.buildBody(PRODUCT, [], [], null, 0);
    assert.ok(!/скоро появятся|ожидаются|в ближайшее время/i.test(html), html);
    assert.match(html, /профили предприятий ещё не заполнены/i);
    assert.match(html, /href="\/zayavka"/, 'вместо обещаний — действие, которое работает и без профилей');
});

test('происхождение карточки видно', () => {
    // ТЗ §11.2: реестровая догадка и заявленная компетенция выглядят одинаково,
    // пока не подписаны, а разница между ними для заказчика решающая.
    const registry = contractors.contractorCard(company({ claimed: false }));
    assert.match(registry, /Реестр Минпромторга/);
    const verified = contractors.contractorCard(company({ verifiedByPlatform: true }));
    assert.match(verified, /Проверен платформой/);
    assert.ok(!/Реестр Минпромторга/.test(verified));
});

test('данные предприятия экранируются', () => {
    const html = contractors.contractorCard(company({ company: '<img src=x onerror=alert(1)>' }));
    assert.ok(!html.includes('<img'), html);
});

test('города ведут только на открытые геостраницы', () => {
    /* Ссылка в noindex-контур гоняет робота по мусору, ссылка в никуда — просто
       битая. Поэтому адрес приходит уже проверенным, а без него выводится
       только название. */
    const html = contractors.cityBlock([
        { name: 'Челябинск', count: 12, href: '/zakupki/region/chelyabinsk' },
        { name: 'Ковров', count: 2, href: '' },
    ]);
    assert.match(html, /href="\/zakupki\/region\/chelyabinsk"/);
    assert.match(html, /Ковров/);
    assert.ok(!/href="[^"]*kovrov/.test(html), html);
});

test('пустая разбивка по городам не рисует заголовок над пустотой', () => {
    assert.equal(contractors.cityBlock([]), '');
    assert.equal(contractors.cityBlock([{ name: 'Москва', count: 0 }]), '');
});

test('формы заказа здесь нет — иначе страница дублирует страницу изделия', () => {
    /* ТЗ §2.2: два адреса под один интент — это каннибализация, ради
       разделения которой каталог и выносился отдельно. Заказ живёт на
       /izdeliya/, сюда ведёт только ссылка. */
    const html = contractors.buildBody(PRODUCT, [company()], [], {
        href: '/izdeliya/valy', title: 'Изготовление «Валы»',
    }, 1);
    assert.ok(!/<form/i.test(html), html);
    assert.match(html, /href="\/izdeliya\/valy"/);
});

test('остаток списка уводится в общий каталог честным числом', () => {
    const many = Array.from({ length: contractors.LIST_LIMIT }, (_, i) => company({ id: i + 1 }));
    const html = contractors.buildBody(PRODUCT, many, [], null, contractors.LIST_LIMIT + 9);
    assert.match(html, new RegExp(`Показаны первые ${contractors.LIST_LIMIT}`));
    assert.match(html, /Ещё 9 предприятий/);
    assert.match(html, /href="\/proizvoditeli"/);
});

test('когда показано всё, ссылки «показать ещё» нет', () => {
    const html = contractors.buildBody(PRODUCT, [company()], [], null, 1);
    assert.ok(!/Показаны первые/.test(html), html);
});

// ─────────────────── Разметка ───────────────────

test('число в разметке совпадает с числом на странице', () => {
    // Расхождение — недостоверные структурированные данные (ТЗ §10.6).
    const many = Array.from({ length: contractors.LIST_LIMIT + 5 }, (_, i) => company({ id: i + 1 }));
    const ld = JSON.parse(contractors.buildJsonLd(PRODUCT, many, 'https://texzakaz.ru')
        .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
    assert.equal(ld.mainEntity.numberOfItems, contractors.LIST_LIMIT);
    assert.equal(ld.mainEntity.itemListElement.length, contractors.LIST_LIMIT);
    assert.equal(ld.url, 'https://texzakaz.ru/podryadchiki/valy');
    assert.equal(ld.name, 'Производители валов');
});

test('хлебные крошки ведут в раздел каталога', () => {
    const crumbs = contractors.buildBreadcrumb(PRODUCT);
    assert.match(crumbs, /href="\/podryadchiki"/);
    assert.match(crumbs, /Валы/);
});

test('первый экран показывает и предприятия, и города', () => {
    const stats = contractors.buildStats(23, 14);
    assert.match(stats, /23/);
    assert.match(stats, /14/);
    assert.match(stats, /городов/);
});

test('нулевые показатели в первый экран не выводятся', () => {
    assert.equal(contractors.buildStats(0, 0), '');
});
