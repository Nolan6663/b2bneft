'use strict';

const { regionLabel } = require('../seo/regions-data');

/** Ниже этого числа предприятий страница региона — пустая витрина: робота не зовём. */
const MIN_INDEXABLE = 5;

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Склонение числа: 1 предприятие, 2 предприятия, 5 предприятий. */
function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

/** 60 знаков — предел, после которого выдача обрезает заголовок многоточием.
 *  Длинные названия («в Нижегородской области») выносили title на 65, и первым
 *  под нож шло не имя бренда, а число предприятий в конце — то есть ровно то,
 *  ради чего человек кликает. Поэтому жертвуем брендом: поисковик и так
 *  подставит имя сайта рядом со ссылкой. */
function buildRegionTitle(region, total) {
    const head = `Производители ${region.where}: ${total} ${plural(total, 'предприятие', 'предприятия', 'предприятий')}`;
    const withBrand = `${head} — ТехЗаказ`;
    return withBrand.length <= 60 ? withBrand : head;
}

function buildRegionDescription(region, stats) {
    const total = stats.total || 0;
    // Названия направлений не приводим к нижнему регистру: «РТИ» — аббревиатура,
    // «рти» в выдаче читается как опечатка.
    const top = (stats.categories || []).filter(([name]) => name !== 'Прочее').slice(0, 3).map(([name]) => name);
    const what = top.length ? `${top.join(', ')} и другие направления` : 'изготовление по чертежу заказчика';
    const base = `Каталог производств ${region.where}: ${total} ${plural(total, 'предприятие', 'предприятия', 'предприятий')}, ${what}. Разместите закупку — ответят напрямую.`;
    return base.length <= 160 ? base : base.slice(0, 157).replace(/[\s,.]+$/, '') + '…';
}

function buildRegionRobots(total) {
    return total >= MIN_INDEXABLE ? 'index, follow' : 'noindex, follow';
}

/** Карточки предприятий + разбивка по направлениям. Всё, что пришло из базы, экранируется. */
function buildRegionSsr(region, producers, stats) {
    const cards = producers.map(p => {
        const line = String(p.specialization || p.products || '').trim().slice(0, 160);
        const badge = p.verifiedByPlatform
            ? '<span class="zr-badge zr-badge--ok">Проверен платформой</span>'
            : (p.claimed ? '' : '<span class="zr-badge">Реестр Минпромторга</span>');
        return `      <li class="zr-card">
        <a class="zr-card-name" href="/p/${Number(p.id)}">${esc(p.company)}</a>
        ${badge}
        ${line ? `<p class="zr-card-line">${esc(line)}</p>` : ''}
      </li>`;
    }).join('\n');

    const cats = (stats.categories || []).filter(([, n]) => n > 0).map(([name, n]) =>
        `      <li><span>${esc(name)}</span><b>${Number(n)}</b></li>`
    ).join('\n');

    const catsBlock = cats
        ? `    <h2 class="zr-h2">Направления ${region.where}</h2>\n    <ul class="zr-cats">\n${cats}\n    </ul>\n`
        : '';

    const cardsBlock = cards
        ? `    <h2 class="zr-h2">Предприятия в каталоге</h2>\n    <ul class="zr-cards">\n${cards}\n    </ul>\n`
        : `    <p class="zr-empty">По этому региону профили ещё собираются. Разместите закупку — она уйдёт профильным заводам по всей стране.</p>\n`;

    return `${catsBlock}${cardsBlock}`;
}

function buildRegionJsonLd(region, stats, base) {
    const url = `${String(base).replace(/\/$/, '')}/zakupki/region/${region.slug}`;
    const label = regionLabel(region);
    return JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `Производители ${region.where}`,
        url,
        breadcrumb: {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Главная', item: String(base).replace(/\/$/, '') },
                { '@type': 'ListItem', position: 2, name: 'Закупки', item: `${String(base).replace(/\/$/, '')}/zakupki` },
                { '@type': 'ListItem', position: 3, name: label },
            ],
        },
        mainEntity: {
            '@type': 'ItemList',
            numberOfItems: stats.total || 0,
            itemListOrder: 'https://schema.org/ItemListOrderDescending',
        },
    });
}

module.exports = {
    MIN_INDEXABLE,
    buildRegionTitle,
    buildRegionDescription,
    buildRegionRobots,
    buildRegionSsr,
    buildRegionJsonLd,
    esc,
    plural,
};
