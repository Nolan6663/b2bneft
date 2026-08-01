# План: глобальный проход по вёрстке и AI-слопу

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать декоративный слоп из темы и 17 публичных страниц, починить вёрстку на 390 и 1440 по снимкам, вычистить водянистые тексты.

**Architecture:** Четыре слоя снизу вверх. Тема первой (`assets/theme-v2.css`) — одна правка чинит все страницы разом и не конфликтует с постраничными. Затем остатки по страницам, затем вёрстка по снимкам прода, затем тексты. Регрессия ловится юнит-тестом со списком осознанных исключений, а не глазами.

**Tech Stack:** статические HTML + CSS, Node 20 `node:test`, Playwright (chromium, установлен), PowerShell на машине владельца.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-08-01-global-layout-slop-sweep-design.md`.
- Охват — 17 публичных страниц: `landing.html`, `zakupki.html`, `zakupki/{armatura,elektro,metall,rti}.html`, `catalog.html`, `map.html`, `supplier-public.html`, `dlya-postavshchikov.html`, `partners.html`, `tariff.html`, `delivery.html`, `privacy.html`, `terms.html`, `login.html`, `404.html`.
- Кабинет, админка, серверный код и файлы вебмастеров (`yandex_3fbc490e3bd5d37d.html`, `googleefff6b0475352b2b.html`) не трогаются.
- Категории правятся только через `seo/categories-data.js` + `npm run sync:categories`. Футер — через `scripts/legal-data.js` + `npm run sync:legal`.
- Любая правка файла с кириллицей — через `[IO.File]::WriteAllText($p, $s, [Text.UTF8Encoding]::new($false))`. Прошлая массовая замена покорёжила кодировку.
- После каждой задачи: `npm run check` и `npm test`. Базовая линия — 123 юнита, 0 падений.
- Коммит на задачу. Пуш один, в конце.

---

### Task 1: Тест-сторож на маркеры слопа + чистка теней в теме

**Files:**
- Create: `tests/unit/no-slop.test.js`
- Modify: `assets/theme-v2.css` (строки 1093, 1724, 2224, 2294, 2298, 2585, 2592)

**Interfaces:**
- Produces: `tests/unit/no-slop.test.js` с экспортируемым списком `ALLOWED` — задачи 2–4 дополняют его, а не переписывают.

- [ ] **Step 1: Написать падающий тест**

`tests/unit/no-slop.test.js`: сканирует `assets/theme-v2.css` и 17 публичных страниц регулярками маркеров, вычитает осознанные исключения, требует нуля остатка.

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const PUBLIC_PAGES = [
    'landing.html', 'zakupki.html',
    'zakupki/armatura.html', 'zakupki/elektro.html', 'zakupki/metall.html', 'zakupki/rti.html',
    'catalog.html', 'map.html', 'supplier-public.html', 'dlya-postavshchikov.html',
    'partners.html', 'tariff.html', 'delivery.html', 'privacy.html', 'terms.html',
    'login.html', '404.html',
];

// Мягкая цветная тень — маркер генерённого интерфейса. Hairline `0 1px..0 2px`
// это разделитель, а не свечение, поэтому радиус размытия ловим от 4px.
const SOFT_SHADOW = /box-shadow:\s*[^;]*?\b0\s+\d+px\s+([4-9]\d*|\d{2,})px\s+rgba/gi;
const PILL_RADIUS = /border-radius:\s*(999px|50px|30px|20px)/gi;
const GRADIENT = /linear-gradient/gi;

// Осознанные исключения: селектор или контекст, в котором маркер не слоп.
// Ключ — файл, значение — куски строк, которые пропускаем.
const ALLOWED = {
    'assets/theme-v2.css': [
        'rgba(0,0,0,0.14)',      // .toast — всплывающее уведомление, глубина оверлея
        'rgba(0,0,0,.18)',       // .kp-compare-bar и .ob-checklist — плавающие панели
        'rgba(0,0,0,.28)',       // .cp-box — модальная шторка
        'rgba(0,0,0,.14)',       // .cs-menu — выпадающий список
        'rgba(0,0,0,.32)',       // .tz-modal — диалог
        'var(--border-mid); border-radius: 20px',  // полоса прогресса
        '.skel-cell:nth-child',  // скелетоны загрузки
        'rgba(255,255,255,.05) 1px',  // чертёжная сетка
        'var(--inner-bg) 25%',   // шиммер скелетона
        'linear-gradient(90deg,', // шиммер скелетона, многострочный
        'linear-gradient(',      // шиммер скелетона, многострочный
    ],
};

function lintFile(rel) {
    const full = path.join(ROOT, rel);
    const text = fs.readFileSync(full, 'utf8');
    const allowed = ALLOWED[rel] || [];
    const hits = [];
    for (const [name, re] of [['soft-shadow', SOFT_SHADOW], ['pill-radius', PILL_RADIUS], ['gradient', GRADIENT]]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const lineStart = text.lastIndexOf('\n', m.index) + 1;
            const lineEnd = text.indexOf('\n', m.index);
            const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
            if (allowed.some(a => line.includes(a))) continue;
            const lineNo = text.slice(0, m.index).split('\n').length;
            hits.push(`${rel}:${lineNo} ${name}: ${line.slice(0, 90)}`);
        }
    }
    return hits;
}

test('тема: мягких свечений, pill-радиусов и градиентов не осталось', () => {
    const hits = lintFile('assets/theme-v2.css');
    assert.deepEqual(hits, [], 'слоп в теме:\n' + hits.join('\n'));
});

test('публичные страницы: маркеров слопа нет', () => {
    const hits = PUBLIC_PAGES.flatMap(lintFile);
    assert.deepEqual(hits, [], 'слоп на страницах:\n' + hits.join('\n'));
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test tests/unit/no-slop.test.js`
Expected: FAIL, в выводе строки 1093, 1724, 2224, 2294, 2298, 2585, 2592 и остатки по страницам.

- [ ] **Step 3: Почистить тени в теме**

| Строка | Селектор | Было | Стало |
|---|---|---|---|
| 1093 | `.kpi-card:hover` | `box-shadow: 0 4px 16px rgba(15,23,42,.1)` | `border-color: var(--text-secondary)` |
| 1724 | `.kp-rec-card` | `box-shadow: 0 10px 32px rgba(7,27,42,0.1)` | строку удалить, оранжевая рамка остаётся |
| 2224 | `.tz-modal` | `0 32px 100px rgba(0,0,0,.32), 0 0 0 1px rgba(255,106,0,.06)` | `0 32px 100px rgba(0,0,0,.32)` |
| 2294 | `.ob-checklist:hover` | `box-shadow: 0 12px 50px rgba(0,0,0,.22)` | `border-color: var(--accent)` |
| 2298 | `.ob-checklist.celebrate` | `0 12px 48px rgba(255,106,0,.22), 0 0 0 1px rgba(255,106,0,.2)` | `border-color: var(--accent)` |
| 2585 | `.kpi-row .kpi-card:first-child` | `box-shadow: 0 4px 20px rgba(11,34,51,.25) !important` | строку удалить |
| 2592 | `.kpi-row .kpi-card:first-child:hover` | `box-shadow: 0 8px 28px rgba(11,34,51,.3) !important` | `border-color: rgba(255,255,255,.35) !important` |

Анимацию `ob-celebrate` (пульс свечения) убрать целиком, состояние «выполнено» показывать цветом рамки.

Строку 1091 `transition: box-shadow .2s` заменить на `transition: border-color .2s` — иначе переход остаётся на свойстве, которого больше нет.

- [ ] **Step 4: Прогнать тест теней**

Run: `node --test tests/unit/no-slop.test.js`
Expected: первый тест зелёный (тема по теням чиста), второй ещё падает — страницы чинятся в задачах 3–4.

Если первый тест зелёный, но остались pill-радиусы — они задача 2, временно добавить их строки в `ALLOWED` нельзя: тест должен падать честно. Задачи 1 и 2 коммитятся подряд.

- [ ] **Step 5: Проверить каскад и закоммитить**

Run: `npm run check && npm test`
Expected: 123 юнита + новые падают только на страницах.

```bash
git add tests/unit/no-slop.test.js assets/theme-v2.css
git commit -m "style(theme): trade the decorative glow for border colour"
```

---

### Task 2: Радиусы в теме

**Files:**
- Modify: `assets/theme-v2.css` (строки 350, 686, 756, 1195, 1931, 3121, 3141, 3161)

**Interfaces:**
- Consumes: `tests/unit/no-slop.test.js` из задачи 1.

- [ ] **Step 1: Прогнать тест, зафиксировать список**

Run: `node --test tests/unit/no-slop.test.js`
Expected: FAIL со строками 350, 686, 756, 1195, 1931, 3121, 3141, 3161.

- [ ] **Step 2: Заменить радиусы**

| Строка | Что | Было | Стало |
|---|---|---|---|
| 350 | бейдж-счётчик | `border-radius: 20px` | `3px` |
| 686 | `.cert-tag` | `border-radius: 20px` | `3px` |
| 756 | `.cmp-input` | `border-radius: 20px` | `3px` |
| 1195 | шторка (моб.) | `border-radius: 20px 20px 0 0 !important` | `6px 6px 0 0 !important` |
| 1931 | `.cp-box` (моб.) | `border-radius: 20px 20px 0 0` | `6px 6px 0 0` |
| 3121, 3141 | шторки | `border-radius: 20px 20px 0 0` | `6px 6px 0 0` |
| 3161 | шторка | `border-radius: 20px 20px 0 0 !important` | `6px 6px 0 0 !important` |

Строки 237 (полоса прогресса) и 2440–2441 (скелетоны) не трогать — они в `ALLOWED`.

- [ ] **Step 3: Прогнать тест**

Run: `node --test tests/unit/no-slop.test.js`
Expected: первый тест (тема) зелёный целиком.

- [ ] **Step 4: Коммит**

```bash
git add assets/theme-v2.css
git commit -m "style(theme): square off the pill radii"
```

---

### Task 3: Лендинг

**Files:**
- Modify: `landing.html` (10 мягких теней, 1 pill, 11 градиентов)

- [ ] **Step 1: Собрать список**

Run:
```
Select-String -Path landing.html -Pattern 'box-shadow:\s*0\s+\d+px\s+([4-9]\d*|\d{2,})px\s+rgba|border-radius:\s*(999px|50px|30px|20px)|linear-gradient' -AllMatches
```

- [ ] **Step 2: Разобрать каждое совпадение**

Правило разбора, не список: градиент-заливка блока → плоский `var(--bg-*)`; градиент как декоративный оверлей поверх фото → удалить; градиент в маске/фейде длинного списка → оставить и внести в `ALLOWED` с комментарием, зачем. Мягкая тень на карточке → рамка `1px solid var(--card-border)`. Мягкая тень на плавающем элементе → оставить, внести в `ALLOWED`. Pill-радиус → 3px.

- [ ] **Step 3: Прогнать тест и гейт**

Run: `npm run check && npm test`
Expected: тест страниц перестал показывать `landing.html`; 123 старых юнита зелёные, включая `landing: перелинковка на все четыре категории` и `разметка: JSON-LD на лендинге`.

- [ ] **Step 4: Коммит**

```bash
git add landing.html tests/unit/no-slop.test.js
git commit -m "style(landing): drop the gradients and the card glow"
```

---

### Task 4: Остальные публичные страницы

**Files:**
- Modify: `map.html` (4 тени, 4 pill), `login.html` (4 тени, 2 градиента), `partners.html` (5 pill), `catalog.html` (1+1), `supplier-public.html` (2 pill), `tariff.html` (2 pill), `dlya-postavshchikov.html` (1 pill, 2 градиента), `delivery.html` (1 градиент)

- [ ] **Step 1: Прогнать тест**

Run: `node --test tests/unit/no-slop.test.js`
Expected: FAIL со списком по восьми файлам.

- [ ] **Step 2: Править по тому же правилу, что в задаче 3**

Страница за страницей, начиная с `map.html` — там вчера уже ломалась мобильная сетка, и правки темы задач 1–2 её зацепили.

- [ ] **Step 3: Прогнать тест и гейт**

Run: `npm run check && npm test`
Expected: оба теста-сторожа зелёные, 123 старых юнита зелёные.

- [ ] **Step 4: Коммит**

```bash
git add map.html login.html partners.html catalog.html supplier-public.html tariff.html dlya-postavshchikov.html delivery.html tests/unit/no-slop.test.js
git commit -m "style(public): finish the slop sweep on the remaining pages"
```

---

### Task 5: Снимки прода 390 и 1440

**Files:**
- Create: `scripts/shoot-pages.js`
- Create (не в git): `.shots/before/*.png`

- [ ] **Step 1: Написать скрипт съёмки**

`scripts/shoot-pages.js`: обходит список страниц, снимает полностраничный скриншот на 390 и 1440, кладёт в `.shots/<label>/<page>-<width>.png`. База — аргумент (`https://texzakaz.ru` или `http://localhost:3000`), метка — аргумент.

```js
'use strict';

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PAGES = [
    ['landing', '/'], ['zakupki', '/zakupki'],
    ['armatura', '/zakupki/armatura'], ['elektro', '/zakupki/elektro'],
    ['metall', '/zakupki/metall'], ['rti', '/zakupki/rti'],
    ['catalog', '/catalog'], ['map', '/map'],
    ['dlya-postavshchikov', '/dlya-postavshchikov'], ['partners', '/partners'],
    ['tariff', '/tariff'], ['delivery', '/delivery'],
    ['privacy', '/privacy'], ['terms', '/terms'],
    ['login', '/login'], ['404', '/no-such-page'],
];
const WIDTHS = [390, 1440];

(async () => {
    const base = (process.argv[2] || 'https://texzakaz.ru').replace(/\/$/, '');
    const label = process.argv[3] || 'shots';
    const outDir = path.join(__dirname, '..', '.shots', label);
    fs.mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch();
    for (const width of WIDTHS) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        for (const [name, route] of PAGES) {
            const url = base + route;
            try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
            } catch {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            }
            await page.waitForTimeout(800);
            await page.screenshot({ path: path.join(outDir, `${name}-${width}.png`), fullPage: true });
            const overflow = await page.evaluate(() =>
                document.documentElement.scrollWidth - document.documentElement.clientWidth);
            console.log(`${name} ${width}: ${overflow > 0 ? 'HORIZONTAL SCROLL +' + overflow + 'px' : 'ok'}`);
        }
        await ctx.close();
    }
    await browser.close();
})();
```

`supplier-public` в списке нет: страница открывается только по идентификатору поставщика, снимается отдельно по реальной ссылке из каталога.

- [ ] **Step 2: Добавить `.shots/` в `.gitignore`**

- [ ] **Step 3: Снять эталон с прода**

Run: `node scripts/shoot-pages.js https://texzakaz.ru before`
Expected: 32 файла в `.shots/before/`, в логе видно, где горизонтальный скролл.

- [ ] **Step 4: Коммит скрипта**

```bash
git add scripts/shoot-pages.js .gitignore
git commit -m "test(layout): screenshot harness for the public pages"
```

---

### Task 6: Правки вёрстки по снимкам

**Files:**
- Modify: страницы и `assets/theme-v2.css` — по факту находок

- [ ] **Step 1: Поднять локальный сервер и снять «после чистки»**

Run: `npm start`, затем `node scripts/shoot-pages.js http://localhost:3000 after-slop`
Локальная база протухшая (Render, Огайо) — карточки могут быть пустыми. Смотреть на вёрстку каркаса, контент сверять по проду.

- [ ] **Step 2: Сверить попарно, выписать находки**

Смотреть каждый снимок: горизонтальный скролл (скрипт печатает его сам), налезание текста, обрезанные кнопки, сетка в одну колонку там, где место на две, разъехавшиеся таблицы, мелкий нечитаемый шрифт. Каждая находка — строка в списке: страница, ширина, что не так.

- [ ] **Step 3: Чинить по одной, каждую подтверждать снимком**

После правки — пересъёмка только затронутой страницы, сравнение с `before`. Правка без снимка «после» не считается сделанной.

Ловушка каскада: в теме 15 объявлений с `.kpi-card` и правила на `!important`. Если правка не применяется — проверять специфичность, а не дописывать ещё один `!important` (вчерашние `5106ca8` и `ff02586` — ровно этот цикл).

- [ ] **Step 4: Контрольная пересъёмка всех страниц и кабинета**

Run: `node scripts/shoot-pages.js http://localhost:3000 after-layout`
Expected: страницы, которые не трогали, не изменились; в логе нет `HORIZONTAL SCROLL`.

- [ ] **Step 5: Гейт и коммит**

```bash
npm run check && npm test
git commit -m "fix(layout): make the public pages hold up at 390"
```

---

### Task 7: Тексты

**Files:**
- Modify: `landing.html`, `dlya-postavshchikov.html`, `partners.html`, `tariff.html`, `delivery.html`, `catalog.html`, `map.html`, `login.html`, `404.html`
- Modify (через генератор): `seo/categories-data.js` + `npm run sync:categories`

- [ ] **Step 1: Вычитать заголовки и подзаголовки**

Искать: заголовки, которые не сообщают факта («Работаем для вас»), триплеты «наших преимуществ», обещания без цифр («быстро», «надёжно», «выгодно»), канцелярит («осуществляем поставку»).

- [ ] **Step 2: Переписать на факты**

Каждое утверждение — либо проверяемое число, либо конкретное действие. Число без источника не выдумывать: тест `лендинг: устаревшего «1200+ заводов» нет` уже ловит один такой случай, второго не заводить.

Не трогать: H1 категорий, FAQ-разметку, JSON-LD, тексты `privacy.html` и `terms.html`.

- [ ] **Step 3: Пересобрать категории, если правились**

Run: `npm run sync:categories && npm run sync:legal`

- [ ] **Step 4: Гейт и коммит**

Run: `npm run check && npm test`
Expected: 123 + 2 сторожа зелёные; `seo-content` и `category-pages` не покраснели.

```bash
git commit -m "docs(copy): swap the filler claims for facts"
```

---

### Task 8: Деплой и сверка на проде

- [ ] **Step 1: Финальный прогон**

Run: `npm run check && npm test`
Expected: 0 падений.

- [ ] **Step 2: Пуш**

```bash
git push origin main
```

- [ ] **Step 3: Снять прод после деплоя**

Run: `node scripts/shoot-pages.js https://texzakaz.ru after-deploy`
Expected: совпадает с `.shots/after-layout`, в логе нет `HORIZONTAL SCROLL`.

- [ ] **Step 4: Отметить в спеке, что проход закрыт**

Дописать в `docs/superpowers/specs/2026-08-01-global-layout-slop-sweep-design.md` статус «выполнено», перечислить, что осталось на следующий заход: pill-радиусы кабинета (`assets/settings-page.css` 2, `assets/deals-page.css` 1), протухший `DATABASE_URL` в локальном `.env`.
