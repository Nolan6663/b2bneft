'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    PAGE_SIZE, isListable, sortForCatalog, pageCount, pageUrl,
    buildTitle, buildDescription, buildCards, buildPager, buildJsonLd,
} = require('../../lib/catalog-seo');

/* Каталог существует ради одного: чтобы до каждой карточки вёл обычный HTML-путь.
 * В Яндексе 715 страниц в поиске из 4584, и в «Исключённых» нет ни одной
 * карточки — робот их не забраковал, он до них не дошёл. Ссылок на карточки в
 * серверном HTML было: на главной ноль, на карте ноль, на регионе шестьдесят.
 * Поэтому главный тест здесь — покрытие: каждая карточка обязана попасть ровно
 * на одну страницу каталога. */

const company = (id, name, extra = {}) => ({
    id, company: name, city: 'Удмуртская Республика', products: 'манжеты', claimed: false, ...extra,
});

test('покрытие: каждая карточка попадает ровно на одну страницу каталога', () => {
    const all = sortForCatalog(Array.from({ length: 451 }, (_, i) => company(i + 1, `Завод ${String(i).padStart(3, '0')}`)));
    const pages = pageCount(all.length);
    assert.equal(pages, 5, `451 предприятие при ${PAGE_SIZE} на странице — это 5 страниц`);

    const seen = new Set();
    for (let p = 1; p <= pages; p++) {
        for (const item of all.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)) {
            assert.ok(!seen.has(item.id), `карточка ${item.id} попала на две страницы`);
            seen.add(item.id);
        }
    }
    assert.equal(seen.size, all.length, 'часть карточек не попала ни на одну страницу');
});

test('порядок устойчив: страница 7 завтра остаётся той же', () => {
    const rows = [company(3, 'Вымпел'), company(1, 'Авангард'), company(2, 'Авангард')];
    const first = sortForCatalog(rows).map(r => r.id);
    const second = sortForCatalog([...rows].reverse()).map(r => r.id);
    assert.deepEqual(first, second, 'при равных названиях порядок держит id');
    assert.deepEqual(first, [1, 2, 3]);
});

test('в каталог идут те же, что и в карту сайта: карточка с фактом, а не только с названием', () => {
    assert.ok(isListable({ products: 'манжеты' }));
    assert.ok(isListable({ specialization: 'РТИ' }));
    assert.ok(isListable({ about: 'Завод полного цикла' }));
    assert.ok(!isListable({ company: 'ООО Пустое', products: '', specialization: '', about: '' }));
});

test('первая страница живёт по корню, а не под вторым адресом', () => {
    assert.equal(pageUrl(1), '/proizvoditeli');
    assert.equal(pageUrl(2), '/proizvoditeli/2');
});

test('пагинация: соседи, края и многоточие вместо сорока ссылок подряд', () => {
    const html = buildPager(20, 46);
    assert.match(html, /href="\/proizvoditeli"/, 'первая страница доступна с любой');
    assert.match(html, /href="\/proizvoditeli\/46"/, 'последняя тоже');
    assert.match(html, /href="\/proizvoditeli\/19"/);
    assert.match(html, /href="\/proizvoditeli\/21"/);
    assert.match(html, /rel="prev"/);
    assert.match(html, /rel="next"/);
    assert.match(html, /…/, 'разрывы обозначены, а не перечислены');
    assert.doesNotMatch(html, /href="\/proizvoditeli\/20"/, 'текущая страница ссылкой на себя не ведёт');
});

test('пагинация: на единственной странице её нет', () => {
    assert.equal(buildPager(1, 1), '');
});

test('карточки: ссылка ведёт на профиль, город показан, разметка экранирована', () => {
    const html = buildCards([
        company(135, 'Глазовский завод', { town: 'Глазов' }),
        company(9, '<script>alert(1)</script>', { town: '' }),
    ]);
    assert.match(html, /href="\/p\/135"/);
    assert.match(html, /Глазов/);
    assert.doesNotMatch(html, /<script>alert/, 'название компании не должно исполняться');
    assert.match(html, /&lt;script&gt;/);
});

test('заголовок и описание: страница 1 и глубокая страница отличаются', () => {
    const first = buildTitle(1, 4531);
    const deep = buildTitle(7, 4531);
    assert.ok(first.length <= 65, `${first.length}: ${first}`);
    assert.ok(deep.length <= 65, `${deep.length}: ${deep}`);
    assert.notEqual(first, deep, 'одинаковый title на 46 страницах — это дубли');
    assert.match(deep, /страница 7/i);
    assert.match(buildDescription(1, 4531, 46), /4531/);
    assert.match(buildDescription(7, 4531, 46), /7 из 46/);
});

test('разметка перечисляет то, что показано, и продолжает нумерацию на второй странице', () => {
    const rows = [company(1, 'Альфа'), company(2, 'Бета')];
    const ld = JSON.parse(buildJsonLd(rows, { page: 3, pages: 46, base: 'https://texzakaz.ru' })
        .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
    const list = ld['@graph'][0];
    assert.equal(list['@type'], 'ItemList');
    assert.equal(list.numberOfItems, 2, 'обещаем ровно столько, сколько на странице');
    assert.equal(list.itemListElement[0].position, 201, 'нумерация продолжается сквозь страницы');
    assert.equal(list.itemListElement[0].url, 'https://texzakaz.ru/p/1');
    const crumbs = ld['@graph'][1];
    assert.equal(crumbs.itemListElement.length, 3, 'на глубокой странице крошка называет её номер');
});
