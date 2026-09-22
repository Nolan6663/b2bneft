'use strict';

// Каталог подрядчиков по теме: /podryadchiki/{service-or-product}.
//
// Четвёртая и последняя страница эталонного кластера. Писать её было нельзя до
// 22 сентября: в приложении «Архитектура публичных страниц» адрес /podryadchiki/
// стоял дважды — в разделе 1 как ролевой лендинг «стань исполнителем», в
// разделе 6 как витрина подрядчиков для заказчика. Маркетинг подтвердил второе
// (ответ 22.09, пункт 1): ролевые лендинги уезжают на /zakazchikam/ и
// /ispolnitelyam/, а /podryadchiki/ остаётся за каталогом.
//
// Чем эта страница отличается от /izdeliya/{product}, где список исполнителей
// тоже есть. Разный интент, и ТЗ §2.2 требует, чтобы разница была видна, иначе
// две страницы конкурируют за один запрос:
//
//   /izdeliya/valy      — «мне нужно изготовить вал»: что учесть в чертеже,
//                         форма заказа, первые двадцать исполнителей;
//   /podryadchiki/valy  — «кто вообще это делает»: полный список, разбивка по
//                         городам, происхождение каждой карточки.
//
// Отсюда и устройство: на странице изделия список обрезан и уводит сюда, а
// здесь нет формы заказа — она увела бы человека обратно, и обе страницы стали
// бы одинаковыми.

const { getThreshold } = require('./catalog-settings');
const { robotsFor, isIndexable } = require('./catalog-schema');
const { esc, plural, fitTitle } = require('./cluster-seo');

const ROOT = '/podryadchiki';

/* Сколько карточек показываем. Верхняя граница нужна не ради вёрстки, а ради
   перелинковки: страница с четырьмя сотнями ссылок на карточки размазывает вес
   по всему каталогу («Краулинговый бюджет» §9). Остаток уводим в /proizvoditeli
   одной ссылкой. */
const LIST_LIMIT = 48;

/* Сколько городов показываем в разбивке. Десять — примерно столько, сколько
   человек прочитывает, не пролистывая; остальные всё равно попадут в список
   карточек ниже. */
const CITY_LIMIT = 10;

/** Порог наполнения: сколько подходящих предприятий должно быть у темы.
 *  Значение подтверждено маркетингом (ответ 22.09, пункт 6) и живёт в
 *  настройке — правится без релиза. */
function supplyRule() {
    return { minCompanies: getThreshold('threshold.contractor.supply', 5) };
}

function meetsSupply(count) {
    return count >= supplyRule().minCompanies;
}

/**
 * Meta robots каталога: решение редактора И живое наполнение.
 *
 * Правило то же, что у хаба заказов: наполнение ужесточает статус, но не
 * смягчает. Каталог подрядчиков, в котором осталось два предприятия, — это
 * пустая витрина, и в индексе она вредна. Обратное неверно: если редактор
 * держит страницу закрытой, никакое количество карточек её не откроет.
 */
function robotsForCatalog(landing, companyCount) {
    if (!isIndexable(landing)) return robotsFor(landing);
    return meetsSupply(companyCount) ? 'index, follow' : 'noindex, follow';
}

/** Пускать ли каталог в карту сайта. Тот же предикат, что у мета-тега: два
 *  независимых ответа про один адрес и есть «просканировано, не
 *  проиндексировано». */
function catalogInSitemap(landing, companyCount) {
    return robotsForCatalog(landing, companyCount) === 'index, follow';
}

/* Падеж — та же история, что в хабе заказов, и решается так же. «Производители
   Валы» читается безграмотно, а склонять кодом нельзя: у «валы» родительный
   «валов», у «токарная обработка» — «токарной обработки», у «литьё под
   давлением» меняется только первое слово. Поэтому конструкция по умолчанию
   обходится без падежа — название после двоеточия остаётся в именительном, — а
   редактор, которому нужна естественная формулировка, вписывает её в поле
   genitive справочника. Ровно так маркетинг и назвал страницу в ответе 22.09:
   «Производители валов». */

/** Заголовок-существительное зависит от вида: изделие изготавливают, услугу
 *  выполняют. «Производители токарной обработки» — бессмыслица. */
function noun(entity) {
    return entity.kind === 'service' ? 'Исполнители' : 'Производители';
}

/** Родительный падеж из справочника. Редактор напишет и «валов», и
 *  «производители валов» — лишнее существительное срезаем, иначе получится
 *  «Производители производители валов». */
function genitive(entity) {
    const raw = String(entity.genitive || '').trim()
        .replace(/^(производител[аеийкэюя]*|исполнител[аеийкэюя]*)\s+/i, '');
    return raw || null;
}

/** Предмет заголовка: «Производители валов» либо «Производители: Валы». */
function subject(entity) {
    const natural = genitive(entity);
    return natural ? `${noun(entity)} ${natural}` : `${noun(entity)}: ${entity.name}`;
}

function buildTitle(entity, companyCount) {
    const tail = companyCount
        ? ` — ${companyCount} ${plural(companyCount, 'предприятие', 'предприятия', 'предприятий')}`
        : '';
    return fitTitle(subject(entity), tail, ' · ТехЗаказ');
}

function buildDescription(entity, companyCount, cityCount) {
    const who = companyCount
        ? `${companyCount} ${plural(companyCount, 'предприятие', 'предприятия', 'предприятий')}`
        : 'предприятия';
    const where = cityCount > 1
        ? ` в ${cityCount} ${plural(cityCount, 'городе', 'городах', 'городах')} России`
        : ' по России';
    const base = companyCount
        ? `${subject(entity)}: ${who}${where}. Специализация, город и происхождение каждой карточки — выбирайте и запрашивайте цену напрямую, без посредников.`
        : `${subject(entity)} — каталог производств. Разместите закупку: она уйдёт профильным предприятиям по всей стране, даже если их профили ещё не заполнены.`;
    return base.length <= 160 ? base : base.slice(0, 157).replace(/[\s,.]+$/, '') + '…';
}

function buildH1(entity) {
    return subject(entity);
}

function buildBreadcrumb(entity) {
    return [
        '<a href="/">Главная</a><span>›</span>',
        `<a href="${ROOT}">Подрядчики</a><span>›</span>`,
        `<span>${esc(entity.name)}</span>`,
    ].join('\n      ');
}

/** Первый экран. Второе число — города — здесь важнее, чем кажется: заказчик
 *  выбирает подрядчика в том числе по географии, и «в 14 городах» говорит ему
 *  больше, чем общее количество карточек. */
function buildStats(companyCount, cityCount) {
    const out = [];
    if (companyCount) {
        out.push(`<div class="zr-stat"><b>${companyCount}</b><span>${plural(companyCount, 'предприятие', 'предприятия', 'предприятий')}</span></div>`);
    }
    if (cityCount) {
        out.push(`<div class="zr-stat"><b>${cityCount}</b><span>${plural(cityCount, 'город', 'города', 'городов')}</span></div>`);
    }
    return out.join('\n      ');
}

/** Карточка подрядчика. От карточки на странице услуги отличается одним:
 *  здесь показан город отдельной строкой и без сокращений — на этой странице
 *  выбирают по географии, и прятать её в общую строку фактов нельзя. */
function contractorCard(company) {
    const city = String(company.city || '').trim();
    const line = String(company.specialization || company.products || '').trim().slice(0, 160);
    /* Происхождение карточки — требование ТЗ §11.2. Реестровая догадка и
       заявленная компетенция выглядят одинаково, пока не подписаны, а разница
       между ними для заказчика решающая. */
    const badge = company.verifiedByPlatform
        ? '<span class="zr-badge zr-badge--ok">Проверен платформой</span>'
        : (company.claimed ? '' : '<span class="zr-badge">Реестр Минпромторга</span>');
    return `      <li class="zr-card">
        <a class="zr-card-name" href="/p/${Number(company.id)}">${esc(company.company)}</a>
        ${city ? `<p class="zr-card-line">${esc(city)}</p>` : ''}
        ${badge}
        ${line ? `<p class="zr-card-line">${esc(line)}</p>` : ''}
      </li>`;
}

/** Разбивка по городам со ссылками на геостраницы. Это и есть «слой листингов
 *  над единой сущностью Company» из формулировки 07.09: каталог по теме
 *  пересекается с каталогом по региону, и связь между ними должна быть
 *  проходимой в обе стороны (ТЗ §7.1).
 *
 *  Ссылка ставится только если геостраница существует и индексируется: ссылка
 *  в noindex-контур гоняет робота по мусору, а ссылка в никуда — просто битая. */
function cityBlock(cities) {
    const items = (cities || []).filter(c => c.count > 0).slice(0, CITY_LIMIT);
    if (!items.length) return '';
    const rows = items.map(c => {
        const label = `<span>${esc(c.name)}</span><b>${Number(c.count)}</b>`;
        return c.href
            ? `      <li><a href="${esc(c.href)}">${label}</a></li>`
            : `      <li>${label}</li>`;
    }).join('\n');
    return `    <h2 class="zr-h2">Где находятся</h2>\n    <ul class="zr-cats">\n${rows}\n    </ul>\n`;
}

/**
 * Пустое состояние. То же правило, что в хабе заказов (ТЗ §6.6): не обещать
 * того, чего нет. Каталог без предприятий не пишет «скоро появятся» — он
 * честно говорит, что профилей по теме пока не заполняли, и предлагает
 * действие, которое работает и в этом случае: закупка уходит по базе целиком,
 * а не только по заполненным профилям.
 */
function emptyState(entity) {
    return `    <p class="zr-empty">По этой теме профили предприятий ещё не заполнены. В каталоге они, скорее всего,
      есть — но компетенцию в профиле не указали, и автоматически сопоставить её не с чем.</p>
    <ul class="zr-actions">
      <li><a href="/zayavka">Разместите закупку</a> — она уйдёт профильным производствам по базе целиком,
        а не только по заполненным профилям.</li>
      <li>Вы это делаете? <a href="/login#register">Заполните профиль</a> — предприятие появится здесь.</li>
    </ul>\n`;
}

/**
 * Тело страницы.
 *
 * Формы заказа здесь намеренно нет. Она стоит на /uslugi/ и /izdeliya/, и если
 * поставить её и тут, две страницы станут одинаковыми по смыслу — ровно та
 * каннибализация, ради разделения которой каталог и выносился отдельно
 * (ТЗ §2.2). Отсюда ведёт ссылка на страницу заказа, и это разные действия:
 * «выбрать исполнителя» и «разместить закупку».
 */
function buildBody(entity, companies, cities, related, totalCount) {
    const parts = [];

    if (!companies || !companies.length) {
        parts.push(emptyState(entity));
        return parts.join('\n');
    }

    parts.push(cityBlock(cities));

    const cards = companies.slice(0, LIST_LIMIT).map(contractorCard).join('\n');
    parts.push(`    <h2 class="zr-h2">Предприятия</h2>\n    <ul class="zr-cards">\n${cards}\n    </ul>\n`);

    const shown = Math.min(companies.length, LIST_LIMIT);
    const rest = Math.max(0, Number(totalCount || companies.length) - shown);
    if (rest > 0) {
        parts.push(`    <p class="zr-more">Показаны первые ${shown}. Ещё ${rest} `
            + `${plural(rest, 'предприятие', 'предприятия', 'предприятий')} — в `
            + '<a href="/proizvoditeli">общем каталоге производств</a>.</p>\n');
    }

    // Переход к заказу: разные действия на разных страницах, связь между ними
    // обязательна (ТЗ §7.1).
    if (related && related.href) {
        parts.push(
            '    <h2 class="zr-h2">Не выбирать по одному?</h2>\n'
            + `    <p class="zr-more"><a href="${esc(related.href)}">${esc(related.title)}</a>`
            + ' — разместите чертёж, и предложения придут от нескольких производств сразу.</p>\n'
        );
    }

    return parts.filter(Boolean).join('\n');
}

function buildJsonLd(entity, companies, base) {
    const root = String(base || '').replace(/\/$/, '');
    const shown = (companies || []).slice(0, LIST_LIMIT);
    return JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: buildH1(entity),
        url: `${root}${ROOT}/${entity.slug}`,
        breadcrumb: {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Главная', item: root },
                { '@type': 'ListItem', position: 2, name: 'Подрядчики', item: `${root}${ROOT}` },
                { '@type': 'ListItem', position: 3, name: entity.name },
            ],
        },
        /* Число обязано совпадать с тем, что видно на странице, — иначе это
           недостоверные структурированные данные (ТЗ §10.6). Поэтому здесь
           длина показанного списка, а не общее количество найденных. */
        mainEntity: {
            '@type': 'ItemList',
            numberOfItems: shown.length,
            itemListElement: shown.map((c, i) => ({
                '@type': 'ListItem',
                position: i + 1,
                name: c.company,
                url: `${root}/p/${Number(c.id)}`,
            })),
        },
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

module.exports = {
    ROOT, LIST_LIMIT, CITY_LIMIT,
    supplyRule, meetsSupply, robotsForCatalog, catalogInSitemap,
    buildTitle, buildDescription, buildH1, buildBreadcrumb, buildStats,
    buildBody, buildJsonLd, contractorCard, cityBlock, emptyState,
};
