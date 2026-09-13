'use strict';

// Страницы эталонного кластера: /uslugi/{service}/ и /izdeliya/{product}/.
//
// Здесь впервые применяется реестр посадочных страниц: до сих пор статусы из
// ТЗ §4.3 существовали в базе, но ни одна страница по ним не отдавалась. Теперь
// статус определяет и код ответа, и meta robots, и попадание в карту сайта —
// из одного места, а не тремя независимыми решениями.
//
// Раздел /podryadchiki/ намеренно не реализован. В приложении «Архитектура
// публичных страниц» этот адрес описан дважды и с противоположными смыслами:
// в разделе 1 как ролевой лендинг для исполнителей, в разделе 6 как каталог
// подрядчиков для заказчика. Пока маркетинг не выберет один вариант, писать
// страницу нельзя: адрес попадёт в карту сайта и в 301-карту, а переделывать
// это потом дороже, чем подождать.

const { isIndexable, robotsFor } = require('./catalog-schema');

/* Не больше двенадцати ссылок в блоке. Без потолка страница популярной услуги
   соберёт сотни ссылок на изделия и размажет вес по всему каталогу, а читателю
   такой список бесполезен — ТЗ §7.3 требует ограничивать перелинковку. */
const MAX_LINKS = 12;

const KINDS = {
    service: {
        root: '/uslugi',
        rootName: 'Услуги',
        crumbName: 'Услуги',
        // Что показываем на странице услуги: изделия, которые ею делают.
        relatedName: 'Изделия, которые изготавливают этой технологией',
        relatedRoot: '/izdeliya',
    },
    product: {
        root: '/izdeliya',
        rootName: 'Изделия',
        crumbName: 'Изделия',
        relatedName: 'Технологии изготовления',
        relatedRoot: '/uslugi',
    },
};

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

/**
 * Что сервер должен ответить по этой посадочной странице.
 *
 * Разведение кодов ответа — требование ТЗ §10.7 и §4.3. Мягкий 404 с кодом 200
 * запрещён, поэтому «страницы нет» и «страница удалена» отвечают по-разному:
 * 404 говорит роботу «может, появится», 410 — «не приходи больше».
 *
 * @param {object|null} landing строка landing_pages либо null, если её нет
 * @returns {{status:number, robots?:string, location?:string}}
 */
function responseFor(landing) {
    // Сущность в справочнике есть, а страницы для неё не заводили. Публичного
    // адреса у неё нет — это не ошибка редактора, а нормальное состояние
    // («Краулинговый бюджет» §2.1: существование сущности не создаёт URL).
    if (!landing) return { status: 404 };

    switch (landing.status) {
        case 'draft':
            // Черновик виден только в админке.
            return { status: 404 };
        case 'preview':
        case 'published_noindex':
            return { status: 200, robots: robotsFor(landing) };
        case 'published_index':
            return { status: 200, robots: robotsFor(landing) };
        case 'merged':
            // Редирект без адреса — ошибка данных, но отдавать 301 в никуда
            // нельзя: цепочка оборвётся, и робот получит бесконечный цикл.
            return landing.redirect_to
                ? { status: 301, location: landing.redirect_to }
                : { status: 404 };
        case 'archived':
            return { status: 410 };
        default:
            // Неизвестный статус — считаем, что страницы нет. Молча отдать 200
            // с индексацией опаснее: так в индекс уедет что угодно.
            return { status: 404 };
    }
}

/** Заголовок вкладки. Редакторский вариант важнее сгенерированного: если в
 *  реестре заполнено поле title, оно и уходит в выдачу. */
function buildTitle(page) {
    if (page.landing && page.landing.title) return page.landing.title;
    const n = page.counts ? page.counts.companies : 0;
    const head = n
        ? `${page.entity.name}: ${n} ${plural(n, 'исполнитель', 'исполнителя', 'исполнителей')}`
        : `${page.entity.name} на заказ`;
    const withBrand = `${head} — ТехЗаказ`;
    return withBrand.length <= 60 ? withBrand : head;
}

function buildDescription(page) {
    if (page.landing && page.landing.description) return page.landing.description;
    const kind = KINDS[page.kind];
    const n = page.counts ? page.counts.companies : 0;
    const who = n
        ? `${n} ${plural(n, 'производство', 'производства', 'производств')} в каталоге`
        : 'производства по всей России';
    const base = page.kind === 'service'
        ? `${page.entity.name} на заказ: ${who}. Загрузите чертёж — предложения придут напрямую от заводов, без посредников.`
        : `Изготовление «${page.entity.name}» по чертежам заказчика: ${who}. Загрузите чертёж и получите предложения напрямую.`;
    void kind;
    return base.length <= 160 ? base : base.slice(0, 157).replace(/[\s,.]+$/, '') + '…';
}

function buildH1(page) {
    if (page.landing && page.landing.h1) return page.landing.h1;
    return page.kind === 'service' ? page.entity.name : `Изготовление «${page.entity.name}»`;
}

function buildBreadcrumb(page) {
    const kind = KINDS[page.kind];
    return [
        '<a href="/">Главная</a><span>›</span>',
        `<a href="${kind.root}">${esc(kind.crumbName)}</a><span>›</span>`,
        `<span>${esc(page.entity.name)}</span>`,
    ].join('\n      ');
}

/** Блок ссылок. Пустой блок не рисуется вовсе — ТЗ §7.3 запрещает выводить
 *  ссылки на комбинации без результатов, а заголовок над пустотой ещё и
 *  обманывает читателя. */
function linkBlock(title, items, hrefOf, { limit = MAX_LINKS, moreHref = '', moreText = '' } = {}) {
    if (!items || !items.length) return '';
    const shown = items.slice(0, limit);
    const links = shown
        .map(i => `<li><a href="${esc(hrefOf(i))}">${esc(i.name || i.company || i.title)}</a></li>`)
        .join('\n      ');
    const more = items.length > limit && moreHref
        ? `\n    <p class="zr-more"><a href="${esc(moreHref)}">${esc(moreText || 'Показать все')}</a></p>`
        : '';
    return `    <h2 class="zr-h2">${esc(title)}</h2>\n    <ul class="zr-regions">\n      ${links}\n    </ul>${more}\n`;
}

/** Карточки исполнителей — то же представление, что на страницах операций,
 *  чтобы каталог выглядел одинаково везде, где он появляется. */
function companyCards(companies) {
    if (!companies || !companies.length) {
        return '    <p class="zr-empty">Пока ни одно предприятие не заявило эту позицию в профиле. '
            + 'Если вы её выполняете — <a href="/login#register">заполните профиль</a>, и производство появится здесь.</p>\n';
    }
    const cards = companies.map(c => {
        const where = String(c.city || '').trim();
        const line = String(c.specialization || c.products || '').trim().slice(0, 160);
        const badge = c.verifiedByPlatform
            ? '<span class="zr-badge zr-badge--ok">Проверен платформой</span>'
            : (c.claimed ? '' : '<span class="zr-badge">Реестр Минпромторга</span>');
        return `      <li class="zr-card">
        <a class="zr-card-name" href="/p/${Number(c.id)}">${esc(c.company)}</a>
        ${where ? `<p class="zr-card-line">${esc(where)}</p>` : ''}
        ${badge}
        ${line ? `<p class="zr-card-line">${esc(line)}</p>` : ''}
      </li>`;
    }).join('\n');
    return `    <ul class="zr-cards">\n${cards}\n    </ul>\n`;
}

/** Открытые закупки по теме — блок для переключения роли (ТЗ §6.2). */
function orderBlock(orders) {
    if (!orders || !orders.length) return '';
    const items = orders.slice(0, 6).map(o => `      <li class="zr-card">
        <a class="zr-card-name" href="/zakupka/${Number(o.id)}">${esc(o.title)}</a>
        ${o.deadline ? `<p class="zr-card-line">Срок подачи: ${esc(o.deadline)}</p>` : ''}
      </li>`).join('\n');
    return `    <h2 class="zr-h2">Открытые закупки по теме</h2>\n    <ul class="zr-cards">\n${items}\n    </ul>\n`
        + '    <p class="zr-more">Вы производитель? <a href="/login#register">Заполните профиль</a>, чтобы получать такие заказы.</p>\n';
}

/** Тело страницы: всё, что должно быть в исходном HTML, а не появляться
 *  после JavaScript (ТЗ §6.1). */
function buildBody(page) {
    const kind = KINDS[page.kind];
    const parts = [];

    if (page.landing && page.landing.intro) {
        parts.push(`    <p class="zr-lead">${esc(page.landing.intro)}</p>\n`);
    } else if (page.entity.description) {
        parts.push(`    <p class="zr-lead">${esc(page.entity.description)}</p>\n`);
    }

    parts.push(`    <h2 class="zr-h2">Кто выполняет</h2>\n`);
    parts.push(companyCards(page.related && page.related.companies));

    parts.push(linkBlock(
        kind.relatedName,
        page.related && page.related.entities,
        (i) => `${kind.relatedRoot}/${i.slug}`,
    ));

    parts.push(orderBlock(page.related && page.related.orders));

    return parts.filter(Boolean).join('\n');
}

function buildJsonLd(page, base) {
    const root = String(base || '').replace(/\/$/, '');
    const kind = KINDS[page.kind];
    const url = `${root}${kind.root}/${page.entity.slug}`;
    return JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: buildH1(page),
        url,
        breadcrumb: {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Главная', item: root },
                { '@type': 'ListItem', position: 2, name: kind.crumbName, item: `${root}${kind.root}` },
                { '@type': 'ListItem', position: 3, name: page.entity.name },
            ],
        },
        // Число в разметке обязано совпадать с тем, что видно на странице:
        // расхождение — это недостоверные структурированные данные (ТЗ §10.6).
        mainEntity: {
            '@type': 'ItemList',
            numberOfItems: page.related && page.related.companies ? page.related.companies.length : 0,
        },
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

module.exports = {
    KINDS, MAX_LINKS,
    responseFor, buildTitle, buildDescription, buildH1, buildBreadcrumb,
    buildBody, buildJsonLd, linkBlock, companyCards, orderBlock, esc, plural,
    isIndexable,
};
