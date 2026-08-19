'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { REGIONS, regionBySlug, regionLabel } = require('../../seo/regions-data');
const {
    buildRegionTitle,
    buildRegionDescription,
    buildRegionRobots,
    buildRegionSsr,
    buildRegionJsonLd,
} = require('../../lib/region-seo');

const SVERD = regionBySlug('sverdlovskaya');

const PRODUCERS = [
    { id: 11, company: 'ООО «Уралрезина»', city: 'Свердловская область', specialization: 'РТИ, уплотнения', products: 'манжеты; кольца', verifiedByPlatform: true, claimed: true },
    { id: 12, company: 'АО «Механик»', city: 'Свердловская область', specialization: 'Металлообработка', products: 'токарные работы', verifiedByPlatform: false, claimed: false, source: 'gisp-pp719' },
];

test('регионы: слаги уникальны и без заглавных', () => {
    const slugs = REGIONS.map(r => r.slug);
    assert.equal(new Set(slugs).size, slugs.length, 'слаги должны быть уникальны');
    for (const s of slugs) assert.match(s, /^[a-z-]+$/, `слаг «${s}» должен быть латиницей в нижнем регистре`);
});

test('регионы: у каждого есть предложный падеж и имя как в базе', () => {
    for (const r of REGIONS) {
        assert.ok(r.name && r.name.length > 3, `нет имени: ${r.slug}`);
        assert.match(r.where, /^в[о]?\s/, `предложный падеж должен начинаться с «в»: ${r.slug}`);
    }
});

test('регион по слагу: находится и не путается с чужим', () => {
    assert.equal(regionBySlug('moskva').name, 'Москва');
    assert.equal(regionBySlug('MOSKVA').name, 'Москва', 'слаг нечувствителен к регистру');
    assert.equal(regionBySlug('нет-такого'), null);
    assert.equal(regionLabel(regionBySlug('tatarstan')), 'Татарстан', 'для республик берём короткое имя');
});

test('title: с числом предприятий и в пределах длины выдачи', () => {
    const title = buildRegionTitle(SVERD, 197);
    assert.match(title, /Свердловской области/);
    assert.match(title, /197/);
    assert.ok(title.length <= 60, `title ${title.length} знаков — длиннее 60 обрежется в выдаче`);
});

test('title: ни один регион не выходит за 60 знаков, даже с четырёхзначным числом', () => {
    /* Аудит 19.08.2026: 27 региональных страниц отдавали title на 62–65 знаков.
       Обрезалось при этом не имя бренда в конце, а «188 предприятий» — то самое,
       ради чего на страницу кликают. Теперь бренд уходит первым. */
    for (const r of REGIONS) {
        const t = buildRegionTitle(r, 1888);
        assert.ok(t.length <= 60, `${r.slug}: title ${t.length} знаков — «${t}»`);
        assert.match(t, /1888/, `${r.slug}: из заголовка пропало число предприятий`);
    }
});

test('title: короткому региону бренд достаётся', () => {
    assert.match(buildRegionTitle(regionBySlug('moskva'), 302), /ТехЗаказ$/);
});

test('description: без выдуманных цифр и не длиннее 160 знаков', () => {
    const desc = buildRegionDescription(SVERD, { total: 197, verified: 3, categories: [['РТИ', 20], ['Металл', 8]] });
    assert.ok(desc.length <= 160, `description ${desc.length} знаков`);
    assert.match(desc, /197/);
    assert.match(desc, /РТИ/, 'аббревиатуру направления не переводим в нижний регистр');
    assert.ok(!/\d+\s*%/.test(desc), 'проценты в описании не выдумываем');
});

test('склонение: 1 предприятие, 41 предприятие, 197 предприятий', () => {
    const { plural } = require('../../lib/region-seo');
    assert.equal(plural(1, 'предприятие', 'предприятия', 'предприятий'), 'предприятие');
    assert.equal(plural(41, 'предприятие', 'предприятия', 'предприятий'), 'предприятие');
    assert.equal(plural(22, 'предприятие', 'предприятия', 'предприятий'), 'предприятия');
    assert.equal(plural(197, 'предприятие', 'предприятия', 'предприятий'), 'предприятий');
    assert.equal(plural(11, 'предприятие', 'предприятия', 'предприятий'), 'предприятий');
});

test('robots: пустой регион не зовём в индекс', () => {
    assert.equal(buildRegionRobots(0), 'noindex, follow');
    assert.equal(buildRegionRobots(3), 'noindex, follow', 'меньше пяти предприятий — витрина пустая');
    assert.equal(buildRegionRobots(41), 'index, follow');
});

test('SSR: карточки с экранированием и ссылками на профили', () => {
    const html = buildRegionSsr(SVERD, PRODUCERS, { total: 2, categories: [['РТИ', 1], ['Металл', 1]] });
    assert.match(html, /\/p\/11/);
    assert.match(html, /Уралрезина/);
    assert.match(html, /Металлообработка/);
    assert.ok(!html.includes('<script'), 'в SSR-разметку скрипты не попадают');
});

test('SSR: опасные символы в названии компании экранируются', () => {
    const html = buildRegionSsr(SVERD, [{ id: 5, company: '<img src=x onerror=alert(1)>', city: 'Свердловская область', specialization: '', products: '' }], { total: 1, categories: [] });
    assert.ok(!html.includes('<img src=x'), 'сырой HTML из базы в страницу не попадает');
    assert.match(html, /&lt;img/);
});

test('JSON-LD: валидный JSON с хлебными крошками и числом позиций', () => {
    const raw = buildRegionJsonLd(SVERD, { total: 197 }, 'https://texzakaz.ru');
    const parsed = JSON.parse(raw);
    assert.equal(parsed['@type'], 'CollectionPage');
    assert.equal(parsed.breadcrumb.itemListElement.length, 3);
    assert.equal(parsed.mainEntity.numberOfItems, 197);
    assert.match(parsed.url, /\/zakupki\/region\/sverdlovskaya$/);
});
