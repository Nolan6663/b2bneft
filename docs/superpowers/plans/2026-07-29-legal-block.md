# Юридический блок: реквизиты, политика, условия, согласие — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** опубликовать реквизиты продавца, политику обработки персданных и условия использования, сделать согласие при регистрации доказуемым.

**Architecture:** реквизиты живут в одном модуле `scripts/legal-data.js`; `scripts/sync-legal.js` раскладывает футер из `partials/footer.html` по страницам без сайдбара и подставляет реквизиты в юрстраницы; `npm run check` падает, если сгенерированное разошлось с файлами. Документы — обычные HTML-страницы, отдаются через белый список `PUBLIC_PAGES`. Согласие фиксируется двумя колонками в `users`.

**Tech Stack:** Node 20+, Express 5, PostgreSQL, ванильный JS без сборщика, `node:test` для юнит-тестов.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-07-29-legal-pages-design.md`.
- Реквизиты ровно в таком виде: `ИП Лапшина Диана Николаевна`, ИНН `650112190630`, ОГРНИП `326650000001066`, `Сахалинская обл., г. Южно-Сахалинск`, `info.texzakaz@yandex.com`. Телефон и полный адрес регистрации НЕ публикуются нигде.
- Файлы подтверждения прав `yandex_3fbc490e3bd5d37d.html` и `googleefff6b0475352b2b.html` не трогать ни при каких условиях — содержимое сверяется Яндексом и Google побайтово.
- Стиль вёрстки — «Чертёжный цех»: без `linear-gradient` в декоре, без `hover ... translateY(-`, без мягких свечений в `box-shadow`, без pill-радиусов `999px/50px/20px` на бейджах. Переменные брать из `assets/css/tokens.css`.
- Раздача статики идёт по белому списку: новая страница в корне без записи в `PUBLIC_PAGES` (`server.js:516`) отдаёт 404.
- Схема БД меняется только через `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` внизу `db.js`, отдельных миграций в проекте нет.
- Push в `main` = автодеплой на прод. Работать в ветке `feature/legal-block`, мержить в `main` осознанно.
- Проверка после деплоя: `https://texzakaz.ru/api/health` возвращает хеш задеплоенного коммита.

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `scripts/legal-data.js` (создать) | реквизиты, версия документов, список исключений для футера. Единственный источник |
| `partials/footer.html` (создать) | разметка футера с плейсхолдерами |
| `scripts/sync-legal.js` (создать) | чистые функции рендера/вставки + CLI-прогон |
| `tests/unit/legal-sync.test.js` (создать) | тесты чистых функций синка |
| `scripts/static-checks.js` (изменить) | проверка, что футер в файлах совпадает со сгенерированным |
| `privacy.html`, `terms.html` (создать) | тексты документов |
| `server.js` (изменить) | две записи в `PUBLIC_PAGES` |
| `db.js` (изменить) | две колонки в `users` |
| `routes/auth.js` (изменить) | приём и запись согласия |
| `login.html` (изменить) | чекбокс, живые ссылки, блокировка кнопки |
| `tests/unit/auth-consent.test.js` (создать) | регистрация без согласия → 400 |
| `tariff.html` (изменить) | оговорка у цен |
| `package.json` (изменить) | скрипт `sync:legal` |

---

### Task 1: Источник правды, футер и синк

**Files:**
- Create: `scripts/legal-data.js`
- Create: `partials/footer.html`
- Create: `scripts/sync-legal.js`
- Test: `tests/unit/legal-sync.test.js`
- Modify: `scripts/static-checks.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `scripts/legal-data.js` экспортирует `{ LEGAL, DOC_VERSION, FOOTER_EXCLUDE }`, где `LEGAL` — объект с ключами `orgName, inn, ogrnip, address, email`, `DOC_VERSION` — строка вида `'2026-07-29'`.
- Produces: `scripts/sync-legal.js` экспортирует `{ renderFooter(template, legal, year), applyFooter(html, footerHtml), footerPages(root), syncAll(root) }`. `renderFooter` возвращает строку, `applyFooter` возвращает строку, `footerPages` возвращает массив путей относительно корня, `syncAll` возвращает `{ changed: string[], total: number }`.
- Consumes: ничего.

- [ ] **Step 1: Создать источник данных**

Создать `scripts/legal-data.js`:

```js
'use strict';

/** Единственное место, где живут публикуемые реквизиты.
 *  Телефон и полный адрес регистрации не публикуются — решение владельца. */
const LEGAL = {
    orgName: 'ИП Лапшина Диана Николаевна',
    inn: '650112190630',
    ogrnip: '326650000001066',
    address: 'Сахалинская обл., г. Южно-Сахалинск',
    email: 'info.texzakaz@yandex.com',
};

/** Версия редакции документов. Меняется вручную при правке текстов:
 *  пишется в users.consent_version, чтобы было видно, кто на что соглашался. */
const DOC_VERSION = '2026-07-29';

/** Страницы без сайдбара, которым футер не нужен либо противопоказан.
 *  Файлы подтверждения прав вебмастеров сверяются побайтово — их правка ломает верификацию. */
const FOOTER_EXCLUDE = new Set([
    '404.html',
    'admin.html',
    'yandex_3fbc490e3bd5d37d.html',
    'googleefff6b0475352b2b.html',
]);

module.exports = { LEGAL, DOC_VERSION, FOOTER_EXCLUDE };
```

- [ ] **Step 2: Создать разметку футера**

Создать `partials/footer.html`:

```html
<footer class="tz-footer">
  <div class="tz-footer-inner">
    <div class="tz-footer-req">
      <div class="tz-footer-org">{{ORG_NAME}}</div>
      <div class="tz-footer-line">ИНН {{INN}} · ОГРНИП {{OGRNIP}}</div>
      <div class="tz-footer-line">{{ADDRESS}}</div>
      <div class="tz-footer-line"><a href="mailto:{{EMAIL}}">{{EMAIL}}</a></div>
    </div>
    <div class="tz-footer-links">
      <a href="/privacy">Политика обработки персональных данных</a>
      <a href="/terms">Условия использования</a>
    </div>
    <div class="tz-footer-copy">© {{YEAR}} ТехЗаказ</div>
  </div>
  <div class="tz-cookie" id="tzCookie" hidden>
    <span>Мы используем cookie, чтобы сайт работал и чтобы понимать, как им пользуются. Подробнее — в <a href="/privacy">политике</a>.</span>
    <button type="button" onclick="tzCookieAccept()">Понятно</button>
  </div>
  <script>
    (function () {
      try {
        if (!localStorage.getItem('tzCookieAck')) document.getElementById('tzCookie').hidden = false;
      } catch (e) { /* приватный режим — плашку не показываем */ }
    })();
    function tzCookieAccept() {
      try { localStorage.setItem('tzCookieAck', '1'); } catch (e) { /* см. выше */ }
      document.getElementById('tzCookie').hidden = true;
    }
  </script>
  <style>
    .tz-footer { border-top: 1px solid var(--inner-border); background: var(--card-bg); padding: 28px 32px; margin-top: 48px; }
    .tz-footer-inner { max-width: 1100px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 24px; justify-content: space-between; font-size: 13px; color: var(--text-secondary); }
    .tz-footer-org { font-weight: 700; color: var(--text-primary); margin-bottom: 4px; }
    .tz-footer-line { line-height: 1.7; }
    .tz-footer-links { display: flex; flex-direction: column; gap: 6px; }
    .tz-footer-links a, .tz-footer-req a { color: var(--text-secondary); text-decoration: none; border-bottom: 1px solid var(--inner-border); }
    .tz-footer-links a:hover, .tz-footer-req a:hover { color: var(--accent-bright); border-bottom-color: var(--accent-bright); }
    .tz-footer-copy { align-self: flex-end; }
    .tz-cookie { position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 900; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; max-width: 780px; margin: 0 auto; padding: 14px 18px; font-size: 13px; background: var(--card-bg); color: var(--text-secondary); border: 1px solid var(--inner-border); border-radius: 3px; box-shadow: 3px 3px 0 var(--inner-border); }
    .tz-cookie a { color: var(--accent-bright); }
    .tz-cookie button { height: 34px; padding: 0 16px; border-radius: 3px; border: 1px solid var(--accent-bright); background: var(--accent-bright); color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; }
    .tz-cookie button:active { transform: translate(1px, 1px); }
    @media (max-width: 720px) { .tz-footer { padding: 22px 16px; } }
  </style>
</footer>
```

- [ ] **Step 3: Написать падающий тест на синк**

Создать `tests/unit/legal-sync.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderFooter, applyFooter } = require('../../scripts/sync-legal');
const { LEGAL } = require('../../scripts/legal-data');

const TEMPLATE = '<footer>{{ORG_NAME}} ИНН {{INN}} ОГРНИП {{OGRNIP}} {{ADDRESS}} {{EMAIL}} © {{YEAR}}</footer>';

test('синк: плейсхолдеры заменяются реквизитами', () => {
    const html = renderFooter(TEMPLATE, LEGAL, 2026);
    assert.match(html, /ИП Лапшина Диана Николаевна/);
    assert.match(html, /650112190630/);
    assert.match(html, /326650000001066/);
    assert.match(html, /info\.texzakaz@yandex\.com/);
    assert.match(html, /© 2026/);
    assert.doesNotMatch(html, /\{\{/, 'незаменённых плейсхолдеров остаться не должно');
});

test('синк: футер вставляется перед </body>, если маркеров ещё нет', () => {
    const page = '<html><body><div>контент</div></body></html>';
    const out = applyFooter(page, '<footer>Ф</footer>');
    assert.match(out, /<!-- legal-footer:start -->[\s\S]*<footer>Ф<\/footer>[\s\S]*<!-- legal-footer:end -->/);
    assert.ok(out.indexOf('legal-footer:end') < out.indexOf('</body>'), 'футер должен быть внутри body');
});

test('синк: повторный прогон не плодит копии', () => {
    const page = '<html><body><div>контент</div></body></html>';
    const once = applyFooter(page, '<footer>Ф</footer>');
    const twice = applyFooter(once, '<footer>Ф</footer>');
    assert.equal(twice, once);
    assert.equal(twice.match(/legal-footer:start/g).length, 1);
});

test('синк: смена реквизитов заменяет старый блок, а не добавляет новый', () => {
    const page = '<html><body>текст</body></html>';
    const old = applyFooter(page, '<footer>СТАРЫЙ</footer>');
    const fresh = applyFooter(old, '<footer>НОВЫЙ</footer>');
    assert.match(fresh, /НОВЫЙ/);
    assert.doesNotMatch(fresh, /СТАРЫЙ/);
    assert.equal(fresh.match(/legal-footer:start/g).length, 1);
});

test('синк: страница без </body> не портится', () => {
    const page = '<div>фрагмент</div>';
    assert.equal(applyFooter(page, '<footer>Ф</footer>'), page);
});
```

- [ ] **Step 4: Убедиться, что тест падает**

Run: `node --test tests/unit/legal-sync.test.js`
Expected: FAIL, `Cannot find module '../../scripts/sync-legal'`

- [ ] **Step 5: Реализовать синк**

Создать `scripts/sync-legal.js`:

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { LEGAL, FOOTER_EXCLUDE } = require('./legal-data');

const ROOT = path.join(__dirname, '..');
const PARTIAL = path.join(ROOT, 'partials', 'footer.html');
const START = '<!-- legal-footer:start -->';
const END = '<!-- legal-footer:end -->';

function renderFooter(template, legal, year) {
    return template
        .replace(/\{\{ORG_NAME\}\}/g, legal.orgName)
        .replace(/\{\{INN\}\}/g, legal.inn)
        .replace(/\{\{OGRNIP\}\}/g, legal.ogrnip)
        .replace(/\{\{ADDRESS\}\}/g, legal.address)
        .replace(/\{\{EMAIL\}\}/g, legal.email)
        .replace(/\{\{YEAR\}\}/g, String(year));
}

/** Идемпотентно: первый прогон вставляет блок с маркерами перед </body>,
 *  последующие — заменяют содержимое между маркерами. */
function applyFooter(html, footerHtml) {
    const block = `${START}\n${footerHtml.trim()}\n${END}`;
    const from = html.indexOf(START);
    const to = html.indexOf(END);
    if (from !== -1 && to !== -1) {
        return html.slice(0, from) + block + html.slice(to + END.length);
    }
    const bodyEnd = html.lastIndexOf('</body>');
    if (bodyEnd === -1) return html;
    return html.slice(0, bodyEnd) + block + '\n' + html.slice(bodyEnd);
}

/** Футер идёт на страницы без сайдбара: со сайдбаром — компоновка кабинета, футер её ломает.
 *  Плюс явные исключения из legal-data.js. */
function footerPages(root) {
    const rootPages = fs.readdirSync(root)
        .filter(f => f.endsWith('.html'))
        .filter(f => !FOOTER_EXCLUDE.has(f))
        .filter(f => !fs.readFileSync(path.join(root, f), 'utf8').includes('<div class="sidebar">'));

    const catDir = path.join(root, 'zakupki');
    const catPages = fs.existsSync(catDir)
        ? fs.readdirSync(catDir).filter(f => f.endsWith('.html')).map(f => path.join('zakupki', f))
        : [];

    return [...rootPages, ...catPages].sort();
}

function syncAll(root) {
    const template = fs.readFileSync(PARTIAL, 'utf8');
    const footer = renderFooter(template, LEGAL, new Date().getFullYear());
    const pages = footerPages(root);
    const changed = [];
    for (const page of pages) {
        const file = path.join(root, page);
        const before = fs.readFileSync(file, 'utf8');
        const after = applyFooter(before, footer);
        if (after !== before) {
            fs.writeFileSync(file, after, 'utf8');
            changed.push(page);
        }
    }
    return { changed, total: pages.length };
}

module.exports = { renderFooter, applyFooter, footerPages, syncAll, START, END };

if (require.main === module) {
    const { changed, total } = syncAll(ROOT);
    console.log(`Footer synced: ${changed.length} changed of ${total} pages`);
    changed.forEach(p => console.log('  ' + p));
}
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `node --test tests/unit/legal-sync.test.js`
Expected: PASS, 5 тестов

- [ ] **Step 7: Прогнать синк и глазами проверить список страниц**

Run: `node scripts/sync-legal.js`
Expected: в списке `landing.html`, `login.html`, `zakupki.html`, `dlya-postavshchikov.html`, `supplier-public.html`, `zakupki/metall.html`, `zakupki/armatura.html`, `zakupki/elektro.html`, `zakupki/rti.html`.
Проверить, что в списке НЕТ `tariff.html`, `map.html`, `admin.html`, `404.html` и обоих файлов подтверждения прав.

Run: `git status --short`
Expected: файлы подтверждения прав в изменённых не значатся.

- [ ] **Step 8: Добавить проверку синка в static-checks**

В `scripts/static-checks.js` добавить функцию перед `function main()`:

```js
function checkLegalFooterSynced() {
  const { renderFooter, applyFooter, footerPages } = require('./sync-legal');
  const { LEGAL } = require('./legal-data');
  const template = fs.readFileSync(path.join(root, 'partials', 'footer.html'), 'utf8');
  const footer = renderFooter(template, LEGAL, new Date().getFullYear());
  const stale = footerPages(root).filter(page => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    return applyFooter(html, footer) !== html;
  });
  if (stale.length) {
    fail(`Футер разошёлся с partials/footer.html — прогони "npm run sync:legal":\n${stale.join('\n')}`);
  }
}
```

И вызов в `main()` после `checkMpaPageStyles();`:

```js
  checkLegalFooterSynced();
```

Там же добавить новые файлы в список проверяемых на синтаксис — в массив `jsFiles` (строка 10) в строку со `scripts/`:

```js
  'scripts/static-checks.js', 'scripts/mvp-api-smoke.js', 'scripts/import-registry.js', 'scripts/fetch-gisp.js',
  'scripts/legal-data.js', 'scripts/sync-legal.js',
```

- [ ] **Step 9: Добавить npm-скрипт**

В `package.json` в блок `scripts` добавить:

```json
    "sync:legal": "node scripts/sync-legal.js",
```

- [ ] **Step 10: Проверить, что гейт ловит рассинхрон**

Run: `npm run check`
Expected: `Static checks passed: ...`

Временно испортить один футер и убедиться, что проверка срабатывает:

Run: `node -e "const fs=require('fs');const f='landing.html';const s=fs.readFileSync(f,'utf8').replace('650112190630','000000000000');fs.writeFileSync(f,s)"`
Run: `npm run check`
Expected: FAIL с текстом `Футер разошёлся с partials/footer.html`

Вернуть:

Run: `node scripts/sync-legal.js`
Run: `npm run check`
Expected: PASS

- [ ] **Step 11: Коммит**

```bash
git checkout -b feature/legal-block
git add scripts/legal-data.js scripts/sync-legal.js partials/footer.html tests/unit/legal-sync.test.js scripts/static-checks.js package.json
git add landing.html login.html zakupki.html dlya-postavshchikov.html supplier-public.html zakupki
git commit -m "feat(legal): single source of truth for requisites and a synced footer"
```

---

### Task 2: Страницы политики и условий

**Files:**
- Create: `privacy.html`
- Create: `terms.html`
- Modify: `server.js:516-522` (массив `PUBLIC_PAGES`)

**Interfaces:**
- Consumes: футер из Task 1 (вставится синком), `LEGAL` и `DOC_VERSION` из `scripts/legal-data.js`.
- Produces: маршруты `/privacy` и `/terms`, на которые ссылаются футер (Task 1), чекбокс согласия (Task 3) и оговорка на тарифах (Task 5).

- [ ] **Step 1: Создать privacy.html**

Создать `privacy.html`. Каркас страницы (шапка и стили — как в `dlya-postavshchikov.html`, чтобы не расходиться со стилем публичных страниц):

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Политика обработки персональных данных — ТехЗаказ</title>
<meta name="description" content="Как ТехЗаказ обрабатывает персональные данные: какие данные собираются, зачем, кому передаются и как отозвать согласие.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="assets/theme-v2.css?v=10">
<style>
  .doc-wrap { max-width: 860px; margin: 0 auto; padding: 40px 24px 24px; }
  .doc-wrap h1 { font-size: 28px; font-weight: 800; color: var(--text-primary); margin-bottom: 6px; }
  .doc-meta { font-size: 13px; color: var(--text-muted); margin-bottom: 28px; }
  .doc-wrap h2 { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 28px 0 10px; }
  .doc-wrap p, .doc-wrap li { font-size: 14.5px; line-height: 1.75; color: var(--text-secondary); }
  .doc-wrap ul { margin: 8px 0 8px 20px; }
  .doc-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13.5px; }
  .doc-table th, .doc-table td { border: 1px solid var(--inner-border); padding: 8px 10px; text-align: left; color: var(--text-secondary); }
  .doc-table th { color: var(--text-primary); font-weight: 700; }
</style>
</head>
<body>
<div class="doc-wrap">
  <h1>Политика обработки персональных данных</h1>
  <div class="doc-meta">Редакция от 29.07.2026</div>
  <!-- разделы 1–9 из шага 2 -->
</div>
</body>
</html>
```

- [ ] **Step 2: Наполнить privacy.html разделами**

Внутрь `.doc-wrap` вместо комментария вставить разделы. Обязательный состав, реквизиты пишутся текстом (страница не проходит через плейсхолдеры футера):

1. **Оператор** — `ИП Лапшина Диана Николаевна`, ИНН `650112190630`, ОГРНИП `326650000001066`, `Сахалинская обл., г. Южно-Сахалинск`, `info.texzakaz@yandex.com`. Отдельной строкой: полный адрес регистрации предоставляется по письменному запросу на указанный email.
2. **Какие данные обрабатываются** — email, пароль в виде хеша, роль, название компании, ИНН; в профиле компании: город, телефон, сайт, ОГРН, ФИО директора, фотографии; содержимое закупок и КП, включая загружаемые файлы (чертежи, коммерческие предложения); переписка в чатах сделок; идентификатор Telegram при привязке; технические данные — IP, cookie, данные о браузере.
3. **Цели** — регистрация и вход, подбор поставщиков под закупку, обмен предложениями и документами, уведомления, формирование договора и спецификации, техподдержка, статистика посещаемости.
4. **Правовые основания** — согласие субъекта, данное при регистрации; исполнение договора, стороной которого является субъект.
5. **Передача третьим лицам** — таблица из спеки: Яндекс (Метрика, OAuth, Карты, SMTP), Telegram, GigaChat (Сбер), Sentry, Cloudflare R2, хостинг базы. Против каждого — что именно передаётся.
6. **Трансграничная передача** — прямо указать, что часть инфраструктуры (Telegram, Sentry, Cloudflare R2, хостинг базы данных) расположена за пределами РФ, и данные передаются туда в объёме, указанном в разделе 5.
7. **Сроки хранения** — до удаления аккаунта либо до отзыва согласия; данные закупок и сделок — в течение срока, необходимого для исполнения и разрешения споров.
8. **Права субъекта** — получить сведения об обработке, потребовать уточнения, блокирования или уничтожения данных, отозвать согласие. Способ: письмо на `info.texzakaz@yandex.com`, срок ответа — 30 дней.
9. **Cookie** — какие используются и зачем, что отключаются в настройках браузера.

- [ ] **Step 3: Создать terms.html**

Каркас — тот же, что в шаге 1, с заголовком «Условия использования» и описанием: `Условия использования платформы ТехЗаказ и оферта на платные тарифы.` Разделы:

1. **Термины и стороны** — платформа, заказчик, поставщик.
2. **Предмет** — площадка предоставляет доступ к сервису размещения закупок и обмена предложениями.
3. **Регистрация** — требования к данным, ответственность за достоверность, роли.
4. **Правила размещения** — запрет на недостоверные сведения, ответственность за содержание чертежей и КП.
5. **Платные тарифы** — стоимость по прайсу на странице тарифов, порядок оплаты, срок действия подписки, порядок возврата при досрочном отказе.
6. **Ограничение ответственности** — площадка не является стороной сделки между заказчиком и поставщиком, не гарантирует заключение договора и не отвечает за исполнение обязательств сторонами.
7. **Реквизиты продавца** — те же, что в разделе 1 политики.

- [ ] **Step 4: Прописать маршруты**

В `server.js` в массив `PUBLIC_PAGES` (начинается на строке 516) добавить последней строкой перед закрывающей скобкой:

```js
    'privacy.html', 'terms.html',
```

- [ ] **Step 5: Прогнать синк и проверки**

Run: `node scripts/sync-legal.js`
Expected: в изменённых появились `privacy.html` и `terms.html`

Run: `npm run check`
Expected: `Static checks passed: 26 HTML files, ...`

- [ ] **Step 6: Проверить локально, что страницы отдаются**

Поднять сервер нельзя без базы (прод-БД доступна только с VPS), поэтому проверяем маршрутизацию статикой:

Run: `node -e "const s=require('fs').readFileSync('server.js','utf8');console.log(s.includes(\"'privacy.html'\") && s.includes(\"'terms.html'\") ? 'routes ok' : 'MISSING')"`
Expected: `routes ok`

- [ ] **Step 7: Коммит**

```bash
git add privacy.html terms.html server.js
git commit -m "feat(legal): privacy policy and terms of use pages"
```

---

### Task 3: Согласие при регистрации

**Files:**
- Modify: `db.js` (блок `ALTER TABLE users`, рядом со строкой 297)
- Modify: `routes/auth.js:69-112` (обработчик `/register`) и место создания пользователя через Яндекс OAuth
- Modify: `login.html:546-553`
- Test: `tests/unit/auth-consent.test.js`

**Interfaces:**
- Consumes: `DOC_VERSION` из `scripts/legal-data.js`, маршруты `/privacy` и `/terms` из Task 2.
- Produces: колонки `users.consent_at` и `users.consent_version`; поле `consent` в теле запроса `POST /api/auth/register`.

- [ ] **Step 1: Добавить колонки в схему**

В `db.js` рядом с остальными `ALTER TABLE users` (строка 297) добавить:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_version TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 2: Написать падающий тест**

Создать `tests/unit/auth-consent.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuthRouter = require('../../routes/auth');
const { fakePool, serve, baseDeps } = require('./helpers');

function authRouter() {
    const deps = baseDeps({ pool: fakePool([]) });
    return createAuthRouter(deps);
}

test('регистрация: без согласия — 400, до обращения к базе', async () => {
    const srv = await serve('/api/auth', authRouter());
    try {
        const res = await srv.request('/api/auth/register', {
            method: 'POST',
            body: { email: 'a@b.ru', password: 'password1', company: 'ООО Тест', role: 'customer' },
        });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /соглас/i);
    } finally { await srv.close(); }
});

test('регистрация: consent=false трактуется как отсутствие согласия', async () => {
    const srv = await serve('/api/auth', authRouter());
    try {
        const res = await srv.request('/api/auth/register', {
            method: 'POST',
            body: { email: 'a@b.ru', password: 'password1', company: 'ООО Тест', role: 'customer', consent: false },
        });
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `node --test tests/unit/auth-consent.test.js`
Expected: FAIL — приходит не 400 (запрос уходит в `fakePool` и падает на непредусмотренном SQL)

- [ ] **Step 4: Принять согласие в обработчике регистрации**

В `routes/auth.js` в начало файла добавить импорт:

```js
const { DOC_VERSION } = require('../scripts/legal-data');
```

В обработчике `/register` строку 71 заменить на:

```js
            const { email, password, company, inn, role, consent } = req.body;
```

Сразу после проверки роли (после строки 74) добавить:

```js
            if (consent !== true) {
                return res.status(400).json({ error: 'Требуется согласие на обработку персональных данных' });
            }
```

В `INSERT INTO users` (строка 111) добавить две колонки:

```js
                const { rows: [u] } = await client.query(
                    'INSERT INTO users (email,password,role,company,inn,team_role,consent_at,consent_version) VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7) RETURNING *',
                    [email, hashPassword(password), resolvedRole, resolvedCompany, normInn.length === 10 || normInn.length === 12 ? normInn : (inn || ''), resolvedTeamRole, DOC_VERSION]
                );
```

- [ ] **Step 5: Зафиксировать согласие и при входе через Яндекс**

Найти место, где OAuth-колбэк создаёт нового пользователя:

Run: `node -e "require('fs').readFileSync('routes/auth.js','utf8').split('\n').forEach((l,i)=>{if(l.includes('INSERT INTO users'))console.log((i+1)+': '+l.trim())})"`
Expected: две строки — одна из обработчика `/register` (правится в шаге 4), вторая из OAuth-колбэка

В том `INSERT`, что относится к OAuth, добавить те же две колонки со значениями `NOW()` и `DOC_VERSION`. Согласие при этом даётся текстом на экране входа (шаг 7).

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `node --test tests/unit/auth-consent.test.js`
Expected: PASS, 2 теста

Run: `npm test`
Expected: 40+ тестов, 0 падений

- [ ] **Step 7: Заменить фразу на чекбокс в форме**

В `login.html` заменить блок строк 546-553 на:

```html
      <label class="consent-row">
        <input type="checkbox" id="registerConsent" onchange="updateRegisterEnabled()">
        <span>Я согласен на <a href="/privacy" target="_blank" rel="noopener">обработку персональных данных</a> и принимаю <a href="/terms" target="_blank" rel="noopener">условия использования</a></span>
      </label>

      <button class="btn-primary" id="registerSubmit" onclick="handleRegister()" disabled>
        Создать аккаунт
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
```

В блок стилей страницы добавить:

```css
    .consent-row { display: flex; gap: 10px; align-items: flex-start; margin: 14px 0 12px; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary); cursor: pointer; }
    .consent-row input { margin-top: 2px; width: 16px; height: 16px; accent-color: var(--accent-bright); flex-shrink: 0; }
    .consent-row a { color: var(--accent-bright); }
    #registerSubmit:disabled { opacity: .55; cursor: not-allowed; }
```

В скриптовый блок страницы добавить функцию:

```js
  function updateRegisterEnabled() {
    const box = document.getElementById('registerConsent');
    const btn = document.getElementById('registerSubmit');
    if (box && btn) btn.disabled = !box.checked;
  }
```

- [ ] **Step 8: Отправлять флаг на сервер**

В `login.html` в теле функции `handleRegister` в объект `JSON.stringify` (строка 784) добавить поле:

```js
      body: JSON.stringify({ email, password, company, inn, role, consent: true, inviteToken: _pendingInviteToken || undefined }),
```

Перед отправкой добавить страховку на случай обхода `disabled`:

```js
  if (!document.getElementById('registerConsent')?.checked) { showError('Подтвердите согласие на обработку персональных данных'); return; }
```

Вставить эту строку сразу после существующей проверки длины пароля (строка 775).

- [ ] **Step 9: Добавить текст согласия к входу через Яндекс**

Под кнопкой входа через Яндекс добавить строку:

```html
      <div class="terms">Продолжая вход через Яндекс, вы соглашаетесь с <a href="/privacy" target="_blank" rel="noopener">политикой обработки персональных данных</a> и <a href="/terms" target="_blank" rel="noopener">условиями использования</a></div>
```

- [ ] **Step 10: Проверки**

Run: `npm run check`
Expected: `Static checks passed`

Run: `npm test`
Expected: 0 падений

- [ ] **Step 11: Коммит**

```bash
git add db.js routes/auth.js login.html tests/unit/auth-consent.test.js
git commit -m "feat(legal): explicit consent checkbox recorded on registration"
```

---

### Task 4: Оговорка на тарифах

**Files:**
- Modify: `tariff.html` (рядом с рендером цены, строки 412-414)

**Interfaces:**
- Consumes: маршрут `/terms` из Task 2.
- Produces: ничего.

- [ ] **Step 1: Добавить строку под карточками тарифов**

В `tariff.html` найти контейнер, в который рендерятся карточки планов, и сразу после него добавить:

```html
<div class="tariff-offer-note">Информация о тарифах носит справочный характер и не является публичной офертой (ст. 437 ГК РФ). Условия оказания услуг — в <a href="/terms">условиях использования</a>.</div>
```

В блок стилей страницы добавить:

```css
    .tariff-offer-note { max-width: 720px; margin: 18px auto 0; font-size: 12.5px; line-height: 1.65; color: var(--text-muted); text-align: center; }
    .tariff-offer-note a { color: var(--text-secondary); }
```

- [ ] **Step 2: Проверка**

Run: `npm run check`
Expected: `Static checks passed`

- [ ] **Step 3: Коммит**

```bash
git add tariff.html
git commit -m "feat(legal): offer disclaimer next to tariff prices"
```

---

### Task 5: Мерж и проверка на проде

**Files:** нет изменений кода.

**Interfaces:**
- Consumes: результат задач 1-4.

- [ ] **Step 1: Полный прогон перед мержем**

Run: `npm run check && npm test`
Expected: обе команды с кодом 0

- [ ] **Step 2: Убедиться, что файлы подтверждения прав не тронуты**

Run: `git diff main --stat -- yandex_3fbc490e3bd5d37d.html googleefff6b0475352b2b.html`
Expected: пустой вывод

- [ ] **Step 3: Мерж и деплой**

```bash
git checkout main
git merge feature/legal-block
git push origin main
```

- [ ] **Step 4: Дождаться деплоя**

Run: `curl -s https://texzakaz.ru/api/health`
Expected: поле `commit` совпадает с хешем последнего коммита

- [ ] **Step 5: Проверить страницы на проде**

Run: `curl -s -o /dev/null -w "%{http_code}\n" https://texzakaz.ru/privacy`
Expected: `200`

Run: `curl -s -o /dev/null -w "%{http_code}\n" https://texzakaz.ru/terms`
Expected: `200`

Run: `curl -s https://texzakaz.ru/ | grep -c "326650000001066"`
Expected: `1` — ОГРНИП виден в футере лендинга

- [ ] **Step 6: Проверить, что подтверждение прав не сломалось**

Run: `curl -s https://texzakaz.ru/yandex_3fbc490e3bd5d37d.html`
Expected: `Verification: 3fbc490e3bd5d37d`

Run: `curl -s https://texzakaz.ru/googleefff6b0475352b2b.html`
Expected: `google-site-verification: googleefff6b0475352b2b.html`

- [ ] **Step 7: Проверить регистрацию вручную**

В браузере открыть `https://texzakaz.ru/login`, вкладка регистрации:
- кнопка «Создать аккаунт» неактивна, пока не отмечен чекбокс;
- ссылки в чекбоксе открывают `/privacy` и `/terms`;
- регистрация тестового аккаунта проходит.

Затем на VPS убедиться, что согласие записалось:

```
psql "$DATABASE_URL" -c "SELECT email, consent_at, consent_version FROM users ORDER BY id DESC LIMIT 1;"
```

Expected: непустые `consent_at` и `consent_version = '2026-07-29'`

---

## Что остаётся за рамками плана

- перенос базы и файлов в РФ (риск локализации по ст. 18 ч. 5 ФЗ-152) — отдельная спека;
- уведомление в Роскомнадзор об обработке персданных — действие владельца;
- вычитка текстов юристом — отдельным коммитом после публикации;
- расширение контента лендинга под SEO — отдельный цикл.
