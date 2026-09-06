'use strict';

// Карточки заводов /p/:id — две трети сайта (4535 адресов в sitemap). Сервер отдавал
// только мета-теги, а профиль дорисовывал JS, поэтому роботу доставалось около 55 слов
// и «Загрузка профиля…». Здесь собирается то же содержимое, но на сервере: факты из
// каталога плюс ссылки на релевантные категории закупок.

const { shortCompanyName } = require('./outreach');
const { CATEGORIES } = require('../seo/categories-data');
const { OPERATIONS, producerHasOperation } = require('../seo/operations-data');

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
/* Индивидуальный предприниматель — это физическое лицо, и его название в
   реестре есть ФИО живого человека. Данные из ЕГРИП открытые, но «открытые» не
   означает «печатаем целиком в заголовке выдачи»: одно дело строка в реестре,
   другое — «Николенко Андрей Фёдорович» в результатах поиска и в разметке
   страницы. Показываем фамилию с инициалами — этого хватает, чтобы человек
   узнал свою карточку и забрал её. */
const SOLE_TRADER_RE = /^(ИП|ИНДИВИДУАЛЬНЫЙ\s+ПРЕДПРИНИМАТЕЛЬ)(\s+|$)/i;

function isSoleTrader(row) {
    return SOLE_TRADER_RE.test(String(row.company || '').trim());
}

function capitalize(word) {
    return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : '';
}

/** «ИП НИКОЛЕНКО АНДРЕЙ ФЁДОРОВИЧ» → «ИП Николенко А. Ф.» */
function soleTraderName(row) {
    const rest = String(row.company || '').trim().replace(SOLE_TRADER_RE, '').split(/\s+/).filter(Boolean);
    if (!rest.length) return 'Индивидуальный предприниматель';
    const [surname, ...names] = rest;
    const initials = names.filter(n => /[А-ЯЁA-Za-zа-яё]/.test(n)).map(n => `${n.charAt(0).toUpperCase()}.`).join(' ');
    return `ИП ${capitalize(surname)}${initials ? ' ' + initials : ''}`;
}

function displayName(row) {
    if (isSoleTrader(row)) return soleTraderName(row);
    const base = shortCompanyName(row.company) || String(row.company || '').trim();
    // shortCompanyName уже опустил длинные капс-слова; всё, что осталось капсом и
    // коротко (ЗЭИМ, НПО, РТИ), — аббревиатура. Проверять вхождение регуляркой нельзя:
    // \b в JS работает по латинице и на кириллице даёт неверный результат.
    return base.split(/\s+/).map((w, i) => {
        if (w.length <= 4 && w === w.toUpperCase() && /[А-ЯЁA-Z]/.test(w)) return w;
        return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.charAt(0).toLowerCase() + w.slice(1);
    }).join(' ');
}

/** Место для заголовка: настоящий город, если он известен, иначе регион.
 *
 *  Реестр ГИСП пишет в `city` регион («Удмуртская Республика»), и это не описка —
 *  по этой колонке группируются региональные страницы, трогать её нельзя.
 *  Настоящий город приезжает отдельной колонкой `town` (scripts/backfill-cities.js).
 *  Для заголовка он ценнее региона: ищут «завод Металлист Глазов», а не «завод
 *  Металлист Удмуртская Республика». Пока town пуст — показываем регион, как раньше. */
function placeOf(row) {
    return String(row.town || row.city || '').trim();
}

const ACTIVITY_MAX = 30;

/** Чем занято предприятие — одним коротким фактом вместо слова «производитель».
 *
 *  Слово «производитель» стояло в заголовке у всех 4500 карточек разом: оно не
 *  отличает завод от завода, и по нему никто не ищет. Берём то, что предприятие
 *  само о себе написало, а если не написало — категорию, которую мы ему вывели
 *  по продукции. Ничего не придумываем: нет ни того, ни другого — остаётся
 *  прежнее слово. */
function activityOf(row, categories = []) {
    const spec = plainFact(row.specialization).split(/[;,.]/)[0].trim();
    const byShortName = new Map(CATEGORIES.map(c => [c.dbCategory, c.shortName]));
    const fromCategory = (categories || []).map(c => byShortName.get(c)).find(Boolean);
    const pick = (spec && spec.length <= ACTIVITY_MAX) ? spec : (fromCategory || '');
    if (!pick || pick.length > ACTIVITY_MAX) return 'производитель';
    // «РТИ» строчными превратилось бы в «рти»: аббревиатуру оставляем как есть.
    return pick === pick.toUpperCase() ? pick : pick.charAt(0).toLowerCase() + pick.slice(1);
}

function shortTitle(row, { categories = [] } = {}) {
    const brandTail = ` | ${BRAND}`;
    const budget = TITLE_MAX - brandTail.length;
    const name = displayName(row);
    const place = placeOf(row);
    const activity = activityOf(row, categories);

    /* Порядок вариантов — по убыванию пользы для брендового запроса. Место
       важнее занятия: «<завод> <город>» люди набирают, «<завод> производитель» —
       почти нет. Поэтому пара «занятие + место» стоит первой, а если она не
       влезла в выдачу, следующим отбрасывается занятие, а не город. */
    const variants = [];
    if (place) variants.push(`${name} — ${activity}, ${place}`, `${name} — ${place}`);
    variants.push(`${name} — ${activity}`, `${name} — производитель`);

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
    // Город, а не регион, по той же причине, что и в заголовке: в описании он
    // подтверждает запрос «<завод> <город>», а «Удмуртская Республика» — нет.
    if (placeOf(row)) parts.push(plainFact(placeOf(row)));
    // Через точку получалось «Резинотехнические изделия. манжеты, кольца» — строчная
    // после точки читается как опечатка. Разделяем факты средней точкой.
    const facts = parts.filter(Boolean).join(' · ');
    const base = facts
        ? `${name}: ${facts}. Разместите закупку по чертежу — предложение придёт напрямую от производителя.`
        : `${name} — профиль производителя на площадке прямых закупок ${BRAND}. Разместите закупку по чертежу и получите предложения напрямую.`;
    return trimAtWord(base, DESC_MAX);
}

/** Полное юридическое наименование — если оно отличается от того, что стоит в H1.
 *
 *  Одно и то же предприятие ищут по-разному: «Глазовский завод Металлист» и
 *  «АО ГЛАЗОВСКИЙ ЗАВОД МЕТАЛЛИСТ». В заголовке правовой форме не место, она
 *  съедает знаки выдачи, но на странице пусть будет: это настоящее имя из
 *  реестра, а не придуманный синоним. Аббревиатуры вроде «ГЗМ» не собираем —
 *  их сочинили бы мы, а не завод. */
function legalName(row) {
    // У предпринимателя «полное наименование» — это его ФИО целиком. Ради
    // синонима в разметке публиковать имя человека мы не станем.
    if (isSoleTrader(row)) return '';
    const full = plainFact(row.company);
    const shown = plainFact(displayName(row));
    if (!full) return '';
    return full.toLowerCase() === shown.toLowerCase() ? '' : full;
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

/** Операции, которые предприятие заявляет о себе, — и ссылки на их страницы.
 *
 *  Зачем это здесь. У Яндекса в поиске 715 наших страниц из 4584: карточка, где
 *  кроме названия и региона ничего нет, для него малоценная, и он прав. Этот
 *  блок собирается из того, что уже лежит в профиле, и добавляет две вещи
 *  сразу: содержание, которого не было, и обычные ссылки в разделы, куда робот
 *  иначе не заходит.
 *
 *  Формулировка «заявляет» — не осторожность ради осторожности. Совпадение
 *  ищется словами по тексту профиля, а не по списку станков: у 4535 карточек
 *  поле оборудования пустое. Написать «выполняет» значило бы утверждать за
 *  завод то, чего он не подтверждал.
 */
function operationsBlock(row) {
    const ops = OPERATIONS.filter(op => producerHasOperation(row, op)).slice(0, 8);
    if (!ops.length) return '';
    const links = ops
        .map(o => `<a class="sp-badge" href="/oborudovanie/${o.slug}">${esc(o.name)}</a>`)
        .join('\n            ');
    return `<div class="sp-card" style="margin-bottom:16px;">
            <h2>Какие работы заявляет</h2>
            <p class="sp-about">Определено по описанию профиля и продукции. Точный перечень работ и предельные размеры подтверждает само предприятие в своём профиле.</p>
            <div class="sp-meta" style="margin-top:10px;">
            ${links}
            </div>
        </div>`;
}

/** Разметка, которую сервер кладёт в карточку до загрузки скриптов.
 *  Тот же состав фактов, что потом отрисует клиент, — не подмена контента для робота. */
function ssrProfileHtml(row, { categories = [] } = {}) {
    const name = displayName(row);
    const products = String(row.products || '').split(';').map(s => s.trim()).filter(Boolean).slice(0, 10);
    const links = categoryLinks(categories);

    /* Город и регион — двумя метками, а не одной. Город отвечает запросу «завод
       в Глазове», регион связывает карточку с региональной страницей; выбрать
       что-то одно значит потерять половину. Пока города нет, метка одна, как было. */
    const badges = [
        row.town ? `<span class="sp-badge">${esc(row.town)}</span>` : '',
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
            ${legalName(row) ? `<p class="sp-about">Полное наименование: ${esc(legalName(row))}</p>` : ''}
            <div class="sp-cta">
            ${claimCta}
            <a class="btn-secondary" style="height:40px;padding:0 20px;" href="/zakupki">Смотреть открытые закупки</a>
            </div>
        </section>
        ${products.length ? `<div class="sp-card" style="margin-bottom:16px;">
            <h2>Что производит${isStub(row) ? ' (по открытым данным)' : ''}</h2>
            <ul class="sp-list">${products.map(p => `<li>${esc(p.length > 120 ? p.slice(0, 120) + '…' : p)}</li>`).join('')}</ul>
        </div>` : ''}
        ${operationsBlock(row)}
        <div class="sp-card" style="margin-bottom:16px;">
            <h2>Как заказать у этого производителя</h2>
            <p class="sp-about">Разместите закупку с чертежом или техническим заданием: площадка уведомит подходящие предприятия, а предложения с ценой и сроком придут напрямую от завода. Сравнение предложений, договор со спецификацией и этапы поставки ведутся в одном месте.</p>
            ${links ? `<div class="sp-meta" style="margin-top:10px;">
            ${links}
            </div>` : ''}
            <p class="sp-about" style="margin-top:10px;">Смотреть остальные предприятия — <a href="/proizvoditeli">каталог производителей</a>.</p>
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
    /* Город — в addressLocality, регион — в addressRegion. Пока города нет,
       в locality уезжает регион: это ровно то, что мы про предприятие знаем,
       и обещать разметкой более точный адрес, чем есть, нельзя. */
    if (row.town || row.city) {
        org.address = { '@type': 'PostalAddress', addressCountry: 'RU' };
        org.address.addressLocality = plainFact(row.town || row.city);
        if (row.town && row.city) org.address.addressRegion = plainFact(row.city);
    }
    if (legalName(row)) org.alternateName = legalName(row);
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
