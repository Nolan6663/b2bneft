'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    renderCategoryPage, stripLegalBlock, preserveLegalBlock, pageWordCount,
    LEGAL_START, LEGAL_END,
} = require('../../scripts/sync-category-pages');
const { CATEGORIES } = require('../../seo/categories-data');

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
