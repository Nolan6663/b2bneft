'use strict';

/* Постраничный каталог предприятий — /proizvoditeli.
 *
 * Зачем он появился. В Яндексе в поиске 715 страниц при 4584 в карте сайта, и
 * при этом в «Исключённых» нет ни одной карточки: робот их не забраковал, он до
 * них не дошёл. Причина нашлась подсчётом ссылок в серверном HTML: на главной
 * ноль ссылок на карточки, на карте ноль (весь список рисует JavaScript), на
 * региональной странице и на странице операции — по шестьдесят. То есть по
 * обычным ссылкам достижимо около полутора тысяч адресов из 4531, а остальные
 * три тысячи заявлены только картой сайта. Для Яндекса карта сайта — заявка, а
 * не рекомендация: он ходит по ссылкам.
 *
 * Отсюда устройство: простой список, сто предприятий на страницу, обычные
 * ссылки, постраничная навигация без параметров в адресе. Никакой ленты с
 * догрузкой — она нужна человеку, а не роботу, и до сих пор именно она держала
 * три тысячи карточек в невидимости.
 *
 * Порядок — по алфавиту и по id. Он обязан быть устойчивым: если список
 * пересортировать при каждом заходе, страница 7 будет каждый раз другой, и
 * робот получит вместо каталога кашу.
 */

const PAGE_SIZE = 100;
const BRAND = 'ТехЗаказ';
const ROOT = '/proizvoditeli';

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

/** В каталог идут те же предприятия, что и в карту сайта: у карточки должен быть
 *  хоть один факт кроме названия. Списки и карта сайта обязаны совпадать —
 *  иначе мы зовём робота туда, куда сами ссылки не ставим. */
function isListable(p) {
    return Boolean(
        String(p.products || '').trim() ||
        String(p.specialization || '').trim() ||
        String(p.about || '').trim()
    );
}

/** Устойчивый порядок: сначала по названию, при совпадении — по id. */
function sortForCatalog(list) {
    return [...list].sort((a, b) =>
        String(a.company || '').localeCompare(String(b.company || ''), 'ru') || (a.id - b.id));
}

function pageCount(total) {
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function pageUrl(page) {
    // Первая страница живёт по корню: /proizvoditeli/1 — это тот же список под
    // вторым адресом, то есть дубль, который потом придётся склеивать.
    return page <= 1 ? ROOT : `${ROOT}/${page}`;
}

function buildTitle(page, total) {
    const tail = ` | ${BRAND}`;
    const head = page > 1
        ? `Производители России — страница ${page}`
        : `Каталог производителей России: ${total} предприятий`;
    return head.length + tail.length <= 65 ? head + tail : `Производители России${page > 1 ? `, страница ${page}` : ''}${tail}`;
}

function buildDescription(page, total, pages) {
    return page > 1
        ? `Список предприятий каталога ТехЗаказ, страница ${page} из ${pages}. Профиль, продукция, регион и признак проверки у каждого производителя.`
        : `${total} ${plural(total, 'предприятие', 'предприятия', 'предприятий')} из реестра Минпромторга и профилей площадки: продукция, регион, направление работы. Разместите закупку по чертежу — предложения придут напрямую от заводов.`;
}

function buildCards(producers) {
    return producers.map(p => {
        const line = String(p.specialization || p.products || '').trim().slice(0, 160);
        const badge = p.verifiedByPlatform || p.verified_by_platform
            ? '<span class="zr-badge zr-badge--ok">Проверен платформой</span>'
            : (p.claimed ? '' : '<span class="zr-badge">Реестр Минпромторга</span>');
        const place = String(p.town || p.city || '').trim();
        return `      <li class="zr-card">
        <a class="zr-card-name" href="/p/${Number(p.id)}">${esc(p.company)}</a>
        ${badge}
        ${place ? `<p class="zr-card-line">${esc(place)}</p>` : ''}
        ${line ? `<p class="zr-card-line">${esc(line)}</p>` : ''}
      </li>`;
    }).join('\n');
}

/** Постраничная навигация обычными ссылками.
 *
 *  Соседние страницы стоят рядом, первая и последняя — всегда: так от любой
 *  страницы до любой другой не больше двух переходов, и робот не обязан идти
 *  сорок шесть раз подряд, чтобы добраться до конца каталога. */
function buildPager(page, pages) {
    if (pages <= 1) return '';
    const near = new Set([1, pages, page - 1, page, page + 1, 2, pages - 1]);
    const items = [];
    let previous = 0;
    for (const n of [...near].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b)) {
        if (previous && n - previous > 1) items.push('<span class="zr-pager-gap">…</span>');
        items.push(n === page
            ? `<span class="zr-pager-current" aria-current="page">${n}</span>`
            : `<a class="zr-pager-link" href="${pageUrl(n)}">${n}</a>`);
        previous = n;
    }
    const prev = page > 1 ? `<a class="zr-pager-link" rel="prev" href="${pageUrl(page - 1)}">← Назад</a>` : '';
    const next = page < pages ? `<a class="zr-pager-link" rel="next" href="${pageUrl(page + 1)}">Вперёд →</a>` : '';
    return `<nav class="zr-pager" aria-label="Страницы каталога">\n      ${prev}\n      ${items.join('\n      ')}\n      ${next}\n    </nav>`;
}

/** ItemList — то, что на странице действительно показано, и ровно в том порядке.
 *  Разметка, обещающая больше видимого, — повод для санкции, а не для сниппета. */
function buildJsonLd(producers, { page, pages, base }) {
    const url = `${base}${pageUrl(page)}`;
    const list = {
        '@type': 'ItemList',
        '@id': `${url}#list`,
        numberOfItems: producers.length,
        itemListElement: producers.slice(0, 100).map((p, i) => ({
            '@type': 'ListItem',
            position: (page - 1) * PAGE_SIZE + i + 1,
            url: `${base}/p/${Number(p.id)}`,
            name: String(p.company || '').slice(0, 200),
        })),
    };
    const crumbs = {
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Главная', item: base },
            { '@type': 'ListItem', position: 2, name: 'Производители', item: `${base}${ROOT}` },
            ...(page > 1 ? [{ '@type': 'ListItem', position: 3, name: `Страница ${page} из ${pages}` }] : []),
        ],
    };
    return JSON.stringify({ '@context': 'https://schema.org', '@graph': [list, crumbs] })
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

module.exports = {
    PAGE_SIZE, ROOT,
    isListable, sortForCatalog, pageCount, pageUrl,
    buildTitle, buildDescription, buildCards, buildPager, buildJsonLd, esc, plural,
};
