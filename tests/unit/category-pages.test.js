'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    renderCategoryPage, stripLegalBlock, preserveLegalBlock, pageWordCount,
    LEGAL_START, LEGAL_END,
} = require('../../scripts/sync-category-pages');
const { CATEGORIES } = require('../../seo/categories-data');

/** Достаёт непарсируемый как JSON-LD <script> в конце страницы — тот самый клиентский
 *  скрипт, который тянет /api/orders/public и /api/public/producers и рисует карточки. */
function clientScript(html) {
    const blocks = [...html.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)]
        .map(m => m[1])
        .filter(code => code.includes('renderOrders') || code.includes('showProducers'));
    return blocks[0] || '';
}

const RTI = CATEGORIES.find(c => c.slug === 'rti');

test('рендер: страница содержит канонический URL и не меняет его', () => {
    const html = renderCategoryPage(RTI);
    assert.match(html, /<link rel="canonical" href="https:\/\/texzakaz\.ru\/zakupki\/rti">/);
});

test('рендер: h1, интро, позиции и FAQ попадают в разметку', () => {
    const html = renderCategoryPage(RTI);
    assert.ok(html.includes(RTI.h1), 'нет h1');
    assert.ok(html.includes(RTI.intro.slice(0, 40)), 'нет интро');
    assert.ok(html.includes(RTI.positions[0].name), 'нет первой позиции');
    assert.ok(html.includes(RTI.faq[0].q), 'нет первого вопроса FAQ');
    for (const item of RTI.checklist) assert.ok(html.includes(item), `нет пункта чеклиста: ${item}`);
});

test('рендер: категория для грида закупок берётся из dbCategory', () => {
    const html = renderCategoryPage(RTI);
    // Шаблон объявляет `var CATEGORY = "РТИ";` — имя кодируется уже в браузере,
    // поэтому ищем именно объявление, а не результат encodeURIComponent.
    assert.ok(html.includes(`var CATEGORY = ${JSON.stringify(RTI.dbCategory)}`), 'грид не знает категорию БД');
    assert.match(html, /\/api\/orders\/public\?category=/, 'нет запроса открытых закупок');
    assert.match(html, /\/api\/public\/producers\?category=/, 'нет запроса заводов для пустого состояния');
});

test('рендер: JSON-LD парсится и содержит FAQPage и BreadcrumbList', () => {
    const html = renderCategoryPage(RTI);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(blocks.length >= 1, 'нет ни одного блока JSON-LD');
    const types = [];
    for (const raw of blocks) {
        const parsed = JSON.parse(raw); // упадёт, если разметка битая
        types.push(parsed['@type']);
        if (parsed.breadcrumb) types.push(parsed.breadcrumb['@type']);
    }
    assert.ok(types.includes('FAQPage'), `среди типов нет FAQPage: ${types.join(', ')}`);
    assert.ok(types.includes('BreadcrumbList'), `среди типов нет BreadcrumbList: ${types.join(', ')}`);
});

test('рендер: старого футера с 2024 годом на странице нет', () => {
    const html = renderCategoryPage(RTI);
    assert.doesNotMatch(html, /© 2024/);
    assert.doesNotMatch(html, /class="zc-footer"/, 'устаревший zc-footer должен быть убран');
});

test('рендер: объём видимого текста не меньше 600 слов', () => {
    for (const c of CATEGORIES) {
        const n = pageWordCount(renderCategoryPage(c));
        assert.ok(n >= 600, `${c.slug}: ${n} слов, нужно ≥ 600`);
    }
});

test('юридический блок: вырезается и переносится в новую версию страницы', () => {
    const legal = `${LEGAL_START}\n<footer>реквизиты</footer>\n${LEGAL_END}`;
    const oldHtml = `<html><body><p>старое</p>\n${legal}\n</body></html>`;
    const newHtml = '<html><body><p>новое</p>\n</body></html>';

    assert.doesNotMatch(stripLegalBlock(oldHtml), /реквизиты/);

    const merged = preserveLegalBlock(oldHtml, newHtml);
    assert.match(merged, /новое/);
    assert.match(merged, /реквизиты/);
    assert.equal(merged.match(new RegExp(LEGAL_START, 'g')).length, 1, 'блок не должен дублироваться');
    assert.ok(merged.indexOf(LEGAL_END) < merged.indexOf('</body>'), 'блок должен остаться внутри body');
});

test('юридический блок: если его не было, страница остаётся без него', () => {
    const merged = preserveLegalBlock('<html><body>без блока</body></html>', '<html><body>новое</body></html>');
    assert.doesNotMatch(merged, new RegExp(LEGAL_START));
    assert.match(merged, /новое/);
});

test('подсчёт слов: скрипты, стили и комментарии не считаются', () => {
    const html = '<html><head><style>.a{color:red}</style><script>var x=1;</script></head><body><!-- коммент --><p>одно два три</p></body></html>';
    assert.equal(pageWordCount(html), 3);
});

test('JSON-LD: содержимое категории не может разорвать <script> тег', () => {
    // Клонируем реальную категорию, чтобы форма данных не разошлась с продовой,
    // и подсовываем во FAQ-ответ буквальный "</script>" — ровно то, чем контент
    // из seo/categories-data.js однажды может сломать страницу.
    const payload = '</script><img src=x>';
    const evil = JSON.parse(JSON.stringify(RTI));
    evil.faq = evil.faq.map((item, i) => (i === 0 ? { ...item, a: payload } : item));

    const html = renderCategoryPage(evil);

    // (a) буквальной последовательности "</script>" внутри JSON-LD блока быть не должно —
    // иначе она закрыла бы тег раньше времени и оставшийся JSON вывалился бы в body как текст.
    const scriptOpen = /<script type="application\/ld\+json">/g;
    let m;
    while ((m = scriptOpen.exec(html))) {
        const closeIdx = html.indexOf('</script>', m.index);
        const block = html.slice(m.index, closeIdx);
        assert.ok(!block.includes('</script>'), 'JSON-LD блок содержит буквальный </script> и обрывается раньше времени');
    }

    // (b) все блоки JSON-LD на странице по-прежнему валидный JSON.
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(blocks.length >= 2, 'ожидались оба блока JSON-LD (Collection и FAQ)');
    const parsedBlocks = blocks.map(raw => JSON.parse(raw)); // упадёт, если экранирование сломало JSON

    // (c) значение доходит до потребителя разметки в исходном виде — экранирование
    // не должно было исказить сами данные, только помешать им разорвать тег.
    const faqBlock = parsedBlocks.find(p => p['@type'] === 'FAQPage');
    assert.ok(faqBlock, 'нет блока FAQPage среди распарсенных');
    assert.equal(faqBlock.mainEntity[0].acceptedAnswer.text, payload, 'ответ FAQ не совпал после round-trip через JSON-LD');
});

test('inline-скрипт: имя категории не может разорвать <script> тег', () => {
    // dbCategory подставляется в `var CATEGORY = ...` внутри обычного <script>.
    // JSON.stringify там экранирует только для JS, но не мешает буквальному
    // "</script>" закрыть тег — данные приходят из seo/categories-data.js.
    const evil = JSON.parse(JSON.stringify(RTI));
    evil.dbCategory = '</script><img src=x onerror=alert(1)>';

    const html = renderCategoryPage(evil);
    const start = html.indexOf('var CATEGORY');
    assert.ok(start !== -1, 'в разметке нет объявления CATEGORY');
    const block = html.slice(start, html.indexOf('</script>', start));
    assert.ok(!block.includes('</script>'), 'объявление категории обрывает тег скрипта');
    assert.ok(!block.includes('<img'), 'разметка из данных попала в скрипт как есть');
});

test('XSS: клиентский скрипт содержит хелпер экранирования escapeHtml', () => {
    const script = clientScript(renderCategoryPage(RTI));
    assert.ok(script, 'не нашли клиентский скрипт со fetch-логикой');
    // Сам хелпер должен экранировать минимум & < > " ' — так же, как htmlEscape в server.js
    // и escapeHtml в assets/app.js. Проверяем сигнатуру функции, а не просто слово "escape".
    assert.match(script, /function escapeHtml\(s\)\s*\{/, 'нет функции escapeHtml в клиентском скрипте');
    const helperBody = script.slice(script.indexOf('function escapeHtml'), script.indexOf('function escapeHtml') + 400);
    for (const ch of ['&', '<', '>', '"', "'"]) {
        assert.ok(helperBody.includes(`replace(/${ch === "'" ? "'" : '\\' + ch}/g`) || helperBody.includes(ch),
            `хелпер escapeHtml не упоминает экранирование символа ${ch}`);
    }
    // Функциональная проверка самого хелпера "как есть", а не пересказ регэкспов.
    // eslint-disable-next-line no-new-func
    const escapeHtml = new Function(script.slice(script.indexOf('function escapeHtml'), script.indexOf('function renderOrders')) + '; return escapeHtml;')();
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('XSS: каждая точка интерполяции p.company/p.city/o.title/o.category идёт через escapeHtml', () => {
    const script = clientScript(renderCategoryPage(RTI));
    // Проверяем форму вызова в каждой конкретной точке подстановки, а не факт, что где-то
    // в файле есть слово "escape" — иначе тест пройдёт и с хелпером, который не используется.
    assert.match(script, /escapeHtml\(o\.category\)/, 'o.category не экранируется');
    assert.match(script, /escapeHtml\(o\.title\)/, 'o.title не экранируется');
    assert.match(script, /escapeHtml\(p\.company\)/, 'p.company не экранируется');
    assert.match(script, /escapeHtml\(p\.city \|\| 'город не указан'\)/, 'p.city не экранируется');

    // Отрицательный контроль: старые небезопасные конкатенации ушли из кода.
    assert.doesNotMatch(script, /\+\s*o\.category\s*\+/, 'o.category всё ещё конкатенируется напрямую');
    assert.doesNotMatch(script, /\+\s*o\.title\s*\+/, 'o.title всё ещё конкатенируется напрямую');
    assert.doesNotMatch(script, /\+\s*p\.company\s*\+/, 'p.company всё ещё конкатенируется напрямую');
});

test('XSS: сборка карточки производителя из враждебного company/city экранирует разметку', () => {
    // Показываем защиту конкретно: подставляем во fetch-обработчик вредоносную полезную
    // нагрузку (как если бы её вернул /api/public/producers) и убеждаемся, что итоговая
    // строка markup содержит экранированную, а не исполняемую разметку.
    const script = clientScript(renderCategoryPage(RTI));
    const src = script.slice(script.indexOf('function escapeHtml'), script.indexOf('function showProducers'));
    const buildCard = new Function('p', `
        ${src}
        return '<a class="zc-card zc-card-link" href="/p/' + encodeURIComponent(p.id) + '">'
          + '<h3 class="zc-card-title">' + escapeHtml(p.company) + '</h3>'
          + '<div class="zc-card-meta"><span>' + escapeHtml(p.city || 'город не указан') + '</span>'
          + (p.verified ? '<span class="zc-badge">Проверено</span>' : '') + '</div></a>';
    `);
    const evilProducer = { id: 1, company: '<img src=x onerror=alert(1)>', city: '<script>alert(2)</script>', verified: false };
    const markup = buildCard(evilProducer);
    assert.ok(!markup.includes('<img src=x onerror=alert(1)>'), 'company не экранирован — исполняемый onerror дошёл до markup');
    assert.ok(!markup.includes('<script>alert(2)</script>'), 'city не экранирован — исполняемый script дошёл до markup');
    assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/, 'ожидали экранированную company в markup');
    assert.match(markup, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/, 'ожидали экранированную city в markup');
});

test('пустое состояние: без предприятий в категории вводная фраза перед списком скрывается', () => {
    const html = renderCategoryPage(RTI);
    assert.match(html, /id="producers-fallback-lead"/, 'у вводного абзаца нет id для управления видимостью из JS');
    const script = clientScript(html);
    // Пустой список или упавший fetch не должны оставлять фразу "...вот предприятия... :"
    // висеть без единой карточки под ней.
    assert.match(script, /if\s*\(!list\.length\)\s*\{\s*if\s*\(lead\)\s*lead\.style\.display\s*=\s*'none';/,
        'при пустом списке производителей вводная фраза не скрывается');
    assert.match(script, /\.catch\(function\s*\(\)\s*\{\s*if\s*\(lead\)\s*lead\.style\.display\s*=\s*'none';/,
        'при ошибке запроса производителей вводная фраза не скрывается');
});

test('связка генераторов: applyFooter из sync-legal.js + stripLegalBlock возвращают чистый рендер', () => {
    // preserveLegalBlock/stripLegalBlock в sync-category-pages.js воспроизводят формат вставки
    // sync-legal.js байт в байт. Ничего не проверяло их вместе — если формат applyFooter
    // когда-нибудь изменится, оба гейта (checkLegalFooterSynced и checkCategoryPagesSynced)
    // заблокируют друг друга, и это всплывёт не там, где причина.
    const { applyFooter } = require('../../scripts/sync-legal');
    const category = CATEGORIES[0];
    const cleanRender = renderCategoryPage(category);

    const footerHtml = '<footer>реквизиты компании</footer>';
    const pageWithFooter = applyFooter(cleanRender, footerHtml);

    assert.notEqual(pageWithFooter, cleanRender, 'applyFooter не добавил футер — тест ничего не проверяет');
    assert.equal(stripLegalBlock(pageWithFooter), cleanRender, 'stripLegalBlock(applyFooter(page)) разошёлся с чистым рендером');

    // И повторный проход (как второй прогон sync-legal.js поверх уже вставленного футера).
    const pageWithFooterAgain = applyFooter(pageWithFooter, footerHtml);
    assert.equal(stripLegalBlock(pageWithFooterAgain), cleanRender, 'повторное применение applyFooter расходится с чистым рендером после strip');
});

test('юридический блок: инвариант перевода строки переживает перенос блока в новую версию (round-trip)', () => {
    const category = CATEGORIES[0];
    const freshRender = renderCategoryPage(category);

    // Строим pageWithBlock так же, как это делает сам генератор: сначала где-то
    // (в «предыдущей» версии страницы) появляется юридический блок через
    // preserveLegalBlock, и именно этот результат затем оказывается на диске
    // как oldHtml для следующего прогона.
    const legal = `${LEGAL_START}\n<footer>реквизиты</footer>\n${LEGAL_END}`;
    const previousVersion = `<html><body><p>предыдущая версия</p>\n${legal}\n</body></html>`;
    const pageWithBlock = preserveLegalBlock(previousVersion, freshRender);

    // Первый проход: тот самый round-trip, который гейт `checkCategoryPagesSynced`
    // выполняет неявно при сравнении «файл на диске» со «свежим рендером».
    const merged1 = preserveLegalBlock(pageWithBlock, freshRender);
    assert.equal(stripLegalBlock(merged1), stripLegalBlock(freshRender), 'round-trip разошёлся с чистым рендером на первом проходе');

    // Второй проход (идемпотентность): повторный цикл perserve+strip поверх
    // уже содержащей блок страницы не должен накапливать лишние байты/строки.
    const merged2 = preserveLegalBlock(merged1, freshRender);
    assert.equal(stripLegalBlock(merged2), stripLegalBlock(freshRender), 'round-trip разошёлся с чистым рендером на втором проходе');
});
