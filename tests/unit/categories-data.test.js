'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CATEGORIES } = require('../../seo/categories-data');

const SLUGS = ['rti', 'metall', 'armatura', 'elektro'];
// Названия категорий в БД — из CATEGORY_KEYWORDS в server.js:702. Грид закупок
// фильтруется ровно этими значениями, опечатка = вечно пустая страница.
const DB_CATEGORIES = ['РТИ', 'Металл', 'Трубопроводная арматура', 'Электрооборудование'];

function words(text) {
    return String(text).split(/\s+/).filter(w => /[а-яА-ЯёЁa-zA-Z0-9]/.test(w)).length;
}

// Слова длиннее 4 символов — грубый, но достаточный признак содержательного
// текста (предлоги, союзы и короткие связки не считаются).
function longWords(text) {
    return new Set(
        String(text)
            .toLowerCase()
            .split(/[^а-яёa-z0-9]+/i)
            .filter(w => w.length > 4),
    );
}

function sentences(text) {
    return String(text)
        .split(/[.!?]+/)
        .map(s => s.trim())
        .filter(Boolean).length;
}

test('данные: четыре категории с ожидаемыми slug и категориями БД', () => {
    assert.equal(CATEGORIES.length, 4);
    assert.deepEqual(CATEGORIES.map(c => c.slug).sort(), [...SLUGS].sort());
    for (const c of CATEGORIES) {
        assert.ok(DB_CATEGORIES.includes(c.dbCategory), `${c.slug}: категория БД «${c.dbCategory}» неизвестна`);
    }
});

test('данные: мета-теги заполнены и в разумных пределах', () => {
    for (const c of CATEGORIES) {
        assert.ok(c.title.length >= 30 && c.title.length <= 70, `${c.slug}: title ${c.title.length} знаков`);
        assert.ok(c.description.length >= 100 && c.description.length <= 180, `${c.slug}: description ${c.description.length} знаков`);
        assert.ok(c.ogTitle && c.ogDescription, `${c.slug}: og-теги пустые`);
    }
});

test('данные: интро — связный текст, а не подпись к картинке', () => {
    for (const c of CATEGORIES) {
        const n = words(c.intro);
        assert.ok(n >= 60 && n <= 110, `${c.slug}: интро ${n} слов, нужно 60–110`);
    }
});

test('данные: интро категорий не дублируют друг друга под другими существительными', () => {
    const sets = CATEGORIES.map(c => ({ slug: c.slug, set: longWords(c.intro) }));
    for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
            const a = sets[i].set;
            const b = sets[j].set;
            const shared = [...a].filter(w => b.has(w)).length;
            const minSize = Math.min(a.size, b.size);
            const ratio = minSize ? shared / minSize : 0;
            assert.ok(
                ratio <= 0.6,
                `${sets[i].slug}/${sets[j].slug}: интро пересекаются на ${(ratio * 100).toFixed(0)}% длинных слов (порог 60%)`,
            );
        }
    }
});

test('данные: позиции с материалами, ГОСТы в правильном формате', () => {
    for (const c of CATEGORIES) {
        assert.ok(c.positions.length >= 8 && c.positions.length <= 12, `${c.slug}: позиций ${c.positions.length}`);
        for (const p of c.positions) {
            assert.ok(p.name && p.materials, `${c.slug}: у позиции пустое имя или материалы`);
            if (p.gost) assert.match(p.gost, /^ГОСТ( Р)?( IEC)? \d{1,5}(\.\d{1,3})*(-\d{2,4})?$/, `${c.slug}: «${p.gost}» не похож на номер стандарта`);
        }
        assert.ok(c.positions.some(p => p.gost), `${c.slug}: ни одной позиции с ГОСТом`);
    }
});

test('данные: шаги, чеклист и факторы цены на месте', () => {
    for (const c of CATEGORIES) {
        assert.equal(c.steps.length, 4, `${c.slug}: шагов должно быть 4`);
        for (const s of c.steps) assert.ok(s.title && words(s.text) >= 8, `${c.slug}: шаг «${s.title}» пустой`);
        assert.ok(c.checklist.length >= 5 && c.checklist.length <= 7, `${c.slug}: чеклист ${c.checklist.length} пунктов`);
        assert.ok(c.priceFactors.length >= 4 && c.priceFactors.length <= 5, `${c.slug}: факторов цены ${c.priceFactors.length}`);
    }
});

test('данные: FAQ — реальные ответы, а не одно предложение', () => {
    for (const c of CATEGORIES) {
        assert.ok(c.faq.length >= 5 && c.faq.length <= 6, `${c.slug}: вопросов ${c.faq.length}`);
        for (const item of c.faq) {
            assert.match(item.q, /\?$/, `${c.slug}: вопрос без знака вопроса: ${item.q}`);
            assert.ok(words(item.a) >= 20, `${c.slug}: ответ на «${item.q}» короче 20 слов`);
            const n = sentences(item.a);
            assert.ok(n >= 2 && n <= 5, `${c.slug}: ответ на «${item.q}» из ${n} предложений, нужно 2–5`);
        }
    }
});

test('данные: перелинковка ведёт на три другие категории', () => {
    for (const c of CATEGORIES) {
        const hrefs = c.related.map(r => r.href);
        for (const other of CATEGORIES) {
            if (other.slug === c.slug) continue;
            assert.ok(hrefs.includes(`/zakupki/${other.slug}`), `${c.slug}: нет ссылки на ${other.slug}`);
        }
    }
});

test('данные: запрещённые рекламные штампы не просочились', () => {
    const banned = ['уникальн', 'широкий спектр', 'широкого спектра', 'команда профессионал', 'лучшие цены', 'гибкая система скидок'];
    const blob = JSON.stringify(CATEGORIES).toLowerCase();
    for (const b of banned) assert.ok(!blob.includes(b), `в тексте найден штамп «${b}»`);
});

test('данные: площадка не обещает цен и сроков от своего лица', () => {
    const blob = JSON.stringify(CATEGORIES).toLowerCase();
    for (const b of ['средняя цена по рынку', 'мы доставим', 'гарантируем срок']) {
        assert.ok(!blob.includes(b), `в тексте найдено обещание «${b}»`);
    }
});

// server.js хардкодит четыре slug'а дважды — в CAT_PAGES (регистрация роутов /zakupki/:slug)
// и в билдере sitemap.xml. seo/categories-data.js — третье, независимое место. Если сюда
// добавить пятую категорию, sync-category-pages.js молча сгенерирует страницу, гейт
// checkCategoryPagesSynced её пропустит, а в проде она отдаст 404 (роут не зарегистрирован)
// и никогда не попадёт в sitemap. Этот тест не чинит server.js (правка вне периметра задачи),
// он ловит рассинхронизацию в момент, когда её проще всего исправить — при добавлении категории.
test('server.js: слаги в CAT_PAGES и в sitemap не расходятся с CATEGORIES', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const dataSlugs = CATEGORIES.map(c => c.slug).sort();

    const catPagesMatch = server.match(/const CAT_PAGES = \[([\s\S]*?)\n\];/);
    assert.ok(catPagesMatch, 'не нашли определение CAT_PAGES в server.js — обнови регэксп теста');
    const catPagesSlugs = [...catPagesMatch[1].matchAll(/slug:\s*'([a-z]+)'/g)].map(m => m[1]).sort();

    const sitemapSlugs = [...server.matchAll(/url:\s*'\/zakupki\/([a-z]+)'/g)].map(m => m[1]).sort();
    assert.ok(sitemapSlugs.length > 0, 'не нашли записи /zakupki/<slug> в билдере sitemap — обнови регэксп теста');

    assert.deepEqual(catPagesSlugs, dataSlugs, `CAT_PAGES (${catPagesSlugs.join(',')}) разошёлся с CATEGORIES (${dataSlugs.join(',')})`);
    assert.deepEqual(sitemapSlugs, dataSlugs, `sitemap (${sitemapSlugs.join(',')}) разошёлся с CATEGORIES (${dataSlugs.join(',')})`);
});
