#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { CATEGORIES } = require('../seo/categories-data');

const ROOT = path.join(__dirname, '..');
const LEGAL_START = '<!-- legal-footer:start -->';
const LEGAL_END = '<!-- legal-footer:end -->';
const BASE = 'https://texzakaz.ru';

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Видимый текст: без script/style/комментариев и тегов. Тем же способом мерился
 *  объём лендинга (578 слов) — иначе цифры в спеке и в тестах разойдутся. */
function pageWordCount(html) {
    const text = String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ');
    return text.split(/\s+/).filter(w => /[а-яА-ЯёЁa-zA-Z0-9]/.test(w)).length;
}

function stripLegalBlock(html) {
    const from = html.indexOf(LEGAL_START);
    const to = html.indexOf(LEGAL_END);
    if (from === -1 || to === -1) return html;
    // preserveLegalBlock всегда добавляет один '\n' сразу после блока при вставке
    // (см. ниже) — забираем его обратно здесь, иначе после вырезания остаётся
    // лишняя пустая строка и strip(вставленная страница) перестаёт совпадать
    // побайтово со страницей, где блока никогда не было (так сравнивает гейт).
    let sliceFrom = to + LEGAL_END.length;
    if (html[sliceFrom] === '\n') sliceFrom += 1;
    return (html.slice(0, from) + html.slice(sliceFrom)).replace(/\n{3,}/g, '\n\n');
}

/** Юридический футер вставляет sync-legal.js. Перезаписывая страницу целиком,
 *  генератор обязан перенести уже стоящий блок, иначе два гейта воюют друг с другом. */
function preserveLegalBlock(oldHtml, newHtml) {
    const from = oldHtml.indexOf(LEGAL_START);
    const to = oldHtml.indexOf(LEGAL_END);
    if (from === -1 || to === -1) return newHtml;
    const block = oldHtml.slice(from, to + LEGAL_END.length);
    const bodyEnd = newHtml.lastIndexOf('</body>');
    if (bodyEnd === -1) return newHtml;
    return newHtml.slice(0, bodyEnd) + block + '\n' + newHtml.slice(bodyEnd);
}

function renderPositions(positions) {
    const rows = positions.map(p => `
        <tr>
          <td>${esc(p.name)}</td>
          <td>${p.gost ? esc(p.gost) : '—'}</td>
          <td>${esc(p.materials)}</td>
        </tr>`).join('');
    return `
      <table class="zc-table">
        <thead><tr><th>Позиция</th><th>Стандарт</th><th>Материалы</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table>`;
}

/** JSON.stringify экранирует только для синтаксиса JSON, не для HTML: буквальные
 *  '<', '>' и '&' в данных (например, "</script>" внутри ответа FAQ) проходят
 *  насквозь и способны преждевременно закрыть <script type="application/ld+json">
 *  или открыть тег внутри него. </>/& — валидные JSON-escape'ы
 *  внутри строкового литерала, поэтому блок остаётся тем же JSON после парсинга,
 *  но больше не может разорвать тег скрипта на HTML-странице. */
function jsonForHtml(data) {
    return JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}

function renderFaqJsonLd(category) {
    return jsonForHtml({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: category.faq.map(item => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
    });
}

function renderCollectionJsonLd(category) {
    return jsonForHtml({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: category.h1,
        description: category.description,
        url: `${BASE}/zakupki/${category.slug}`,
        breadcrumb: {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Главная', item: BASE },
                { '@type': 'ListItem', position: 2, name: 'Закупки', item: `${BASE}/zakupki` },
                { '@type': 'ListItem', position: 3, name: category.shortName },
            ],
        },
    });
}

function renderCategoryPage(category) {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(category.title)}</title>
<meta name="description" content="${esc(category.description)}">
<link rel="canonical" href="${BASE}/zakupki/${category.slug}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE}/zakupki/${category.slug}">
<meta property="og:site_name" content="ТехЗаказ">
<meta property="og:title" content="${esc(category.ogTitle)}">
<meta property="og:description" content="${esc(category.ogDescription)}">
<meta property="og:image" content="${BASE}/landing-hero.png">
<meta property="og:locale" content="ru_RU">
<meta name="robots" content="index, follow">
<script type="application/ld+json">
${renderCollectionJsonLd(category)}
</script>
<script type="application/ld+json">
${renderFaqJsonLd(category)}
</script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/manrope-cyrillic.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/manrope-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/fonts.css">
<script type="text/javascript">(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,'script','https://mc.yandex.ru/metrika/tag.js?id=110221667','ym');ym(110221667,'init',{webvisor:true,clickmap:true,accurateTrackBounce:true,trackLinks:true});</script>
<script type="text/javascript">(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,'script','https://mc.yandex.ru/metrika/tag.js?id=111107983','ym');ym(111107983,'init',{webvisor:true,clickmap:true,accurateTrackBounce:true,trackLinks:true});</script>
<noscript><div><img src="https://mc.yandex.ru/watch/110221667" style="position:absolute;left:-9999px;" alt=""/><img src="https://mc.yandex.ru/watch/111107983" style="position:absolute;left:-9999px;" alt=""/></div></noscript>
<link rel="stylesheet" href="/assets/zakupki-cat.css">
</head>
<body>
<header class="zc-header">
  <a href="/" class="zc-logo">
    <div class="zc-logo-icon"><span>Т</span></div>
    <span class="zc-logo-text">ТЕХЗАКАЗ</span>
  </a>
  <nav class="zc-nav">
    <a href="/zakupki">Все закупки</a>
    <a href="/dlya-postavshchikov">Поставщикам</a>
    <a href="/map">Карта предприятий</a>
  </nav>
  <a href="/login#register" class="zc-cta">Разместить закупку</a>
</header>

<main>
  <section class="zc-hero">
    <div class="zc-breadcrumb">
      <a href="/">Главная</a><span>›</span>
      <a href="/zakupki">Закупки</a><span>›</span>
      <span>${esc(category.shortName)}</span>
    </div>
    <h1 class="zc-h1">${esc(category.h1)}</h1>
    <p class="zc-desc">${esc(category.intro)}</p>
    <div class="zc-tags">
      ${category.tags.map(t => `<span class="zc-tag">${esc(t)}</span>`).join('\n      ')}
    </div>
  </section>

  <section class="zc-content">
    <div class="zc-cats-nav">
      <a href="/zakupki" class="zc-cat-link">Все категории</a>
      ${CATEGORIES.map(c => `<a href="/zakupki/${c.slug}" class="zc-cat-link${c.slug === category.slug ? ' active' : ''}">${esc(c.shortName)}</a>`).join('\n      ')}
    </div>

    <h2 class="zc-h2">Что изготавливают по заказу</h2>
    ${renderPositions(category.positions)}

    <h2 class="zc-h2">Как разместить закупку</h2>
    <ol class="zc-steps">
      ${category.steps.map(s => `<li><strong>${esc(s.title)}.</strong> ${esc(s.text)}</li>`).join('\n      ')}
    </ol>

    <h2 class="zc-h2">Что приложить к заявке</h2>
    <ul class="zc-checklist">
      ${category.checklist.map(item => `<li>${esc(item)}</li>`).join('\n      ')}
    </ul>

    <h2 class="zc-h2">Что влияет на цену и срок</h2>
    <dl class="zc-factors">
      ${category.priceFactors.map(f => `<dt>${esc(f.title)}</dt><dd>${esc(f.text)}</dd>`).join('\n      ')}
    </dl>

    <h2 class="zc-h2">Открытые закупки в категории</h2>
    <div id="orders-grid" class="zc-grid">
      <div class="zc-skeleton"></div><div class="zc-skeleton"></div><div class="zc-skeleton"></div>
    </div>
    <div id="producers-fallback" class="zc-fallback" style="display:none;">
      <p class="zc-fallback-lead" id="producers-fallback-lead">Открытых закупок в категории сейчас нет. Вот предприятия из каталога, которые работают по этому профилю:</p>
      <div id="producers-grid" class="zc-grid"></div>
      <a class="zc-cta-btn" href="/login#register">Разместить закупку</a>
    </div>

    <h2 class="zc-h2">Частые вопросы</h2>
    <div class="zc-faq">
      ${category.faq.map(item => `<details class="zc-faq-item"><summary>${esc(item.q)}</summary><p>${esc(item.a)}</p></details>`).join('\n      ')}
    </div>

    <h2 class="zc-h2">Смотрите также</h2>
    <div class="zc-related">
      ${category.related.map(r => `<a href="${esc(r.href)}">${esc(r.label)}</a>`).join('\n      ')}
      <a href="/zakupki">Все открытые закупки</a>
    </div>
  </section>

  <div class="zc-cta-banner">
    <div>
      <h2>Нужно изготовить по чертежу?</h2>
      <p>Разместите закупку — заявка уйдёт профильным заводам, предложения придут напрямую.</p>
    </div>
    <a href="/login#register" class="zc-cta-btn">Разместить закупку</a>
  </div>
</main>

<script>
var CATEGORY = ${jsonForHtml(category.dbCategory)};
// Страница не тянет общий JS-бандл, поэтому экранирование живёт прямо тут.
// Тем же способом это делают server.js (htmlEscape) и assets/app.js (escapeHtml) —
// данные с /api/public/producers и /api/orders/public не проверены на разметку
// (имя компании задаётся при саморегистрации, заголовок закупки — заказчиком).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderOrders(orders) {
  var grid = document.getElementById('orders-grid');
  grid.innerHTML = orders.map(function (o) {
    return '<article class="zc-card">'
      + '<div class="zc-card-top"><span class="zc-badge">' + escapeHtml(o.category) + '</span><span class="zc-status">Активный</span></div>'
      + '<h3 class="zc-card-title">' + escapeHtml(o.title) + '</h3>'
      + '<div class="zc-card-meta">'
      + (o.deadline ? '<span>Срок: до ' + escapeHtml(new Date(o.deadline).toLocaleDateString('ru-RU')) + '</span>' : '')
      + (o.quantity ? '<span>Кол-во: ' + escapeHtml(o.quantity) + '</span>' : '')
      + '<span>' + escapeHtml(o.responses || 0) + ' предложений</span></div>'
      + '<div class="zc-card-footer"><span class="zc-company">••••••••</span>'
      + '<a href="/login#register" class="zc-respond">Подать КП</a></div>'
      + '</article>';
  }).join('');
}
function showProducers() {
  var grid = document.getElementById('orders-grid');
  var fallback = document.getElementById('producers-fallback');
  var lead = document.getElementById('producers-fallback-lead');
  grid.style.display = 'none';
  fallback.style.display = 'block';
  fetch('/api/public/producers?category=' + encodeURIComponent(CATEGORY) + '&limit=8')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      if (!list.length) { if (lead) lead.style.display = 'none'; return; }
      document.getElementById('producers-grid').innerHTML = list.map(function (p) {
        return '<a class="zc-card zc-card-link" href="/p/' + encodeURIComponent(p.id) + '">'
          + '<h3 class="zc-card-title">' + escapeHtml(p.company) + '</h3>'
          + '<div class="zc-card-meta"><span>' + escapeHtml(p.city || 'город не указан') + '</span>'
          + (p.verified ? '<span class="zc-badge">Проверено</span>' : '') + '</div></a>';
      }).join('');
    })
    .catch(function () { if (lead) lead.style.display = 'none'; });
}
fetch('/api/orders/public?category=' + encodeURIComponent(CATEGORY))
  .then(function (r) { return r.json(); })
  .then(function (orders) { if (!orders.length) { showProducers(); return; } renderOrders(orders); })
  .catch(function () { showProducers(); });
</script>
</body>
</html>
`;
}

function syncAll(root) {
    const changed = [];
    for (const category of CATEGORIES) {
        const file = path.join(root, 'zakupki', `${category.slug}.html`);
        const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const after = preserveLegalBlock(before, renderCategoryPage(category));
        if (after !== before) {
            fs.writeFileSync(file, after, 'utf8');
            changed.push(path.join('zakupki', `${category.slug}.html`));
        }
    }
    return { changed, total: CATEGORIES.length };
}

module.exports = {
    renderCategoryPage, stripLegalBlock, preserveLegalBlock, pageWordCount, syncAll,
    LEGAL_START, LEGAL_END,
};

if (require.main === module) {
    const { changed, total } = syncAll(ROOT);
    console.log(`Category pages synced: ${changed.length} changed of ${total}`);
    changed.forEach(p => console.log('  ' + p));
}
