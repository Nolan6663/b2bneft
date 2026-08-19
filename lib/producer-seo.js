'use strict';

// Карточки заводов /p/:id — две трети сайта (4535 адресов в sitemap). Сервер отдавал
// только мета-теги, а профиль дорисовывал JS, поэтому роботу доставалось около 55 слов
// и «Загрузка профиля…». Здесь собирается то же содержимое, но на сервере: факты из
// каталога плюс ссылки на релевантные категории закупок.

const { shortCompanyName } = require('./outreach');
const { CATEGORIES } = require('../seo/categories-data');

const TITLE_MAX = 65;
const DESC_MAX = 160;
const BRAND = 'ТехЗаказ';

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Обрезка по границе слова: «…фабрика техничес» в выдаче выглядит как ошибка. */
function trimAtWord(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.—-]+$/, '');
}

function isStub(row) {
    return !row.claimed && !!row.source;
}

function fromGisp(row) {
    return !row.claimed && row.source === 'gisp-pp719';
}

/** «АО "КУРСКАЯ ФАБРИКА ТЕХНИЧЕСКИХ ТКАНЕЙ"» → «Курская фабрика технических тканей».
 *  shortCompanyName снимает правовую форму и капс, но поднимает каждое слово в
 *  заглавную — для заголовка это читается как ошибка, поэтому оставляем заглавной
 *  только первую, а короткие капс-слова (РТИ, НПО, ЗЭИМ) считаем аббревиатурами. */
function displayName(row) {
    const base = shortCompanyName(row.company) || String(row.company || '').trim();
    // shortCompanyName уже опустил длинные капс-слова; всё, что осталось капсом и
    // коротко (ЗЭИМ, НПО, РТИ), — аббревиатура. Проверять вхождение регуляркой нельзя:
    // \b в JS работает по латинице и на кириллице даёт неверный результат.
    return base.split(/\s+/).map((w, i) => {
        if (w.length <= 4 && w === w.toUpperCase() && /[А-ЯЁA-Z]/.test(w)) return w;
        return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.charAt(0).toLowerCase() + w.slice(1);
    }).join(' ');
}

function shortTitle(row) {
    const brandTail = ` | ${BRAND}`;
    const budget = TITLE_MAX - brandTail.length;
    const name = displayName(row);
    const city = String(row.city || '').trim();

    // Город важнее слова «производитель»: по «<завод> <город>» ищут, по слову — нет.
    const variants = city
        ? [`${name} — производитель, ${city}`, `${name} — ${city}`, `${name} — производитель`]
        : [`${name} — производитель`];
    const fits = variants.find(v => v.length <= budget);
    return (fits || trimAtWord(variants[variants.length - 1], budget)) + brandTail;
}

/** Кавычки и амперсанды в мета-теге разворачиваются в &quot; и &amp;: 160 знаков
 *  исходного текста превращались в 181 в готовой странице. Убираем их до сборки. */
function plainFact(value) {
    return String(value || '').replace(/["«»&<>]/g, '').replace(/\s+/g, ' ').trim();
}

function metaDescription(row) {
    const name = plainFact(displayName(row));
    const parts = [];
    if (row.specialization) parts.push(plainFact(row.specialization));
    if (row.products) parts.push(plainFact(row.products).split(';').map(s => s.trim()).filter(Boolean).slice(0, 4).join(', '));
    if (row.city) parts.push(plainFact(row.city));
    // Через точку получалось «Резинотехнические изделия. манжеты, кольца» — строчная
    // после точки читается как опечатка. Разделяем факты средней точкой.
    const facts = parts.filter(Boolean).join(' · ');
    const base = facts
        ? `${name}: ${facts}. Разместите закупку по чертежу — предложение придёт напрямую от производителя.`
        : `${name} — профиль производителя на площадке прямых закупок ${BRAND}. Разместите закупку по чертежу и получите предложения напрямую.`;
    return trimAtWord(base, DESC_MAX);
}

function categoryLinks(categories) {
    const bySlug = new Map(CATEGORIES.map(c => [c.dbCategory, c]));
    return (categories || [])
        .map(name => bySlug.get(name))
        .filter(Boolean)
        .map(c => `<a class="sp-badge" href="/zakupki/${c.slug}">Закупки: ${esc(c.shortName)}</a>`)
        .join('\n            ');
}

function aboutText(row) {
    if (row.about) return esc(row.about);
    if (fromGisp(row)) {
        return 'Российский производитель промышленной продукции из государственного реестра Минпромторга (постановление № 719). Профиль создан по открытым данным: предприятие может присоединить его и отвечать на заказы напрямую, без посредников.';
    }
    if (isStub(row)) {
        return 'Российский производитель. Профиль создан по открытым данным: предприятие может присоединить его и отвечать на заказы напрямую.';
    }
    return `Поставщик на площадке прямых закупок ${BRAND}. Отвечает на закупки заказчиков напрямую, без тендерных площадок и посредников.`;
}

/** Разметка, которую сервер кладёт в карточку до загрузки скриптов.
 *  Тот же состав фактов, что потом отрисует клиент, — не подмена контента для робота. */
function ssrProfileHtml(row, { categories = [] } = {}) {
    const name = displayName(row);
    const products = String(row.products || '').split(';').map(s => s.trim()).filter(Boolean).slice(0, 10);
    const links = categoryLinks(categories);

    const badges = [
        row.city ? `<span class="sp-badge">${esc(row.city)}</span>` : '',
        row.specialization ? `<span class="sp-badge">${esc(row.specialization)}</span>` : '',
        row.verified_by_platform ? '<span class="sp-badge verified">✓ Проверен ТехЗаказ</span>' : '',
        fromGisp(row) ? '<span class="sp-badge verified">Реестр Минпромторга ПП-719</span>' : '',
        row.inn ? `<span class="sp-badge">ИНН ${esc(row.inn)}</span>` : '',
    ].filter(Boolean).join('\n            ');

    const claimCta = isStub(row)
        ? `<a class="btn-primary" style="height:40px;padding:0 20px;" href="/login.html#register?claim=${encodeURIComponent(row.inn || '')}&amp;company=${encodeURIComponent(row.company || '')}">Это ваша компания? Присоединить профиль</a>`
        : '';

    return `<section class="sp-hero">
            <h1>${esc(name)}</h1>
            <div class="sp-meta">
            ${badges}
            </div>
            <p class="sp-about">${aboutText(row)}</p>
            <div class="sp-cta">
            ${claimCta}
            <a class="btn-secondary" style="height:40px;padding:0 20px;" href="/zakupki">Смотреть открытые закупки</a>
            </div>
        </section>
        ${products.length ? `<div class="sp-card" style="margin-bottom:16px;">
            <h2>Что производит${isStub(row) ? ' (по открытым данным)' : ''}</h2>
            <ul class="sp-list">${products.map(p => `<li>${esc(p.length > 120 ? p.slice(0, 120) + '…' : p)}</li>`).join('')}</ul>
        </div>` : ''}
        <div class="sp-card" style="margin-bottom:16px;">
            <h2>Как заказать у этого производителя</h2>
            <p class="sp-about">Разместите закупку с чертежом или техническим заданием: площадка уведомит подходящие предприятия, а предложения с ценой и сроком придут напрямую от завода. Сравнение предложений, договор со спецификацией и этапы поставки ведутся в одном месте.</p>
            ${links ? `<div class="sp-meta" style="margin-top:10px;">
            ${links}
            </div>` : ''}
        </div>`;
}

/** JSON.stringify экранирует для JSON, но не для HTML: буквальные '<', '>' и '&'
 *  из названия компании прошли бы насквозь и могли закрыть тег скрипта раньше
 *  времени. < и родня — валидный JSON внутри строки, поэтому данные те же,
 *  а разорвать страницу больше нечем. Тот же приём в scripts/sync-category-pages. */
function jsonForHtml(data) {
    return JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}

/** Разметка карточки завода: Organization и хлебные крошки.
 *
 *  Две трети сайта — это /p/:id, и до сих пор они были единственным разделом
 *  вообще без структурированных данных: у категорий есть CollectionPage и FAQ,
 *  у регионов — свой блок, а у 4530 карточек не было ничего. Поисковику
 *  приходилось угадывать по тексту, что это предприятие, где оно и чем занято.
 *
 *  Кладём только то, что знаем из каталога. Ни рейтингов, ни телефонов, ни
 *  логотипов: разметка, обещающая факты, которых нет на странице, — прямой
 *  повод для санкции, а не для сниппета. По той же причине ИНН идёт как taxID,
 *  а не как «проверенная» регалия: это просто номер из реестра. */
function buildProducerJsonLd(row, { id, base }) {
    const url = `${base}/p/${id}`;
    const name = displayName(row);
    const products = String(row.products || '').split(';').map(v => v.trim()).filter(Boolean).slice(0, 10);

    const org = {
        '@type': 'Organization',
        '@id': `${url}#organization`,
        name,
        url,
        description: trimAtWord(plainFact(row.about || row.specialization || `${name} — производитель`), 300),
    };
    if (row.city) org.address = { '@type': 'PostalAddress', addressLocality: plainFact(row.city), addressCountry: 'RU' };
    if (row.inn) org.taxID = String(row.inn).trim();
    if (products.length) org.knowsAbout = products.map(plainFact);
    // Реестр Минпромторга — единственная внешняя ссылка, которой мы вправе
    // подтвердить существование предприятия: профиль собран по его данным.
    if (fromGisp(row)) org.identifier = { '@type': 'PropertyValue', name: 'Реестр Минпромторга (ПП-719)', value: String(row.inn || '').trim() || name };

    const crumbs = {
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Главная', item: base },
            { '@type': 'ListItem', position: 2, name: 'Производители', item: `${base}/map` },
            { '@type': 'ListItem', position: 3, name },
        ],
    };

    return jsonForHtml({ '@context': 'https://schema.org', '@graph': [org, crumbs] });
}

/** Карточка без единого факта, кроме названия, — тонкая страница. Таких в каталоге
 *  немного, но 4535 адресов в sitemap: пара сотен пустышек тянет вниз весь домен.
 *  Закрываем их от индексации, оставляя обход ссылок. */
function robotsDirective(row) {
    const hasSubstance = Boolean(
        String(row.products || '').trim() ||
        String(row.specialization || '').trim() ||
        String(row.about || '').trim()
    );
    return hasSubstance ? 'index, follow' : 'noindex, follow';
}

module.exports = { shortTitle, metaDescription, ssrProfileHtml, robotsDirective, buildProducerJsonLd, displayName, trimAtWord };
