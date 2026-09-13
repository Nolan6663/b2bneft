'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../../lib/catalog-settings');
const hub = require('../../lib/orders-hub');

afterEach(() => settings.resetForTesting());

/* Хаб заказов — единственная страница кластера для исполнителя, и единственная,
   чья индексация зависит от живого наполнения. Условие задал маркетинг в
   ответе на вопрос 1: «не менее 3 новых релевантных заказов за последние 90
   дней». Оно сформулировано в настоящем времени, значит проверяется постоянно. */

const SERVICE = { id: 1, slug: 'tokarnaya-obrabotka', name: 'Токарная обработка' };

// ─────────────────── Порог наполнения ───────────────────

test('порог берётся из настроек, а не из кода', () => {
    settings.setForTesting({ 'threshold.orderhub.supply': 5, 'threshold.orderhub.window': 30 });
    assert.deepEqual(hub.supplyRule(), { minOrders: 5, windowDays: 30 });
    assert.equal(hub.meetsSupply(4), false);
    assert.equal(hub.meetsSupply(5), true);
});

test('без настроек работают значения из ответа маркетинга', () => {
    settings.resetForTesting();
    assert.deepEqual(hub.supplyRule(), { minOrders: 3, windowDays: 90 });
});

test('опубликованный хаб без свежих заказов закрывается сам', () => {
    // Иначе в индексе остаётся страница, обещающая работу, которой нет.
    const landing = { status: 'published_index' };
    assert.equal(hub.robotsForHub(landing, 3), 'index, follow');
    assert.equal(hub.robotsForHub(landing, 2), 'noindex, follow');
    assert.equal(hub.robotsForHub(landing, 0), 'noindex, follow');
});

test('наполнение ужесточает статус, но не смягчает', () => {
    // Решение редактора закрыть страницу сильнее любого количества заказов.
    assert.equal(hub.robotsForHub({ status: 'published_noindex' }, 100), 'noindex, follow');
    assert.equal(hub.robotsForHub({ status: 'draft' }, 100), 'noindex, follow');
    assert.equal(hub.robotsForHub(null, 100), 'noindex, follow');
});

test('карта сайта и мета-тег отвечают одинаково', () => {
    // Расхождение между ними — прямой путь к «просканировано, не проиндексировано».
    for (const fresh of [0, 2, 3, 50]) {
        const landing = { status: 'published_index' };
        assert.equal(
            hub.hubInSitemap(landing, fresh),
            hub.robotsForHub(landing, fresh) === 'index, follow',
            `при ${fresh} свежих заказах`
        );
    }
});

// ─────────────────── Заголовки ───────────────────

test('заголовок не склоняет название и не выглядит безграмотно', () => {
    // «Заказы на токарная обработка» — именно то, чего здесь быть не должно.
    const h1 = hub.buildH1(SERVICE);
    assert.equal(h1, 'Открытые заказы: Токарная обработка');
    assert.ok(!/на Токарная/i.test(h1));
});

test('редактор может задать естественную формулировку', () => {
    const withCase = { ...SERVICE, accusative: 'токарную обработку' };
    assert.equal(hub.buildH1(withCase), 'Заказы на токарную обработку');
});

test('лишний предлог в поле редактора не удваивается', () => {
    const withPreposition = { ...SERVICE, accusative: 'на токарную обработку' };
    assert.equal(hub.buildH1(withPreposition), 'Заказы на токарную обработку');
});

test('title держится в пределах выдачи', () => {
    const long = { ...SERVICE, name: 'Электроэрозионная проволочная и прошивная обработка' };
    assert.ok(hub.buildTitle(long, 12).length <= 60, hub.buildTitle(long, 12));
    assert.ok(hub.buildDescription(long, 12, 5).length <= 160);
});

// ─────────────────── Содержание ───────────────────

test('пустой хаб не обещает несуществующих заявок', () => {
    // Прямое требование ТЗ §6.6.
    const html = hub.buildBody(SERVICE, [], null);
    assert.match(html, /открытых заказов нет/i);
    assert.ok(!/скоро появятся|ожидаются|в ближайшее время/i.test(html), html);
    assert.match(html, /Подпишитесь/, 'вместо обещаний — действие');
    assert.match(html, /Заполните профиль/);
});

test('карточка заказа не называет заказчика', () => {
    // Публичная часть по ответу на вопрос 4 — предмет, категория, сроки.
    // Название компании туда не входит, пока нет механизма согласия.
    const html = hub.orderCard({
        id: 7, title: 'Вал ступенчатый', category: 'Металлообработка',
        quantity: 40, deadline: '01.10.2026', hasDrawing: true,
    });
    assert.match(html, /Вал ступенчатый/);
    assert.match(html, /40 шт\./);
    assert.match(html, /чертёж приложен/);
    assert.match(html, /href="\/zakupka\/7"/);
    assert.ok(!/ООО|заказчик/i.test(html), html);
});

test('данные заказа экранируются', () => {
    const html = hub.orderCard({ id: 1, title: '<img src=x onerror=alert(1)>', category: '' });
    assert.ok(!html.includes('<img'), html);
});

test('хаб ссылается на страницу для заказчика', () => {
    // ТЗ §7.1 требует связи хаба заказов с услугой или изделием.
    const html = hub.buildBody(SERVICE, [{ id: 1, title: 'Вал' }], {
        href: '/uslugi/tokarnaya-obrabotka', title: 'Токарная обработка',
    });
    assert.match(html, /href="\/uslugi\/tokarnaya-obrabotka"/);
});

test('первый экран показывает и общее число, и свежие', () => {
    settings.setForTesting({ 'threshold.orderhub.window': 90 });
    const stats = hub.buildStats(12, 4);
    assert.match(stats, /12/);
    assert.match(stats, /4/);
    assert.match(stats, /новых за 90 дней/);
});

test('нулевые показатели в первый экран не выводятся', () => {
    assert.equal(hub.buildStats(0, 0), '', 'ноль в счётчике отталкивает и ничего не сообщает');
});
