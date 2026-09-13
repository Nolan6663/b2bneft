'use strict';

// Тематический хаб открытых заказов: /zakazy/{service-or-product}.
//
// Это единственная страница кластера, обращённая к исполнителю, а не к
// заказчику: там ищут работу, а не производство. ТЗ §2.2 требует разводить эти
// интенты, поэтому и заголовок, и первый экран, и призыв к действию здесь
// другие — «откликнуться и подписаться», а не «загрузить чертёж».
//
// Две вещи, которые отличают этот хаб от страниц услуг и изделий:
//
// 1. Индексация зависит не только от решения редактора, но и от живого
//    наполнения. Маркетинг в ответе на вопрос 1 задал условие прямо: «Хаб
//    заказов — от 10 показов и не менее 3 новых релевантных заказов за
//    последние 90 дней». Условие сформулировано в настоящем времени, поэтому
//    оно проверяется на каждой отрисовке, а не один раз при публикации. Хаб,
//    в котором заказы кончились, уходит в noindex сам — иначе в индексе
//    остаётся страница, обещающая работу, которой нет.
//
// 2. Карточка заказа обезличена. Публичная часть заказа по ответу маркетинга
//    на вопрос 4 — это предмет, категория, количество и сроки; название
//    компании-заказчика и её контакты туда не входят, пока нет механизма
//    согласия. Поэтому в карточке хаба заказчик не назван.

const { getThreshold } = require('./catalog-settings');
const { robotsFor, isIndexable } = require('./catalog-schema');
const { esc, plural, fitTitle } = require('./cluster-seo');

const ROOT = '/zakazy';
const CARD_LIMIT = 20;

/** Порог наполнения: сколько свежих заказов должно быть в хабе и за какой срок. */
function supplyRule() {
    return {
        minOrders: getThreshold('threshold.orderhub.supply', 3),
        windowDays: getThreshold('threshold.orderhub.window', 90),
    };
}

/**
 * Хватает ли хабу наполнения, чтобы звать робота.
 * @param {number} freshCount заказов, созданных за окно
 */
function meetsSupply(freshCount) {
    return freshCount >= supplyRule().minOrders;
}

/**
 * Meta robots хаба: решение редактора И живое наполнение.
 *
 * Ужесточать статус можно, ослаблять — нет: если редактор оставил страницу
 * в noindex, никакое количество заказов её не откроет. Обратное неверно —
 * опубликованный хаб без заказов закрывается автоматически.
 */
function robotsForHub(landing, freshCount) {
    if (!isIndexable(landing)) return robotsFor(landing);
    return meetsSupply(freshCount) ? 'index, follow' : 'noindex, follow';
}

/** Пускать ли хаб в карту сайта. Ровно то же условие, что у мета-тега:
 *  расхождение между ними и есть источник «просканировано — не проиндексировано». */
function hubInSitemap(landing, freshCount) {
    return robotsForHub(landing, freshCount) === 'index, follow';
}

/* Падеж — отдельная история, и притворяться, что мы его умеем, нельзя.
   «Заказы на токарная обработка» читается безграмотно, а склонять названия
   кодом — значит однажды выдать в поиск «заказы на литьюю». Русская морфология
   правилами не покрывается: у «токарная обработка» винительный «токарную
   обработку», у «валы» он совпадает с именительным, у «литьё под давлением»
   меняется только первое слово.

   Поэтому конструкция подобрана так, чтобы падеж был не нужен вовсе: название
   стоит после двоеточия и остаётся в именительном. Редактор, которому нужна
   естественная формулировка, вписывает её в поле title посадочной страницы —
   оно всегда важнее сгенерированного (ТЗ §13.2). */
/** Поле заполняется без предлога — «токарную обработку», а не «на токарную
 *  обработку». Но редактор напишет и так и так, поэтому лишний предлог
 *  срезаем: «Заказы на на токарную обработку» в выдаче хуже, чем отсутствие
 *  склонения вовсе. */
function accusative(entity) {
    const raw = String(entity.accusative || '').trim().replace(/^на\s+/i, '');
    return raw ? `на ${raw}` : null;
}

function buildTitle(entity, openCount) {
    const natural = accusative(entity);
    const subject = natural ? `Заказы ${natural}` : `Открытые заказы: ${entity.name}`;
    const tail = openCount ? ` — ${openCount} ${plural(openCount, 'заявка', 'заявки', 'заявок')}` : '';
    return fitTitle(subject, tail, ' · ТехЗаказ');
}

function buildDescription(entity, openCount, freshCount) {
    const natural = accusative(entity);
    const subject = natural ? `Заказы ${natural}` : `Открытые заказы по теме «${entity.name}»`;
    const base = openCount
        ? `${subject}: ${openCount} ${plural(openCount, 'заявка', 'заявки', 'заявок')} от заказчиков напрямую. Отклик без тендерных процедур, посредников и платы за участие.`
        : `${subject} от производственных предприятий. Подпишитесь на новые заявки — письмо придёт, как только появится подходящая.`;
    void freshCount;
    return base.length <= 160 ? base : base.slice(0, 157).replace(/[\s,.]+$/, '') + '…';
}

function buildH1(entity) {
    const natural = accusative(entity);
    return natural ? `Заказы ${natural}` : `Открытые заказы: ${entity.name}`;
}

function buildBreadcrumb(entity) {
    return [
        '<a href="/">Главная</a><span>›</span>',
        `<a href="${ROOT}">Заказы</a><span>›</span>`,
        `<span>${esc(entity.name)}</span>`,
    ].join('\n      ');
}

/** Первый экран для исполнителя: сколько всего открыто и сколько появилось
 *  за период. Второе число важнее первого — оно говорит, живой ли раздел. */
function buildStats(openCount, freshCount) {
    const { windowDays } = supplyRule();
    const out = [];
    if (openCount) {
        out.push(`<div class="zr-stat"><b>${openCount}</b><span>${plural(openCount, 'открытый заказ', 'открытых заказа', 'открытых заказов')}</span></div>`);
    }
    if (freshCount) {
        out.push(`<div class="zr-stat"><b>${freshCount}</b><span>новых за ${windowDays} ${plural(windowDays, 'день', 'дня', 'дней')}</span></div>`);
    }
    return out.join('\n      ');
}

/** Карточка заказа без заказчика: публичная часть — предмет, категория,
 *  количество, срок и признак приложенного чертежа (ТЗ §6.6). */
function orderCard(order) {
    const facts = [];
    if (order.category) facts.push(esc(order.category));
    if (order.material) facts.push(esc(order.material));
    if (order.quantity) facts.push(`${Number(order.quantity)} шт.`);
    // Тип производства идёт сразу за количеством: «40 шт.» само по себе не
    // говорит, разовая это работа или начало серии, а для исполнителя это
    // решающая разница.
    if (order.productionType) facts.push(esc(order.productionType).toLowerCase());
    if (order.deadline) facts.push(`срок подачи ${esc(order.deadline)}`);
    if (order.hasDrawing) facts.push('чертёж приложен');
    return `      <li class="zr-card">
        <a class="zr-card-name" href="/zakupka/${Number(order.id)}">${esc(order.title)}</a>
        ${facts.length ? `<p class="zr-card-line">${facts.join(' · ')}</p>` : ''}
      </li>`;
}

/**
 * Пустое состояние. ТЗ §6.6 требует прямо: «текст не должен обещать
 * несуществующие заявки». Поэтому здесь не «заказы скоро появятся», а честное
 * «сейчас нет» и два действия, которые реально имеют смысл.
 */
function emptyState(entity) {
    return `    <p class="zr-empty">Сейчас по этой теме открытых заказов нет. Это не значит, что их не бывает:
      заявки появляются неравномерно, и большинство закрывается за несколько дней.</p>
    <ul class="zr-actions">
      <li><a href="/login#register">Подпишитесь на новые заказы</a> — письмо придёт, как только появится подходящая заявка.</li>
      <li><a href="/login#register">Заполните профиль производства</a>: заказчики находят исполнителей через каталог и приглашают в закупку напрямую.</li>
    </ul>\n`;
}

function buildBody(entity, orders, related) {
    const parts = [];

    if (!orders || !orders.length) {
        parts.push(emptyState(entity));
    } else {
        const cards = orders.slice(0, CARD_LIMIT).map(orderCard).join('\n');
        parts.push(`    <ul class="zr-cards">\n${cards}\n    </ul>\n`);
        parts.push('    <p class="zr-more">Чтобы откликнуться, <a href="/login#register">заполните профиль производства</a>. '
            + 'Отклик уходит заказчику напрямую, без тендерных процедур.</p>\n');
    }

    // Куда пойти заказчику, если он попал сюда по ошибке: ТЗ §7.1 требует
    // связи хаба заказов с соответствующей услугой или изделием.
    if (related && related.href) {
        parts.push(
            '    <h2 class="zr-h2">Нужно изготовить, а не выполнить?</h2>\n'
            + `    <p class="zr-more"><a href="${esc(related.href)}">${esc(related.title)}</a>`
            + ' — страница для заказчика: что учесть в чертеже и кто это делает.</p>\n'
        );
    }

    return parts.join('\n');
}

function buildJsonLd(entity, orders, base) {
    const root = String(base || '').replace(/\/$/, '');
    return JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: buildH1(entity),
        url: `${root}${ROOT}/${entity.slug}`,
        breadcrumb: {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Главная', item: root },
                { '@type': 'ListItem', position: 2, name: 'Заказы', item: `${root}${ROOT}` },
                { '@type': 'ListItem', position: 3, name: entity.name },
            ],
        },
        mainEntity: { '@type': 'ItemList', numberOfItems: orders ? orders.length : 0 },
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

module.exports = {
    ROOT, CARD_LIMIT,
    supplyRule, meetsSupply, robotsForHub, hubInSitemap,
    buildTitle, buildDescription, buildH1, buildBreadcrumb, buildStats,
    buildBody, buildJsonLd, orderCard, emptyState,
};
