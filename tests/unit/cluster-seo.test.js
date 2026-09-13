'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    responseFor, buildTitle, buildDescription, buildH1,
    buildBody, buildJsonLd, linkBlock, companyCards, MAX_LINKS,
} = require('../../lib/cluster-seo');

/* Страницы кластера — первое место, где статус посадочной страницы реально
   что-то решает. До сих пор статусы из ТЗ §4.3 лежали в базе без применения. */

const ENTITY = { id: 1, slug: 'tokarnaya-obrabotka', name: 'Токарная обработка', description: '' };
const page = (over = {}) => ({
    kind: 'service', entity: ENTITY, landing: null,
    related: { companies: [], entities: [], orders: [] },
    counts: { companies: 0, orders: 0 },
    ...over,
});

// ─────────────────── Код ответа по статусу ───────────────────

test('черновик и отсутствие страницы наружу не выходят', () => {
    assert.deepEqual(responseFor(null), { status: 404 });
    assert.deepEqual(responseFor({ status: 'draft' }), { status: 404 });
});

test('preview и published_noindex открыты, но закрыты от индекса', () => {
    for (const status of ['preview', 'published_noindex']) {
        const r = responseFor({ status });
        assert.equal(r.status, 200, status);
        assert.equal(r.robots, 'noindex, follow', status);
    }
});

test('published_index — единственный статус, пускающий в индекс', () => {
    assert.deepEqual(responseFor({ status: 'published_index' }), { status: 200, robots: 'index, follow' });
});

test('объединённая страница отдаёт 301 на цель', () => {
    const r = responseFor({ status: 'merged', redirect_to: '/uslugi/tokarnaya-obrabotka' });
    assert.equal(r.status, 301);
    assert.equal(r.location, '/uslugi/tokarnaya-obrabotka');
});

test('merged без адреса не отдаёт редирект в никуда', () => {
    // Пустой Location — это оборванная цепочка и бесконечный цикл у робота.
    assert.deepEqual(responseFor({ status: 'merged', redirect_to: '' }), { status: 404 });
});

test('архивная страница отвечает 410, а не 404', () => {
    // Разница существенная: после 404 робот возвращается месяцами,
    // после 410 — перестаёт. ТЗ §10.7.
    assert.deepEqual(responseFor({ status: 'archived' }), { status: 410 });
});

test('неизвестный статус трактуется как «страницы нет»', () => {
    // Тихо отдать 200 с индексацией опаснее: в индекс уедет что угодно.
    assert.deepEqual(responseFor({ status: 'что-то новое' }), { status: 404 });
});

// ─────────────────── Мета ───────────────────

test('заполненный редактором title важнее сгенерированного', () => {
    const p = page({ landing: { status: 'published_index', title: 'Токарные работы в Москве' } });
    assert.equal(buildTitle(p), 'Токарные работы в Москве');
});

test('сгенерированный title держится в пределах выдачи', () => {
    const p = page({ counts: { companies: 12 } });
    assert.ok(buildTitle(p).length <= 60, buildTitle(p));
    assert.match(buildTitle(p), /12 исполнителей/);
});

test('склонение числа исполнителей', () => {
    // \b в JS работает по латинице: после кириллического слова границы нет,
    // поэтому конец слова проверяем явным просмотром вперёд.
    const end = '(?![а-яё])';
    assert.match(buildTitle(page({ counts: { companies: 1 } })), new RegExp(`1 исполнитель${end}`));
    assert.match(buildTitle(page({ counts: { companies: 3 } })), new RegExp(`3 исполнителя${end}`));
    assert.match(buildTitle(page({ counts: { companies: 7 } })), new RegExp(`7 исполнителей${end}`));
    assert.match(buildTitle(page({ counts: { companies: 21 } })), new RegExp(`21 исполнитель${end}`));
    assert.match(buildTitle(page({ counts: { companies: 11 } })), new RegExp(`11 исполнителей${end}`));
});

test('описание не длиннее 160 знаков', () => {
    const long = page({ entity: { ...ENTITY, name: 'Электроэрозионная прошивная и проволочная обработка деталей' } });
    assert.ok(buildDescription(long).length <= 160, String(buildDescription(long).length));
});

test('H1 изделия отличается от H1 услуги', () => {
    assert.equal(buildH1(page()), 'Токарная обработка');
    const prod = page({ kind: 'product', entity: { ...ENTITY, name: 'Валы' } });
    assert.equal(buildH1(prod), 'Изготовление «Валы»');
});

// ─────────────────── Перелинковка ───────────────────

test('пустой блок ссылок не рисуется вовсе', () => {
    // Заголовок над пустотой обманывает читателя и нарушает ТЗ §7.3.
    assert.equal(linkBlock('Изделия', [], i => '/x/' + i.slug), '');
    assert.equal(linkBlock('Изделия', null, i => '/x/' + i.slug), '');
});

test('число ссылок в блоке ограничено', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ slug: 's' + i, name: 'Позиция ' + i }));
    const html = linkBlock('Изделия', many, i => '/izdeliya/' + i.slug, { moreHref: '/izdeliya', moreText: 'Все изделия' });
    assert.equal((html.match(/<li>/g) || []).length, MAX_LINKS);
    assert.match(html, /Все изделия/, 'при обрезке нужна ссылка на полный список');
});

test('данные в ссылках экранируются', () => {
    const html = linkBlock('Изделия', [{ slug: 'x', name: '<script>alert(1)</script>' }], i => '/izdeliya/' + i.slug);
    assert.ok(!html.includes('<script>'), html);
    assert.match(html, /&lt;script&gt;/);
});

// ─────────────────── Тело страницы ───────────────────

test('пустой каталог честно говорит, что предприятий нет', () => {
    const html = companyCards([]);
    assert.match(html, /Пока ни одно предприятие/);
    assert.match(html, /заполните профиль/i);
});

test('реестровая карточка помечается источником', () => {
    const html = companyCards([{ id: 5, company: 'ООО Завод', city: 'Пермь', claimed: false }]);
    assert.match(html, /Реестр Минпромторга/);
    assert.match(html, /href="\/p\/5"/);
});

test('подтверждённая платформой карточка получает свою отметку', () => {
    const html = companyCards([{ id: 6, company: 'ООО Завод', claimed: true, verifiedByPlatform: true }]);
    assert.match(html, /Проверен платформой/);
    assert.ok(!html.includes('Реестр Минпромторга'));
});

test('имя компании из базы экранируется', () => {
    const html = companyCards([{ id: 7, company: 'ООО «Завод» <b>', claimed: true }]);
    assert.ok(!html.includes('<b>'), html);
});

test('тело страницы содержит контент без участия JavaScript', () => {
    // ТЗ §6.1: основной контент и ссылки обязаны быть в исходном HTML.
    const p = page({
        related: {
            companies: [{ id: 1, company: 'ООО Первый', claimed: true }],
            entities: [{ slug: 'valy', name: 'Валы' }],
            orders: [{ id: 9, title: 'Вал ступенчатый', deadline: '01.10.2026' }],
        },
    });
    const html = buildBody(p);
    assert.match(html, /ООО Первый/);
    assert.match(html, /href="\/izdeliya\/valy"/);
    assert.match(html, /Вал ступенчатый/);
    assert.match(html, /Открытые закупки по теме/);
});

test('без открытых закупок блок закупок отсутствует', () => {
    const html = buildBody(page());
    assert.ok(!html.includes('Открытые закупки'), 'обещать несуществующие заявки нельзя — ТЗ §6.6');
});

// ─────────────────── Разметка ───────────────────

test('число в разметке совпадает с числом карточек на странице', () => {
    // Расхождение — это недостоверные структурированные данные, ТЗ §10.6.
    const p = page({ related: { companies: [{ id: 1, company: 'А' }, { id: 2, company: 'Б' }], entities: [], orders: [] } });
    const ld = JSON.parse(buildJsonLd(p, 'https://texzakaz.ru').replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
    assert.equal(ld.mainEntity.numberOfItems, 2);
    assert.equal(ld.url, 'https://texzakaz.ru/uslugi/tokarnaya-obrabotka');
    assert.equal(ld.breadcrumb.itemListElement.length, 3);
});
