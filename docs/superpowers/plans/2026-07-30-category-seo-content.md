# Товарный SEO: категорийные страницы под интент заказчика — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** превратить четыре тонкие категорийные страницы в полноценные страницы под интент заказчика и довести лендинг до 800+ слов с перелинковкой на категории.

**Architecture:** контент категорий живёт в `seo/categories-data.js`, `scripts/sync-category-pages.js` рендерит из него `zakupki/*.html`, сохраняя вставленный `sync-legal.js` футер; `npm run check` падает при рассинхроне. Пустое состояние грида закупок подтягивает заводы категории новым публичным эндпоинтом.

**Tech Stack:** Node 20+, Express 5, PostgreSQL, ванильный JS без сборщика, `node:test`.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-07-30-category-seo-content-design.md`.
- URL и `canonical` четырёх страниц не менять: `/zakupki/metall`, `/zakupki/armatura`, `/zakupki/elektro`, `/zakupki/rti` уже в sitemap и проиндексированы.
- Категории в БД называются ровно так: `'РТИ'`, `'Металл'`, `'Трубопроводная арматура'`, `'Электрооборудование'` (`server.js:702`, `CATEGORY_KEYWORDS`). Грид закупок фильтруется этими значениями.
- **Каждый номер ГОСТа сверяется перед публикацией.** Не уверен — описываем позицию без номера. Выдуманный стандарт на странице для инженера хуже отсутствия номера.
- Никаких прайсов, «средних цен по рынку» и сроков поставки от лица площадки: площадка не сторона сделки (так написано в `/terms`).
- Количество заводов в текстах — фактическое (в каталоге 4300), «1200+» устарело.
- Тексты пишутся как инженерная документация: без «уникальных возможностей», «широкого спектра», «команды профессионалов».
- Айдентика «Чертёжный цех»: без декоративных `linear-gradient`, без hover-подъёмов `translateY(-`, без мягких свечений в `box-shadow`, без pill-радиусов `999px/50px/20px` на бейджах. Переменные — из `assets/css/tokens.css`, стили категорийных страниц — в `assets/zakupki-cat.css`, не инлайном.
- `yandex_3fbc490e3bd5d37d.html` и `googleefff6b0475352b2b.html` не трогать ни при каких условиях — Яндекс и Google сверяют их побайтово.
- Порядок генераторов: `npm run sync:categories`, затем `npm run sync:legal`. Генератор категорий переносит существующий блок между `<!-- legal-footer:start -->` и `<!-- legal-footer:end -->`, а не затирает его.
- Схема БД меняется только через `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` внизу `db.js`. В этом плане схема не меняется.
- Работать в ветке `feature/category-seo`, push в `main` = автодеплой на прод.
- Проверка после деплоя: `https://texzakaz.ru/api/health` отдаёт хеш задеплоенного коммита.

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `seo/categories-data.js` (создать) | контент четырёх категорий, только данные, без разметки |
| `scripts/sync-category-pages.js` (создать) | чистые функции рендера и записи + CLI |
| `tests/unit/categories-data.test.js` (создать) | целостность данных: обязательные поля, объёмы, уникальность |
| `tests/unit/category-pages.test.js` (создать) | рендер, идемпотентность, сохранение юридического блока, подсчёт слов |
| `tests/unit/seo-content.test.js` (создать) | объём видимого текста и валидность JSON-LD на готовых страницах |
| `scripts/static-checks.js` (изменить) | гейт синка категорий |
| `routes/public.js` (изменить) | `GET /api/public/producers` |
| `tests/unit/public-producers.test.js` (создать) | эндпоинт на fakePool |
| `landing.html` (изменить) | снять дубль, блок категорий, расширенный FAQ, актуальное число заводов |
| `assets/zakupki-cat.css` (изменить) | стили новых блоков категорийной страницы |
| `package.json` (изменить) | скрипт `sync:categories` |

---

### Task 1: Данные категорий

**Files:**
- Create: `seo/categories-data.js`
- Test: `tests/unit/categories-data.test.js`

**Interfaces:**
- Produces: `module.exports = { CATEGORIES }` — массив из четырёх объектов. Поля каждого:
  `slug` (строка: `'rti' | 'metall' | 'armatura' | 'elektro'`), `dbCategory` (строка ровно как в БД), `shortName`, `title`, `description`, `ogTitle`, `ogDescription`, `h1`, `intro` (строка, 60–90 слов), `tags` (массив строк, 5–8), `positions` (массив `{ name, gost, materials }`, 8–12 элементов; `gost` — строка вида `'ГОСТ 8752'` либо `''`), `steps` (массив `{ title, text }`, ровно 4), `checklist` (массив строк, 5–7), `priceFactors` (массив `{ title, text }`, 4–5), `faq` (массив `{ q, a }`, 5–6; `a` — 2–4 предложения), `related` (массив `{ href, label }`).
- Consumes: ничего.

- [ ] **Step 1: Написать падающий тест на целостность данных**

Создать `tests/unit/categories-data.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES } = require('../../seo/categories-data');

const SLUGS = ['rti', 'metall', 'armatura', 'elektro'];
// Названия категорий в БД — из CATEGORY_KEYWORDS в server.js:702. Грид закупок
// фильтруется ровно этими значениями, опечатка = вечно пустая страница.
const DB_CATEGORIES = ['РТИ', 'Металл', 'Трубопроводная арматура', 'Электрооборудование'];

function words(text) {
    return String(text).split(/\s+/).filter(w => /[а-яА-ЯёЁa-zA-Z0-9]/.test(w)).length;
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

test('данные: позиции с материалами, ГОСТы в правильном формате', () => {
    for (const c of CATEGORIES) {
        assert.ok(c.positions.length >= 8 && c.positions.length <= 12, `${c.slug}: позиций ${c.positions.length}`);
        for (const p of c.positions) {
            assert.ok(p.name && p.materials, `${c.slug}: у позиции пустое имя или материалы`);
            if (p.gost) assert.match(p.gost, /^ГОСТ( Р)? \d{3,5}(-\d{2,4})?$/, `${c.slug}: «${p.gost}» не похож на номер стандарта`);
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test tests/unit/categories-data.test.js`
Expected: FAIL, `Cannot find module '../../seo/categories-data'`

- [ ] **Step 3: Создать данные — категория РТИ как образец**

Создать `seo/categories-data.js`. Ниже полностью написанная категория РТИ; остальные три пишутся по этому же образцу на шаге 4.

```js
'use strict';

// Контент категорийных страниц /zakupki/<slug>. Только данные: разметку собирает
// scripts/sync-category-pages.js. Тексты — под интент заказчика («нужно изготовить
// по чертежу»), не под поставщика. Номера ГОСТов сверены; сомнительный номер
// не пишем вовсе — у позиции остаётся пустой gost.
const CATEGORIES = [
    {
        slug: 'rti',
        dbCategory: 'РТИ',
        shortName: 'РТИ',
        title: 'Изготовление РТИ по чертежу заказчика — ТехЗаказ',
        description: 'Разместите заказ на резинотехнические изделия по своему чертежу: манжеты, кольца, прокладки, полиуретан. Профильные заводы отвечают напрямую, без посредников.',
        ogTitle: 'Изготовление РТИ по чертежу — ТехЗаказ',
        ogDescription: 'Заказ резинотехнических изделий по чертежу напрямую у производителей.',
        h1: 'Изготовление РТИ по чертежу заказчика',
        intro: 'Резинотехнические изделия почти никогда не берут «как есть»: посадочные размеры, твёрдость и стойкость к среде задаёт конструкция узла, а не каталог поставщика. На ТехЗаказе заказчик размещает чертёж или эскиз уплотнения, и заявка уходит заводам, которые действительно работают с эластомерами и полиуретаном. Ответы приходят от производителей напрямую — без торговых домов, накручивающих маржу на перепродаже прокладки. Так закупают ремонтные комплекты для насосов и запорной арматуры, уплотнения гидроцилиндров, футеровку и формовые изделия под конкретный узел.',
        tags: ['Манжеты', 'Уплотнительные кольца', 'Прокладки', 'Сальники', 'Полиуретан', 'Формовые изделия', 'Футеровка'],
        positions: [
            { name: 'Манжеты уплотнительные для валов', gost: 'ГОСТ 8752', materials: 'НБР, ФПМ, силикон' },
            { name: 'Кольца резиновые круглого сечения', gost: 'ГОСТ 9833', materials: 'НБР, ЭПДМ, ФПМ' },
            { name: 'Кольца: технические требования', gost: 'ГОСТ 18829', materials: 'НБР, ЭПДМ' },
            { name: 'Прокладки плоские под фланцы', gost: '', materials: 'ТМКЩ, паронит, ЭПДМ' },
            { name: 'Манжеты для гидравлических цилиндров', gost: '', materials: 'полиуретан, НБР' },
            { name: 'Формовые изделия по чертежу', gost: '', materials: 'НБР, ЭПДМ, силикон, полиуретан' },
            { name: 'Рукава и шланги напорные', gost: '', materials: 'резина с текстильным каркасом' },
            { name: 'Футеровка и обкладка узлов', gost: '', materials: 'износостойкая резина, полиуретан' },
            { name: 'Виброопоры и амортизаторы', gost: '', materials: 'резинометалл' },
            { name: 'Шнуры и пластины технические', gost: '', materials: 'ТМКЩ, МБС' },
        ],
        steps: [
            { title: 'Приложите чертёж или эскиз', text: 'PDF, DWG или STEP с посадочными размерами. Если чертежа нет, помогает AI-помощник: он собирает техническое задание по описанию узла и условий работы.' },
            { title: 'Заявка уходит профильным заводам', text: 'Площадка сопоставляет закупку с профилями производителей и уведомляет тех, кто работает с нужным материалом, а не всех подряд.' },
            { title: 'Сравните предложения', text: 'Цена, срок, материал и условия приёмки видны в одной таблице. Есть бенчмарк цен по категории и выгрузка сравнения в PDF для согласования.' },
            { title: 'Выберите исполнителя', text: 'Переписка, договор со спецификацией и этапы поставки остаются в сделке. Договор формируется из принятого предложения.' },
        ],
        checklist: [
            'Чертёж или эскиз с посадочными и присоединительными размерами',
            'Материал или требования к среде: масло, топливо, пар, кислота, температура',
            'Твёрдость по Шору и допуски на размеры',
            'Количество и партионность: разовая партия или серия',
            'Требования к приёмке: протоколы испытаний, сертификаты на материал',
            'Срок, к которому нужна партия',
        ],
        priceFactors: [
            { title: 'Оснастка', text: 'Формовое изделие требует пресс-формы. На разовой партии её стоимость ложится в цену изделия, на серии — размывается.' },
            { title: 'Материал', text: 'ФПМ и силикон дороже НБР в разы. Требование «стойкость к агрессивной среде» без уточнения среды заставляет завод считать по худшему сценарию.' },
            { title: 'Партия', text: 'Десять манжет и десять тысяч — разная технология и разная цена за штуку.' },
            { title: 'Приёмка', text: 'Протоколы испытаний и сертификаты на сырьё добавляют работы и времени, но снимают риск получить не тот материал.' },
        ],
        faq: [
            {
                q: 'Можно заказать РТИ без чертежа?',
                a: 'Да, если известны посадочные размеры узла и условия работы: среда, температура, давление. В форме закупки есть AI-помощник, который собирает техническое задание по описанию. Заводы уточнят детали в переписке, но чем точнее исходные данные, тем меньше расхождений в предложениях.',
            },
            {
                q: 'Сколько заводов увидит мою заявку?',
                a: 'Заявку видят производители, чей профиль совпадает с категорией и продукцией закупки. В каталоге больше четырёх тысяч предприятий, из них уведомление получают профильные. Публичная страница закупки при этом не раскрывает название компании-заказчика.',
            },
            {
                q: 'Что с минимальной партией?',
                a: 'Минимум задаёт производитель, а не площадка. По формовым изделиям порог обычно выше из-за оснастки, по стандартным кольцам и манжетам его почти нет. Указывайте нужное количество в заявке — предложения придут от тех, кому такая партия подходит.',
            },
            {
                q: 'Кто отвечает за качество партии?',
                a: 'Завод-изготовитель по договору с заказчиком. Площадка не сторона сделки: она формирует договор со спецификацией из принятого предложения и фиксирует этапы поставки, но обязательства по качеству остаются на производителе.',
            },
            {
                q: 'Есть ли плата за размещение закупки?',
                a: 'Размещение закупки и получение предложений бесплатны для заказчика. Платные тарифы касаются расширенных возможностей для поставщиков; условия описаны на странице тарифов.',
            },
        ],
        related: [
            { href: '/zakupki/metall', label: 'Металлообработка' },
            { href: '/zakupki/armatura', label: 'Трубопроводная арматура' },
            { href: '/zakupki/elektro', label: 'Электрооборудование' },
            { href: '/map', label: 'Карта производителей' },
        ],
    },
    // остальные три категории добавляются на шаге 4
];

module.exports = { CATEGORIES };
```

- [ ] **Step 4: Дописать три остальные категории**

По образцу выше добавить `metall`, `armatura`, `elektro`. Требования к каждой — те же, что проверяет тест: интро 60–110 слов, 8–12 позиций (хотя бы одна с ГОСТом), 4 шага, 5–7 пунктов чеклиста, 4–5 факторов цены, 5–6 вопросов FAQ с ответами не короче 20 слов, перелинковка на три другие категории и карту.

Опорные значения по категориям:

| Категория | `dbCategory` | Что перечислять в позициях | ГОСТы для сверки |
|---|---|---|---|
| `metall` | `Металл` | токарная и фрезерная обработка по чертежу, детали на ЧПУ, поковки, отливки, металлоконструкции, сварные узлы, лазерный раскрой, гибка, шлифовка, термообработка | поковки ГОСТ 8479, отливки ГОСТ 977, сварные соединения ГОСТ 5264 и ГОСТ 14771, швеллер ГОСТ 8240, уголок ГОСТ 8509 |
| `armatura` | `Трубопроводная арматура` | задвижки, шаровые краны, клапаны запорные и обратные, затворы поворотные, фланцы, фитинги, отводы и тройники, детали трубопроводов | задвижки ГОСТ 5762, шаровые краны ГОСТ 21345, фланцы ГОСТ 33259, трубы бесшовные ГОСТ 8732, трубы электросварные ГОСТ 10704 |
| `elektro` | `Электрооборудование` | шкафы и щиты управления, сборки НКУ, кабельная продукция, электродвигатели, преобразователи частоты, трансформаторы, посты местного управления, обогрев и КИП-обвязка | кабели ГОСТ 31996, степени защиты IP по ГОСТ 14254 |

Каждый номер перед записью в файл сверить. Если сверить не удалось — оставить `gost: ''` и описать позицию словами.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `node --test tests/unit/categories-data.test.js`
Expected: PASS, 9 тестов

- [ ] **Step 6: Коммит**

```bash
git checkout -b feature/category-seo
git add seo/categories-data.js tests/unit/categories-data.test.js
git commit -m "feat(seo): buyer-intent content data for the four category pages"
```

---

### Task 2: Генератор страниц и гейт

**Files:**
- Create: `scripts/sync-category-pages.js`
- Test: `tests/unit/category-pages.test.js`
- Modify: `scripts/static-checks.js`
- Modify: `package.json`
- Modify: `assets/zakupki-cat.css`

**Interfaces:**
- Consumes: `{ CATEGORIES }` из `seo/categories-data.js`.
- Produces: `module.exports = { renderCategoryPage, stripLegalBlock, preserveLegalBlock, pageWordCount, syncAll, LEGAL_START, LEGAL_END }`.
  `renderCategoryPage(category)` → строка HTML целой страницы без юридического блока.
  `stripLegalBlock(html)` → строка без блока между маркерами.
  `preserveLegalBlock(oldHtml, newHtml)` → строка: `newHtml` с блоком, вынутым из `oldHtml` (если его там не было — `newHtml` без изменений).
  `pageWordCount(html)` → число слов видимого текста.
  `syncAll(root)` → `{ changed: string[], total: number }`.

- [ ] **Step 1: Написать падающий тест генератора**

Создать `tests/unit/category-pages.test.js`:

```js
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test tests/unit/category-pages.test.js`
Expected: FAIL, `Cannot find module '../../scripts/sync-category-pages'`

- [ ] **Step 3: Реализовать генератор**

Создать `scripts/sync-category-pages.js`:

```js
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
    return (html.slice(0, from) + html.slice(to + LEGAL_END.length)).replace(/\n{3,}/g, '\n\n');
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

function renderFaqJsonLd(category) {
    return JSON.stringify({
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
    return JSON.stringify({
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
    const others = CATEGORIES.filter(c => c.slug !== category.slug);
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
      <p class="zc-fallback-lead">Открытых закупок в категории сейчас нет. Вот предприятия из каталога, которые работают по этому профилю:</p>
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
var CATEGORY = ${JSON.stringify(category.dbCategory)};
function renderOrders(orders) {
  var grid = document.getElementById('orders-grid');
  grid.innerHTML = orders.map(function (o) {
    return '<article class="zc-card">'
      + '<div class="zc-card-top"><span class="zc-badge">' + o.category + '</span><span class="zc-status">Активный</span></div>'
      + '<h3 class="zc-card-title">' + o.title + '</h3>'
      + '<div class="zc-card-meta">'
      + (o.deadline ? '<span>Срок: до ' + new Date(o.deadline).toLocaleDateString('ru-RU') + '</span>' : '')
      + (o.quantity ? '<span>Кол-во: ' + o.quantity + '</span>' : '')
      + '<span>' + (o.responses || 0) + ' предложений</span></div>'
      + '<div class="zc-card-footer"><span class="zc-company">••••••••</span>'
      + '<a href="/login#register" class="zc-respond">Подать КП</a></div>'
      + '</article>';
  }).join('');
}
function showProducers() {
  var grid = document.getElementById('orders-grid');
  var fallback = document.getElementById('producers-fallback');
  grid.style.display = 'none';
  fetch('/api/public/producers?category=' + encodeURIComponent(CATEGORY) + '&limit=8')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      if (!list.length) { fallback.style.display = 'block'; return; }
      document.getElementById('producers-grid').innerHTML = list.map(function (p) {
        return '<a class="zc-card zc-card-link" href="/p/' + p.id + '">'
          + '<h3 class="zc-card-title">' + p.company + '</h3>'
          + '<div class="zc-card-meta"><span>' + (p.city || 'город не указан') + '</span>'
          + (p.verified ? '<span class="zc-badge">Проверено</span>' : '') + '</div></a>';
      }).join('');
      fallback.style.display = 'block';
    })
    .catch(function () { fallback.style.display = 'block'; });
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
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `node --test tests/unit/category-pages.test.js`
Expected: PASS, 9 тестов

- [ ] **Step 5: Добавить стили новых блоков**

В конец `assets/zakupki-cat.css` добавить:

```css
/* ── Контентные блоки категорийной страницы ────────────────────────── */
.zc-h2 { font-size: 22px; font-weight: 800; color: #071B2A; margin: 36px 0 14px; letter-spacing: -.4px; }
.zc-table { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 8px; }
.zc-table th, .zc-table td { border: 1px solid #E2E8F0; padding: 9px 12px; text-align: left; color: #334155; }
.zc-table th { background: #F8FAFC; font-weight: 700; color: #071B2A; }
.zc-steps, .zc-checklist { margin: 0 0 8px 20px; font-size: 14.5px; line-height: 1.75; color: #334155; }
.zc-steps li, .zc-checklist li { margin-bottom: 8px; }
.zc-factors { font-size: 14.5px; line-height: 1.7; color: #334155; }
.zc-factors dt { font-weight: 700; color: #071B2A; margin-top: 12px; }
.zc-factors dd { margin: 4px 0 0; }
.zc-faq-item { border: 1px solid #E2E8F0; border-radius: 3px; padding: 12px 14px; margin-bottom: 8px; background: #fff; }
.zc-faq-item summary { font-weight: 700; font-size: 14.5px; color: #071B2A; cursor: pointer; }
.zc-faq-item p { margin: 10px 0 0; font-size: 14px; line-height: 1.7; color: #334155; }
.zc-related { display: flex; flex-wrap: wrap; gap: 10px; }
.zc-related a { font-size: 13.5px; font-weight: 600; color: #334155; text-decoration: none; border: 1px solid #E2E8F0; border-radius: 3px; padding: 8px 14px; background: #fff; }
.zc-related a:hover { border-color: #0B2233; color: #071B2A; }
.zc-fallback-lead { font-size: 14.5px; line-height: 1.7; color: #334155; margin-bottom: 14px; }
.zc-card-link { text-decoration: none; display: block; }
@media (max-width: 720px) {
  .zc-table { display: block; overflow-x: auto; }
}
```

- [ ] **Step 6: Прогнать генератор и посмотреть на объём**

Run: `node scripts/sync-category-pages.js`
Expected: `Category pages synced: 4 changed of 4`

Run: `node scripts/sync-legal.js`
Expected: `Footer synced: 0 changed of 11 pages` — генератор перенёс уже стоявший юридический блок дословно, поэтому футерному синку править нечего. Если здесь `4 changed`, значит `preserveLegalBlock` блок потерял или изменил — это дефект, а не норма.

Run: `node scripts/sync-category-pages.js`
Expected: `Category pages synced: 0 changed of 4` — прогон идемпотентен и не тронул юридический блок

- [ ] **Step 7: Добавить npm-скрипт**

В `package.json` в блок `scripts` добавить рядом с `sync:legal`:

```json
    "sync:categories": "node scripts/sync-category-pages.js",
```

- [ ] **Step 8: Добавить гейт в static-checks**

В `scripts/static-checks.js` добавить функцию перед `function main()`:

```js
function checkCategoryPagesSynced() {
  const { renderCategoryPage, stripLegalBlock } = require('./sync-category-pages');
  const { CATEGORIES } = require('../seo/categories-data');
  const stale = [];
  for (const category of CATEGORIES) {
    const rel = path.join('zakupki', `${category.slug}.html`);
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) { stale.push(rel + ' (файла нет)'); continue; }
    // Сравниваем без юридического блока: его вставляет sync-legal.js, у него свой гейт.
    const actual = stripLegalBlock(fs.readFileSync(file, 'utf8')).replace(/\r\n/g, '\n');
    const expected = stripLegalBlock(renderCategoryPage(category)).replace(/\r\n/g, '\n');
    if (actual !== expected) stale.push(rel);
  }
  if (stale.length) {
    fail(`Категорийные страницы разошлись с seo/categories-data.js — прогони "npm run sync:categories":\n${stale.join('\n')}`);
  }
}
```

Вызов в `main()` после `checkLegalFooterSynced();`:

```js
  checkCategoryPagesSynced();
```

И в массив `jsFiles` (строка 10) дописать новые файлы:

```js
  'scripts/legal-data.js', 'scripts/sync-legal.js',
  'scripts/sync-category-pages.js', 'seo/categories-data.js',
```

- [ ] **Step 9: Проверить, что гейт ловит рассинхрон**

Run: `npm run check`
Expected: `Static checks passed`

Run: `node -e "const fs=require('fs');const f='zakupki/rti.html';fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('Манжеты','Манжетики'))"`
Run: `npm run check`
Expected: FAIL с текстом `Категорийные страницы разошлись с seo/categories-data.js`

Run: `node scripts/sync-category-pages.js && npm run check`
Expected: PASS

- [ ] **Step 10: Коммит**

```bash
git add scripts/sync-category-pages.js tests/unit/category-pages.test.js scripts/static-checks.js package.json assets/zakupki-cat.css zakupki
git commit -m "feat(seo): generate category pages from the content data file"
```

---

### Task 3: Публичный эндпоинт заводов категории

**Files:**
- Modify: `routes/public.js`
- Test: `tests/unit/public-producers.test.js`

**Interfaces:**
- Consumes: `deps.pool`, `deps.rowToCompany`, `deps.getProducerCategories` — всё уже передаётся в `createPublicRouter` (`server.js:1231`).
- Produces: `GET /api/public/producers?category=<категория>&limit=<1..24>` → JSON-массив `{ id, company, city, verified }`, где `verified` — `verified_by_platform || verified_egrul`.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/unit/public-producers.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPublicRouter = require('../../routes/public');
const { fakePool, serve, baseDeps } = require('./helpers');

const ROWS = [
    { id: 1, company: 'ООО Рези', city: 'Казань', role: 'producer', specialization: 'Резинотехнические изделия', products: 'манжеты', verified_by_platform: true, verified_egrul: false },
    { id: 2, company: 'ООО Металл', city: 'Челябинск', role: 'producer', specialization: 'Металлообработка', products: 'токарная обработка', verified_by_platform: false, verified_egrul: false },
    { id: 3, company: 'ООО Уплотнения', city: 'Пермь', role: 'producer', specialization: 'Уплотнения и прокладки', products: '', verified_by_platform: false, verified_egrul: true },
];

function router(rows = ROWS) {
    const deps = baseDeps({
        pool: fakePool([{ match: /FROM companies/i, rows }]),
        rowToCompany: (r) => r,
        // как в server.js:809 — по словам специализации
        getProducerCategories: (p) => {
            const text = `${p.specialization || ''} ${p.products || ''}`.toLowerCase();
            const out = [];
            if (/резин|уплотн|манжет/.test(text)) out.push('РТИ');
            if (/металл|токар|фрезер/.test(text)) out.push('Металл');
            return out;
        },
    });
    return createPublicRouter(deps);
}

test('заводы категории: отдаются только совпавшие по категории', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/producers?category=' + encodeURIComponent('РТИ'));
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.map(p => p.id).sort(), [1, 3]);
        assert.equal(res.json.find(p => p.id === 1).verified, true, 'verified_by_platform должен давать verified');
        assert.equal(res.json.find(p => p.id === 3).verified, true, 'verified_egrul тоже даёт verified');
    } finally { await srv.close(); }
});

test('заводы категории: limit ограничивает выдачу и не пускает мусор', async () => {
    const srv = await serve('/api', router());
    try {
        const one = await srv.request('/api/public/producers?category=' + encodeURIComponent('РТИ') + '&limit=1');
        assert.equal(one.json.length, 1);
        const huge = await srv.request('/api/public/producers?category=' + encodeURIComponent('РТИ') + '&limit=999');
        assert.ok(huge.json.length <= 24, 'верхний предел выдачи — 24');
        const junk = await srv.request('/api/public/producers?category=' + encodeURIComponent('РТИ') + '&limit=abc');
        assert.equal(junk.status, 200, 'битый limit не должен ломать ответ');
    } finally { await srv.close(); }
});

test('заводы категории: без параметра category — 400', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/producers');
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});

test('заводы категории: ничего не совпало — пустой массив, не ошибка', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/producers?category=' + encodeURIComponent('Электрооборудование'));
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, []);
    } finally { await srv.close(); }
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test tests/unit/public-producers.test.js`
Expected: FAIL — приходит 404, маршрута нет

- [ ] **Step 3: Реализовать эндпоинт**

В `routes/public.js` рядом с `router.get('/public/companies/:id', ...)` добавить:

```js
    // Заводы категории для пустого состояния категорийных страниц: открытых закупок
    // может не быть, но страница должна оставаться полезной и линковать карточки /p/:id.
    router.get('/public/producers', async (req, res, next) => {
        try {
            const category = String(req.query.category || '').trim();
            if (!category) return res.status(400).json({ error: 'Укажите категорию' });
            const parsed = parseInt(req.query.limit, 10);
            const limit = Math.max(1, Math.min(24, Number.isFinite(parsed) ? parsed : 8));

            const { rows } = await pool.query(
                `SELECT * FROM companies
                 WHERE role = 'producer'
                 ORDER BY verified_by_platform DESC, verified_egrul DESC, claimed DESC, company ASC`
            );

            const list = [];
            for (const row of rows) {
                const producer = rowToCompany(row);
                if (!getProducerCategories(producer).includes(category)) continue;
                list.push({
                    id: producer.id,
                    company: producer.company,
                    city: producer.city || '',
                    verified: Boolean(producer.verified_by_platform || producer.verified_egrul),
                });
                if (list.length >= limit) break;
            }
            res.json(list);
        } catch (e) { next(e); }
    });
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `node --test tests/unit/public-producers.test.js`
Expected: PASS, 4 теста

Run: `npm test`
Expected: 0 падений

- [ ] **Step 5: Коммит**

```bash
git add routes/public.js tests/unit/public-producers.test.js
git commit -m "feat(seo): public endpoint listing producers of a category"
```

---

### Task 4: Лендинг

**Files:**
- Modify: `landing.html` (секция «Как работает ТехЗаказ» около строки 1257, `FAQPage` в JSON-LD около строки 81, блок FAQ около строки 1134)
- Test: `tests/unit/seo-content.test.js`

**Interfaces:**
- Consumes: `pageWordCount` из `scripts/sync-category-pages.js`, `{ CATEGORIES }` из `seo/categories-data.js`.
- Produces: ничего для последующих задач.

- [ ] **Step 1: Написать падающий тест на объём и разметку**

Создать `tests/unit/seo-content.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pageWordCount } = require('../../scripts/sync-category-pages');
const { CATEGORIES } = require('../../seo/categories-data');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('объём: категорийные страницы не тоньше 600 слов', () => {
    for (const c of CATEGORIES) {
        const n = pageWordCount(read(path.join('zakupki', `${c.slug}.html`)));
        assert.ok(n >= 600, `zakupki/${c.slug}.html: ${n} слов, нужно ≥ 600`);
    }
});

test('объём: лендинг не тоньше 800 слов', () => {
    const n = pageWordCount(read('landing.html'));
    assert.ok(n >= 800, `landing.html: ${n} слов, нужно ≥ 800`);
});

test('лендинг: перелинковка на все четыре категории', () => {
    const html = read('landing.html');
    for (const c of CATEGORIES) {
        assert.ok(html.includes(`/zakupki/${c.slug}`), `на лендинге нет ссылки на /zakupki/${c.slug}`);
    }
});

test('лендинг: секция «Как работает ТехЗаказ» больше не дублирует «Как проходит закупка»', () => {
    const html = read('landing.html');
    const hasFlow = html.includes('Как проходит закупка');
    const hasDemo = html.includes('Как работает ТехЗаказ');
    assert.ok(!(hasFlow && hasDemo), 'обе секции на месте — дубль не снят');
});

test('лендинг: устаревшего «1200+ заводов» нет', () => {
    assert.doesNotMatch(read('landing.html'), /1200\+/);
});

test('разметка: JSON-LD на лендинге и категориях парсится, FAQPage на месте', () => {
    const pages = ['landing.html', ...CATEGORIES.map(c => path.join('zakupki', `${c.slug}.html`))];
    for (const rel of pages) {
        const html = read(rel);
        const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
        assert.ok(blocks.length >= 1, `${rel}: нет JSON-LD`);
        const types = [];
        for (const raw of blocks) {
            const parsed = JSON.parse(raw);
            types.push(parsed['@type']);
        }
        assert.ok(types.includes('FAQPage'), `${rel}: среди типов нет FAQPage (${types.join(', ')})`);
    }
});
```

- [ ] **Step 2: Убедиться, какие тесты падают**

Run: `node --test tests/unit/seo-content.test.js`
Expected: FAIL на объёме лендинга (сейчас 578 слов), на перелинковке, на дубле секций и на «1200+»

- [ ] **Step 3: Снять дубль секций**

В `landing.html` удалить секцию с `<h2 class="lp-demo-title" id="lp-demo-title">Как работает ТехЗаказ</h2>` целиком — вместе с её обёрткой `<section>`, стилями `lp-demo-*`, которые больше нигде не используются, и скриптами, которые обслуживают только её. Секция «Как проходит закупка» (около строки 983) остаётся: она подробнее и стоит выше.

Проверить, что удаление не оставило висящих ссылок:

Run: `node -e "const s=require('fs').readFileSync('landing.html','utf8');['lp-demo','#lp-demo-title'].forEach(k=>console.log(k, s.includes(k)?'ОСТАЛОСЬ':'чисто'))"`
Expected: обе строки — `чисто`

- [ ] **Step 4: Добавить блок «Что можно закупить»**

На место удалённой секции вставить блок с четырьмя карточками-ссылками. Заголовки и подписи берутся из `seo/categories-data.js` вручную (лендинг не генерируется, но текст должен совпадать по смыслу):

```html
    <section class="lp-cats" id="categories">
      <h2 class="lp-cats-title">Что закупают через ТехЗаказ</h2>
      <p class="lp-cats-lead">Четыре направления, по которым в каталоге больше всего производств. Заявку видят заводы с подходящим профилем, а не все подряд.</p>
      <div class="lp-cats-grid">
        <a class="lp-cat-card" href="/zakupki/rti">
          <h3>РТИ и уплотнения</h3>
          <p>Манжеты, кольца, прокладки, полиуретан и формовые изделия по чертежу узла.</p>
        </a>
        <a class="lp-cat-card" href="/zakupki/metall">
          <h3>Металлообработка</h3>
          <p>Токарные и фрезерные работы, детали на ЧПУ, поковки, отливки, сварные металлоконструкции.</p>
        </a>
        <a class="lp-cat-card" href="/zakupki/armatura">
          <h3>Трубопроводная арматура</h3>
          <p>Задвижки, шаровые краны, клапаны, затворы, фланцы и детали трубопроводов.</p>
        </a>
        <a class="lp-cat-card" href="/zakupki/elektro">
          <h3>Электрооборудование</h3>
          <p>Шкафы и щиты управления, сборки НКУ, кабельная продукция, приводы и КИП-обвязка.</p>
        </a>
      </div>
    </section>
```

Стили в блок `<style>` лендинга (плоские цвета, радиус 3px, без подъёмов на hover):

```css
  .lp-cats { max-width: 1100px; margin: 0 auto; padding: 64px 32px; }
  .lp-cats-title { font-size: 34px; font-weight: 800; letter-spacing: -.8px; margin-bottom: 10px; }
  .lp-cats-lead { font-size: 16px; line-height: 1.7; color: #4A5D6E; max-width: 680px; margin-bottom: 28px; }
  .lp-cats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .lp-cat-card { display: block; text-decoration: none; padding: 20px; background: #fff; border: 1px solid #E2E8F0; border-radius: 3px; box-shadow: 3px 3px 0 #E2E8F0; }
  .lp-cat-card:hover { border-color: #0B2233; }
  .lp-cat-card h3 { font-size: 17px; font-weight: 800; color: #071B2A; margin-bottom: 8px; }
  .lp-cat-card p { font-size: 14px; line-height: 1.65; color: #4A5D6E; }
  @media (max-width: 720px) { .lp-cats { padding: 40px 16px; } }
```

- [ ] **Step 5: Расширить FAQ и синхронизировать разметку**

В секцию FAQ (около строки 1134) добавить четыре вопроса с ответами по 3–4 предложения:

- «Сколько стоит разместить закупку?» — размещение и получение предложений бесплатны для заказчика, платные тарифы касаются расширенных возможностей поставщиков, условия на странице тарифов.
- «Кто проверяет производителей?» — верификация по ЕГРЮЛ автоматическая, плюс ручная проверка платформой; в карточке видно, какой признак стоит.
- «Что делать, если предложений мало?» — уточнить категорию и материал в заявке, продлить срок, посмотреть заводы по карте и пригласить точечно.
- «Кто отвечает за поставку?» — стороны сделки; площадка формирует договор со спецификацией и ведёт этапы, но не отвечает за исполнение.

Те же четыре вопроса добавить в `FAQPage` в JSON-LD около строки 81 — разметка должна совпадать с видимым текстом, иначе это нарушение требований поисковиков к структурированным данным.

- [ ] **Step 6: Заменить устаревшее число заводов**

Run: `node -e "const s=require('fs').readFileSync('landing.html','utf8');const m=s.match(/.{0,60}1200\+.{0,60}/g);console.log(m||'нет вхождений')"`

Каждое вхождение «1200+» заменить на «4000+» (в каталоге 4300 предприятий; округление вниз — честное).

- [ ] **Step 7: Убедиться, что тесты проходят**

Run: `node --test tests/unit/seo-content.test.js`
Expected: PASS, 6 тестов

Run: `npm run check && npm test`
Expected: обе команды с кодом 0

- [ ] **Step 8: Коммит**

```bash
git add landing.html tests/unit/seo-content.test.js
git commit -m "feat(seo): landing links to categories, drops the duplicate section"
```

---

### Task 5: Мерж и проверка на проде

**Files:** изменений кода нет.

**Interfaces:**
- Consumes: результат задач 1–4.

- [ ] **Step 1: Полный прогон**

Run: `node scripts/sync-category-pages.js && node scripts/sync-legal.js && npm run check && npm test`
Expected: синки сообщают `0 changed`, проверки и тесты проходят

- [ ] **Step 2: Убедиться, что файлы подтверждения прав не тронуты**

Run: `git diff main --stat -- yandex_3fbc490e3bd5d37d.html googleefff6b0475352b2b.html`
Expected: пустой вывод

- [ ] **Step 3: Мерж и деплой**

```bash
git checkout main
git merge --no-ff feature/category-seo -m "Merge feature/category-seo: buyer-intent category pages"
git push origin main
```

- [ ] **Step 4: Дождаться деплоя**

Run: `curl -s https://texzakaz.ru/api/health`
Expected: поле `commit` совпадает с хешем мержа

- [ ] **Step 5: Проверить страницы**

```bash
for u in /zakupki/rti /zakupki/metall /zakupki/armatura /zakupki/elektro; do
  printf "%-22s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' https://texzakaz.ru$u)"
done
```

Expected: четыре раза `200`

- [ ] **Step 6: Проверить эндпоинт заводов**

Run: `curl -s "https://texzakaz.ru/api/public/producers?category=%D0%A0%D0%A2%D0%98&limit=3"`
Expected: JSON-массив из не более трёх объектов с полями `id`, `company`, `city`, `verified`

- [ ] **Step 7: Проверить, что старый футер и мёртвые адреса ушли**

Run: `curl -s https://texzakaz.ru/zakupki/rti | grep -c "© 2024"`
Expected: `0`

Run: `curl -s https://texzakaz.ru/zakupki/rti | grep -c "legal-footer:start"`
Expected: `1`

- [ ] **Step 8: Проверить объём на живых страницах**

Run: `node -e "const{pageWordCount}=require('./scripts/sync-category-pages');fetch('https://texzakaz.ru/zakupki/rti').then(r=>r.text()).then(h=>console.log('слов:',pageWordCount(h)))"`
Expected: не меньше 600

---

## Что остаётся за рамками плана

- позиционные страницы под конкретные ГОСТ-позиции — следующий цикл со своей спекой;
- контент под интент поставщика;
- правка `getProducerCategories` и `CATEGORY_KEYWORDS` — их зовут карта и биржа мощностей;
- новые категории помимо четырёх существующих;
- закупка ссылок и внешние SEO-работы.
