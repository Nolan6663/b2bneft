'use strict';

// Страницы эталонного кластера: /uslugi/{service}/ и /izdeliya/{product}/.
//
// Здесь впервые применяется реестр посадочных страниц: до сих пор статусы из
// ТЗ §4.3 существовали в базе, но ни одна страница по ним не отдавалась. Теперь
// статус определяет и код ответа, и meta robots, и попадание в карту сайта —
// из одного места, а не тремя независимыми решениями.
//
// Раздел /podryadchiki/ живёт в lib/contractors-seo.js. Он ждал ответа
// маркетинга до 22.09: в приложении «Архитектура публичных страниц» адрес был
// описан дважды и с противоположными смыслами — в разделе 1 как ролевой лендинг
// для исполнителей, в разделе 6 как каталог подрядчиков для заказчика. Выбран
// второй вариант, ролевые лендинги уезжают на /zakazchikam/ и /ispolnitelyam/.

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

/* 60 знаков — предел, после которого выдача обрезает заголовок многоточием.
   Сначала жертвуем брендом: поисковик всё равно подставит имя сайта рядом со
   ссылкой. Если и без него не влезает — режем по границе слова сами, иначе
   обрежет поисковик, и первым под нож пойдёт конец строки, а там как раз
   число исполнителей, ради которого на ссылку и кликают. */
const TITLE_MAX = 60;

/**
 * Собирает заголовок из изменяемой части (название сущности) и хвоста, который
 * терять нельзя, — числа исполнителей или заявок.
 *
 * Порядок жертв важен. Сначала отбрасываем бренд: поисковик и так подставит
 * имя сайта рядом со ссылкой. Если не хватило — режем **название**, а не хвост:
 * длинное «Электроэрозионная проволочная и прошивная обработка» человек узнает
 * и по половине, а «12 исполнителей» — это то, ради чего на ссылку кликают,
 * и обрезать его бессмысленно.
 *
 * @param {string} lead    изменяемая часть
 * @param {string} tail    хвост вместе с разделителем, например ': 12 исполнителей'
 * @param {string} brand   отбрасывается первым
 */
function fitTitle(lead, tail = '', brand = ' — ТехЗаказ') {
    if ((lead + tail + brand).length <= TITLE_MAX) return lead + tail + brand;
    if ((lead + tail).length <= TITLE_MAX) return lead + tail;

    const budget = TITLE_MAX - tail.length - 1; // −1 на многоточие
    if (budget < 12) {
        // Хвост сам по себе почти исчерпал лимит: резать название до огрызка
        // бессмысленно, лучше отдать его целиком и без хвоста.
        const cut = lead.slice(0, TITLE_MAX - 1);
        const space = cut.lastIndexOf(' ');
        return (space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,:;—·-]+$/, '') + '…';
    }
    const cut = lead.slice(0, budget);
    const space = cut.lastIndexOf(' ');
    const trimmed = (space > budget * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,:;—·-]+$/, '');
    return trimmed + '…' + tail;
}

/** Заголовок вкладки. Редакторский вариант важнее сгенерированного: если в
 *  реестре заполнено поле title, оно и уходит в выдачу. */
function buildTitle(page) {
    if (page.landing && page.landing.title) return page.landing.title;
    const n = page.counts ? page.counts.companies : 0;
    return n
        ? fitTitle(page.entity.name, `: ${n} ${plural(n, 'исполнитель', 'исполнителя', 'исполнителей')}`)
        : fitTitle(page.entity.name, ' на заказ');
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

/** Ссылка на каталог подрядчиков по теме — ТЗ §6.4, §7.1.
 *
 *  Список исполнителей здесь обрезан двадцатью карточками: страница услуги
 *  рассказывает про услугу, а не листает каталог. Остальные живут на
 *  /podryadchiki/{slug}, и ссылка туда ставится только когда она осмысленна:
 *  есть открытая страница каталога И показано не всё. Ссылка «показать все» под
 *  полным списком — обман, а ссылка на страницу с noindex тратит обход впустую,
 *  поэтому адрес приходит уже проверенным (routes/cluster: loadContractorHref).
 */
function contractorLink(page) {
    const href = page.related && page.related.contractorHref;
    if (!href) return '';
    const shown = page.counts ? page.counts.companies : 0;
    const total = page.counts ? (page.counts.companiesTotal || shown) : 0;
    if (total <= shown) return '';
    return `    <p class="zr-more"><a href="${esc(href)}">Все ${total} `
        + `${plural(total, 'предприятие', 'предприятия', 'предприятий')} по теме</a>`
        + ' — с городом, специализацией и происхождением карточки.</p>\n';
}

/** Кейсы по теме — ТЗ §9.3. Стоят выше открытых закупок намеренно: заказчик
 *  на этой странице выбирает исполнителя, и подтверждение «такое уже делали»
 *  ему нужнее, чем чужие заявки. */
function caseBlock(cases) {
    if (!cases || !cases.length) return '';
    const items = cases.slice(0, 6).map(c => `      <li class="zr-card">
        <a class="zr-card-name" href="/keisy/${esc(c.slug)}">${esc(c.title)}</a>
        ${c.company ? `<p class="zr-card-line">${esc(c.company)}</p>` : ''}
      </li>`).join('\n');
    return `    <h2 class="zr-h2">Выполненные работы</h2>\n    <ul class="zr-cards">\n${items}\n    </ul>\n`;
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
    parts.push(contractorLink(page));

    parts.push(linkBlock(
        kind.relatedName,
        page.related && page.related.entities,
        (i) => `${kind.relatedRoot}/${i.slug}`,
    ));

    parts.push(caseBlock(page.related && page.related.cases));

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
    KINDS, MAX_LINKS, TITLE_MAX, fitTitle,
    responseFor, buildTitle, buildDescription, buildH1, buildBreadcrumb,
    buildBody, buildJsonLd, linkBlock, companyCards, orderBlock, caseBlock,
    contractorLink, esc, plural,
    isIndexable,
};
