# «Чертёжный цех» — распространение идентичности (кабинет, публичные страницы, PDF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Распространить визуальную идентичность v3 «Чертёжный цех» (токены уже в `assets/theme-v2.css`, см. `docs/design/texzakaz-visual-identity.md`) с лендинга на ядро кабинета (index, producer, proposals), login, публичный реестр zakupki и PDF-экспорты, чтобы платформа не выглядела как шаблонный AI-дизайн.

**Architecture:** Только CSS-компоненты поверх существующей разметки + точечные замены HTML-фрагментов; никаких новых страниц, роутов или библиотек. Новые классы с префиксом `tz-` живут в `theme-v2.css` рядом с блоком токенов «TZ VISUAL IDENTITY v3». PDF получает embedded-шрифт (чинит кириллицу — встроенный Helvetica в pdfkit не поддерживает кириллицу вообще) и чертёжный title-block на каждой странице.

**Tech Stack:** Vanilla JS/HTML/CSS (без фреймворков), pdfkit (server-side PDF), существующие токены `--tz-*` из `assets/theme-v2.css:81-105`.

## Global Constraints

- Новые шрифты/библиотеки/Tailwind — запрещено (hard rule дизайн-дока). Исключение: TTF-файлы JetBrains Mono для server-side PDF (тот же шрифт, что уже используется на фронте как woff2).
- Существующие CSS-переменные не переопределять — только дополнять.
- Crop-marks (угловые засечки) — максимум одна группа на экран.
- `backdrop-filter: blur` не добавлять (анти-паттерн из дизайн-дока).
- Тёмную тему не трогать (вне скоупа по решению пользователя 02.07.2026).
- Все ID элементов, в которые пишет JS (`anaMonth`, `crmSent` и т.п.), сохраняются как есть.
- После каждой задачи: `npm run check` → `Static checks passed`.
- Коммиты локальные. **`git push` НЕ делать** — push в `main` автодеплоит на прод (GitHub Actions → pm2). Деплой — решение пользователя.
- Валюта/тексты статусов с бэкенда не менять — только их отображение.

---

### Task 1: Статусы-штампы `.tz-stamp` (единый компонент)

**Files:**
- Modify: `assets/theme-v2.css` (после строки ~105, конец блока токенов TZ)
- Modify: `assets/app.js` (глобальные хелперы, рядом с `escapeHtml`)
- Modify: `index.html:179`, `index.html:1062-1066`, `index.html:1162`
- Modify: `producer.html:680-685` (блок `statusIcon`/`cls` в таблице «Мои КП»)
- Modify: `proposals.html:216-219`, `proposals.html:291`, `proposals.html:316`

**Interfaces:**
- Produces: `tzStampClass(status)` → строка `"tz-stamp tz-stamp--<mod>"`; `tzStampHtml(status)` → строка `<span class="tz-stamp tz-stamp--<mod>">…</span>`. Глобальные функции в `assets/app.js` (все страницы кабинета его подключают). Модификаторы: `open|won|waiting|closed|rejected|muted`.

- [ ] **Step 1: Проверить, что нужные токены существуют**

Run: `grep -n "tz-graphite\|tz-verified-green\|tz-blueprint-blue\|tz-mono-tracking" assets/theme-v2.css`
Expected: строки в блоке `:root` (~87–104). Если какого-то токена нет — добавить в тот же `:root` по таблице из `docs/design/texzakaz-visual-identity.md` (`--tz-graphite: var(--text-tertiary);` и т.д.).

- [ ] **Step 2: Добавить CSS компонента в `assets/theme-v2.css`**

Вставить сразу после закрывающей `}` блока токенов TZ (~строка 105):

```css
/* ── TZ COMPONENT: status stamp («оттиск») ─────────────────────────── */
.tz-stamp {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px; font-weight: 700;
  letter-spacing: var(--tz-mono-tracking);
  text-transform: uppercase;
  line-height: 1;
  padding: 5px 8px 4px;
  border: 1.5px solid currentColor;
  border-radius: 3px;
  color: var(--tz-graphite);
  background: transparent;
  white-space: nowrap;
}
.tz-stamp--open     { color: var(--tz-verified-green); }
.tz-stamp--won      { color: var(--tz-verified-green); }
.tz-stamp--waiting  { color: var(--tz-blueprint-blue); }
.tz-stamp--closed   { color: var(--tz-graphite); }
.tz-stamp--rejected { color: var(--error); }
.tz-stamp--muted    { color: var(--text-muted); }
```

- [ ] **Step 3: Добавить хелперы в `assets/app.js`**

Рядом с `escapeHtml` (глобальная область, не внутри DOMContentLoaded):

```js
// TZ identity: статус как «штамп» (см. docs/design/texzakaz-visual-identity.md)
const TZ_STATUS_MOD = {
  'Открыта': 'open',
  'Закрыта': 'closed',
  'Отменена': 'muted',
  'Выигран': 'won',
  'Победитель': 'won',
  'Отклонен': 'rejected',
  'Отклонено': 'rejected',
  'Ждет ответа': 'waiting',
  'Ожидает ответа': 'waiting',
  'На рассмотрении': 'waiting',
  'Отозвана заказчиком': 'muted'
};
function tzStampClass(status) {
  return 'tz-stamp tz-stamp--' + (TZ_STATUS_MOD[status] || 'muted');
}
function tzStampHtml(status) {
  return `<span class="${tzStampClass(status)}">${escapeHtml(status || '—')}</span>`;
}
```

- [ ] **Step 4: Применить в `index.html`**

Строка 1062 — удалить вычисление `statusCls` (переменная `isLocked` на 1061 остаётся!). Строка 1066:

```js
// было:
const statusPill = `<span class="status-dot status-pill ${statusCls}">${escapeHtml(order.status)}</span>`;
// стало:
const statusPill = tzStampHtml(order.status);
```

Строка 179: `class="status-dot status-pill open"` → `class="tz-stamp tz-stamp--open"` (id `detPanelStatus` не трогать).

Строка 1162: `statusEl.className = 'status-dot status-pill ' + statusCls;` → `statusEl.className = tzStampClass(order.status);` (если `statusCls` там вычислялась локально — удалить вычисление).

- [ ] **Step 5: Применить в `producer.html` (строки ~680–685)**

Удалить логику `icon`/`cls` (включая `else if (prop.status !== 'Выигран') { icon = '⏱'; cls = 'waiting'; }` — это остаток от emoji-спринта). В `row.innerHTML` заменить:

```js
// было:
<td><span class="status-icon ${cls}">${icon} ${escapeHtml(prop.status)}</span></td>
// стало:
<td>${tzStampHtml(prop.status)}</td>
```

- [ ] **Step 6: Применить в `proposals.html`**

Удалить функцию `statusIcon` (строки 216–219). Строки 291 и 316:

```js
// было:
<td><span class="status-icon ${cls}">${icon} ${escapeHtml(p.status)}</span></td>
// стало:
<td>${tzStampHtml(p.status)}</td>
```

Удалить строки `const { icon, cls } = statusIcon(p.status);` (275 и 316-соседняя) — `isEditable` рядом оставить.

- [ ] **Step 7: Проверка**

Run: `npm run check`
Expected: `Static checks passed`. Затем `grep -rn "statusIcon\|status-pill" index.html producer.html proposals.html` — не должно остаться использований в JS-шаблонах (CSS-классы в theme-v2.css остаются, их используют другие места — не чистить в этой задаче).

Визуально: открыть `index.html` через локальный статик-сервер (`npx http-server -p 8080`, `http://localhost:8080/index.html` — на localhost включаются мок-данные `shouldUseMockData()`): статусы в списке закупок — моноширинные «штампы» в рамке, не пилюли с точкой.

- [ ] **Step 8: Commit**

```bash
git add assets/theme-v2.css assets/app.js index.html producer.html proposals.html
git commit -m "feat(ui): статусы как tz-stamp — единый штамп-компонент вместо пилюль"
```

---

### Task 2: Spec-strip вместо KPI-карточек (index + producer) + mono-номера заявок

**Files:**
- Modify: `assets/theme-v2.css` (после блока `.tz-stamp` из Task 1)
- Modify: `index.html:33` (inline-стиль), `index.html:106-127` (`#analyticsRow`)
- Modify: `producer.html:196-229` (`#crmFunnel`)

**Interfaces:**
- Consumes: токены `--tz-mono-tracking`, `--card-bg`, `--card-border` (существуют).
- Produces: CSS-классы `.tz-spec-strip`, `.tz-spec-label`, `.tz-spec-row`, `.tz-spec-field`, `.tz-spec-num`, `.tz-spec-unit`, `.tz-spec-div` — переиспользуются в будущем на других страницах кабинета.

- [ ] **Step 1: Убедиться, что JS пишет в KPI только textContent**

Run: `grep -n "anaMonth\|anaActive\|anaDays\|anaSavings" index.html` и `grep -n "crmLeads\|crmSent\|crmActive\|crmConversion\|crmWon" producer.html`
Expected: кроме разметки — только присваивания вида `document.getElementById('anaMonth').textContent = …`. Если найдётся обращение к `.kpi-*` классам из JS — остановиться и адаптировать (заменить селектор на новый класс).

- [ ] **Step 2: CSS в `assets/theme-v2.css`**

```css
/* ── TZ COMPONENT: spec strip (сводка-«спецификация» вместо KPI-карт) ─ */
.tz-spec-strip {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 14px;
  padding: 14px 20px 16px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(15,23,42,.07);
}
.tz-spec-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px; font-weight: 700;
  letter-spacing: 2px; text-transform: uppercase;
  color: var(--text-muted); margin-bottom: 10px;
}
.tz-spec-row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.tz-spec-field { display: flex; align-items: baseline; gap: 7px; }
.tz-spec-num {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 800; font-size: 22px;
  letter-spacing: -0.3px; color: var(--text-primary);
}
.tz-spec-unit { font-size: 12px; color: var(--text-secondary); font-weight: 600; }
.tz-spec-div { width: 1px; height: 16px; background: var(--card-border); flex-shrink: 0; }
@media (max-width: 720px) {
  .tz-spec-row { gap: 12px; }
  .tz-spec-num { font-size: 18px; }
}

/* mono-номер заявки в списке и мобильной карточке */
.proc-row-num, .omc-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px; font-weight: 600;
  letter-spacing: var(--tz-mono-tracking);
  text-transform: uppercase;
  color: var(--text-muted);
}
```

Перед добавлением: `grep -n "\.proc-row-num\|\.omc-num" assets/theme-v2.css`. Если правила уже существуют — не дублировать селектор, а дополнить существующие правила недостающими свойствами (`font-family`, `letter-spacing`, `text-transform`).

- [ ] **Step 3: Заменить `#analyticsRow` в `index.html` (строки 106–127)**

Весь блок `<div class="kpi-row" id="analyticsRow">…</div>` заменить на:

```html
<div class="tz-spec-strip" id="analyticsRow">
    <div class="tz-spec-label">Сводка · Закупки компании</div>
    <div class="tz-spec-row">
        <span class="tz-spec-field"><span class="tz-spec-num" id="anaMonth">—</span><span class="tz-spec-unit">размещено за всё время</span></span>
        <span class="tz-spec-div" aria-hidden="true"></span>
        <span class="tz-spec-field"><span class="tz-spec-num" id="anaActive">—</span><span class="tz-spec-unit">активных · ждут КП</span></span>
        <span class="tz-spec-div" aria-hidden="true"></span>
        <span class="tz-spec-field"><span class="tz-spec-num" id="anaDays">—</span><span class="tz-spec-unit">дней средний отклик</span></span>
        <span class="tz-spec-div" aria-hidden="true"></span>
        <span class="tz-spec-field"><span class="tz-spec-num" id="anaSavings">—</span><span class="tz-spec-unit">экономия vs рынок</span></span>
    </div>
</div>
```

Удалить строку 33 (inline-правило `.kpi-row .kpi-card::after { display: none !important; }`) — kpi-row на этой странице больше нет.

- [ ] **Step 4: Заменить `#crmFunnel` в `producer.html` (строки 196–229)**

Весь блок `<div class="kpi-row" id="crmFunnel">…</div>` заменить на:

```html
<div class="tz-spec-strip" id="crmFunnel">
    <div class="tz-spec-label">Сводка · КП поставщика</div>
    <div class="tz-spec-row">
        <span class="tz-spec-field"><span class="tz-spec-num" id="crmLeads">—</span><span class="tz-spec-unit">активных закупок на рынке</span></span>
        <span class="tz-spec-div" aria-hidden="true"></span>
        <span class="tz-spec-field"><span class="tz-spec-num" id="crmSent">—</span><span class="tz-spec-unit">КП отправлено</span></span>
        <span class="tz-spec-div" aria-hidden="true"></span>
        <span class="tz-spec-field"><span class="tz-spec-num" id="crmActive">—</span><span class="tz-spec-unit">ожидают ответа</span></span>
        <span class="tz-spec-div" aria-hidden="true"></span>
        <span class="tz-spec-field"><span class="tz-spec-num" id="crmConversion">—</span><span class="tz-spec-unit">конверсия · выиграно <span id="crmWon">—</span></span></span>
    </div>
</div>
```

Внимание: JS мог красить `crmConversion` инлайн (`style="color:var(--accent-green)"` была в старой разметке) — цвет теперь задаёт `.tz-spec-num`; инлайн-стили из старой разметки не переносить.

- [ ] **Step 5: Проверка**

Run: `npm run check` → `Static checks passed`.
Визуально (`http://localhost:8080/index.html`, mock-данные): вместо четырёх карточек — одна строка-«спецификация» с mono-цифрами и разделителями; номера `ЗК-00001` в списке — моноширинные, uppercase. `producer.html` — аналогично.

- [ ] **Step 6: Commit**

```bash
git add assets/theme-v2.css index.html producer.html
git commit -m "feat(ui): KPI-карточки index/producer заменены на tz-spec-strip, mono-номера заявок"
```

---

### Task 3: login.html — идентичность первой транзакции

**Files:**
- Modify: `login.html` (внутренний `<style>` — блок `.auth-box` ~строка 129; разметка форм ~строки 404–440; `<head>`)

**Interfaces:**
- Consumes: ничего из theme-v2 (login.html — самостоятельная страница со своими стилями и хардкод-цветами `#5B7184`/`#F7FAFC` — следуем её локальному стилю).

- [ ] **Step 1: Подключить fonts.css**

Run: `grep -n "fonts.css" login.html`
Expected: пусто (проверено 02.07.2026). Добавить в `<head>` рядом с остальными `<link>`:

```html
<link rel="stylesheet" href="/assets/fonts.css">
```

- [ ] **Step 2: CSS в `<style>` login.html**

После существующего правила `.auth-box { width: 100%; max-width: 480px; }` (строка ~129–131) — изменить его и добавить:

```css
.auth-box {
  width: 100%; max-width: 480px;
  position: relative;
  padding: 18px;
}
/* Чертёжные crop-marks — одна группа на экран (hard rule дизайн-дока) */
.auth-box::before, .auth-box::after {
  content: ''; position: absolute;
  width: 14px; height: 14px;
  pointer-events: none;
}
.auth-box::before { top: 0; left: 0; border-top: 2px solid #C3D0DA; border-left: 2px solid #C3D0DA; }
.auth-box::after  { bottom: 0; right: 0; border-bottom: 2px solid #C3D0DA; border-right: 2px solid #C3D0DA; }

.auth-eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px; font-weight: 700;
  letter-spacing: 2px; text-transform: uppercase;
  color: #5B7184; margin-bottom: 10px;
}
```

- [ ] **Step 3: Eyebrow в обеих формах**

В `#form-login` перед `<div class="form-title">С возвращением</div>` (строка ~414):

```html
<div class="auth-eyebrow">ТехЗаказ · Вход в кабинет</div>
```

В `#form-register` перед его `form-title` (найти по `grep -n "form-register" login.html`):

```html
<div class="auth-eyebrow">ТехЗаказ · Регистрация компании</div>
```

- [ ] **Step 4: Проверка**

Run: `npm run check` → `Static checks passed`.
Визуально `http://localhost:8080/login.html`: L-засечки в верхнем-левом и нижнем-правом углах карточки, mono-eyebrow над заголовком, оба таба (Войти/Регистрация), мобильная ширина ≤540px не ломается (там `.auth-box { max-width: 100%; }` — засечки останутся по углам, это ок).

- [ ] **Step 5: Commit**

```bash
git add login.html
git commit -m "feat(ui): login — чертёжные crop-marks и mono-eyebrow, подключён fonts.css"
```

---

### Task 4: PDF — кириллический шрифт + чертёжная рамка с title-block

Контекст для исполнителя: pdfkit со встроенными шрифтами (`Helvetica`) использует WinAnsi-кодировку — **кириллица в текущих PDF битая**. Это одновременно багфикс и перенос идентичности: весь PDF в JetBrains Mono (кириллица есть), рамка по периметру + «основная надпись» (title-block, как на чертежах по ГОСТ 2.104) внизу справа на каждой странице.

**Files:**
- Create: `assets/fonts/pdf/JetBrainsMono-Regular.ttf`, `assets/fonts/pdf/JetBrainsMono-Bold.ttf`, `assets/fonts/pdf/OFL.txt`
- Create: `scripts/pdf-smoke.js`
- Modify: `export-pdf.js`

**Interfaces:**
- Consumes: `module.exports = { buildOrdersPdf, buildProposalsPdf, buildCompareKpPdf }` (`export-pdf.js:118`) — сигнатуры функций НЕ меняются (их вызывает `server.js`).
- Produces: зарегистрированные имена шрифтов `'TZ'` и `'TZ-Bold'` внутри `export-pdf.js`; внутренний хелпер `drawTitleBlocks(doc, meta)`.

- [ ] **Step 1: Скачать шрифты (Bash)**

```bash
mkdir -p assets/fonts/pdf
curl -L -o assets/fonts/pdf/JetBrainsMono-Regular.ttf https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Regular.ttf
curl -L -o assets/fonts/pdf/JetBrainsMono-Bold.ttf https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Bold.ttf
curl -L -o assets/fonts/pdf/OFL.txt https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt
ls -la assets/fonts/pdf
```

Expected: оба .ttf > 100 КБ. Если < 10 КБ — скачался HTML-редирект, проверить URL.

- [ ] **Step 2: Написать smoke-тест `scripts/pdf-smoke.js` (сначала — он упадёт/покажет старое поведение)**

```js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildOrdersPdf } = require('../export-pdf.js');

const outPath = path.join(os.tmpdir(), 'tz-pdf-smoke.pdf');
const out = fs.createWriteStream(outPath);
out.setHeader = () => {};
out.status = () => out;

buildOrdersPdf([{
  id: 1,
  title: 'Тест: Уплотнение РТИ DN150 ГОСТ 9833-73',
  category: 'РТИ и уплотнения',
  status: 'Открыта',
  deadline: '2026-07-10',
  proposals: 2,
  created_at: new Date().toISOString()
}], out);

out.on('finish', () => {
  const size = fs.statSync(outPath).size;
  console.log('PDF written:', outPath, size, 'bytes');
  // с embedded-шрифтом файл заметно больше 20КБ; со встроенным Helvetica — ~2-3КБ
  process.exit(size > 20000 ? 0 : 1);
});
```

Run: `node scripts/pdf-smoke.js`
Expected СЕЙЧАС: exit 1 (маленький файл, Helvetica) — это «красный» тест.

- [ ] **Step 3: Правки `export-pdf.js`**

Вверху файла после `const PDFDocument = require('pdfkit');`:

```js
const path = require('path');
const FONT_DIR = path.join(__dirname, 'assets', 'fonts', 'pdf');
const TZ_INK = '#071B2A';
const TZ_GRAPHITE = '#475569';
```

Заменить `pipePdf` целиком:

```js
function pipePdf(res, filename, build, meta = {}) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.registerFont('TZ', path.join(FONT_DIR, 'JetBrainsMono-Regular.ttf'));
  doc.registerFont('TZ-Bold', path.join(FONT_DIR, 'JetBrainsMono-Bold.ttf'));
  doc.font('TZ');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  doc.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  doc.pipe(res);
  build(doc);
  drawTitleBlocks(doc, meta);
  doc.end();
}

// Рамка листа + «основная надпись» (title-block) на каждой странице
function drawTitleBlocks(doc, meta) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const W = doc.page.width, H = doc.page.height;
    doc.save();
    doc.lineWidth(0.8).strokeColor(TZ_INK).rect(20, 20, W - 40, H - 40).stroke();
    const bw = 250, bh = 42, x = W - 20 - bw, y = H - 20 - bh;
    doc.lineWidth(0.8).rect(x, y, bw, bh).stroke();
    doc.moveTo(x, y + 21).lineTo(x + bw, y + 21).stroke();
    doc.moveTo(x + 130, y).lineTo(x + 130, y + bh).stroke();
    doc.font('TZ-Bold').fontSize(7.5).fillColor(TZ_INK)
      .text('ТЕХЗАКАЗ · TEXZAKAZ.RU', x + 8, y + 8, { width: 116, lineBreak: false });
    doc.font('TZ').fontSize(7).fillColor(TZ_GRAPHITE)
      .text(meta.docNo || 'ОТЧЁТ', x + 138, y + 8, { width: bw - 146, lineBreak: false })
      .text(new Date().toLocaleDateString('ru-RU'), x + 8, y + 29, { width: 116, lineBreak: false })
      .text(`ЛИСТ ${i - range.start + 1} / ${range.count}`, x + 138, y + 29, { width: bw - 146, lineBreak: false });
    doc.restore();
  }
}
```

Во всём файле заменить имена шрифтов: `doc.font('Helvetica-Bold')` → `doc.font('TZ-Bold')`, `doc.font('Helvetica')` → `doc.font('TZ')` (строки 43-44, 68-69, 100, 102, 111-112 + все прочие вхождения: `grep -n "Helvetica" export-pdf.js` после замены должен быть пуст).

В трёх builder-функциях передать meta четвёртым аргументом `pipePdf`:
- `buildOrdersPdf`: `pipePdf(res, \`zakupki-${Date.now()}.pdf\`, (doc) => {…}, { docNo: 'РЕЕСТР ЗАКУПОК' })`
- `buildProposalsPdf`: `{ docNo: 'РЕЕСТР КП' }`
- `buildCompareKpPdf`: `{ docNo: 'СРАВНЕНИЕ КП' }`

Порог переноса страницы `if (doc.y > 720)` оставить (title-block начинается на y≈780, не пересекаются).

- [ ] **Step 4: Прогнать smoke**

Run: `node scripts/pdf-smoke.js`
Expected: `PDF written: … bytes`, exit 0 (>20000 байт — шрифт встроен).
Открыть файл из `%TEMP%\tz-pdf-smoke.pdf` глазами: кириллица читаемая (не кракозябры), рамка по периметру, title-block внизу справа с «ТЕХЗАКАЗ · TEXZAKAZ.RU / РЕЕСТР ЗАКУПОК / дата / ЛИСТ 1 / 1».

- [ ] **Step 5: `npm run check` и Commit**

Run: `npm run check` → `Static checks passed`.

```bash
git add export-pdf.js scripts/pdf-smoke.js assets/fonts/pdf/
git commit -m "feat(pdf): JetBrains Mono TTF (фикс кириллицы) + чертёжная рамка и title-block"
```

---

### Task 5: zakupki.html — публичный реестр как «ведомость»

**Files:**
- Modify: `zakupki.html` (внутренний `<style>` ~строки 130–155; разметка ~строка 258–260; `renderOrders` ~строки 297–335)

**Interfaces:**
- Consumes: `/assets/fonts.css` уже подключён (`zakupki.html:32`); `o.id` доступен в `renderOrders` (используется в `FAKE_COMPANIES[o.id % …]`).

- [ ] **Step 1: CSS в `<style>` zakupki.html**

Рядом с `.zk-card` (строка ~133):

```css
.zk-registry-head {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px; font-weight: 700;
  letter-spacing: 2px; text-transform: uppercase;
  color: #64748B;
  border-top: 1px solid rgba(7,27,42,.14);
  border-bottom: 1px solid rgba(7,27,42,.14);
  padding: 9px 2px;
  margin: 0 0 14px;
}
.zk-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px; font-weight: 700;
  letter-spacing: 1.5px;
  color: #64748B;
}
```

- [ ] **Step 2: Строка-«ведомость» над списком**

Перед `<div id="ordersList"></div>` (строка ~260):

```html
<div class="zk-registry-head" id="zkRegistryHead" hidden>
    Реестр активных закупок · <span id="zkRegCount">—</span> позиций · обновлено <span id="zkRegDate">—</span>
</div>
```

- [ ] **Step 3: Заполнение в `renderOrders`**

В начало `renderOrders(orders)` (после строки `const el = …`):

```js
const head = document.getElementById('zkRegistryHead');
if (head) {
    head.hidden = !orders.length;
    document.getElementById('zkRegCount').textContent = orders.length;
    document.getElementById('zkRegDate').textContent = new Date().toLocaleDateString('ru-RU');
}
```

- [ ] **Step 4: Mono-номер в карточке**

В шаблоне `zk-card` (строка ~318) перед `zk-card-title`:

```html
<div class="zk-num">ЗК-${String(o.id).padStart(5,'0')}</div>
```

- [ ] **Step 5: Проверка**

Run: `npm run check` → `Static checks passed`.
Визуально `http://localhost:8080/zakupki.html`: mono-строка «РЕЕСТР АКТИВНЫХ ЗАКУПОК · N ПОЗИЦИЙ…» над списком (скрыта при пустом списке), номера `ЗК-00001` в карточках, мобильная ширина ≤600px не ломается.

- [ ] **Step 6: Commit**

```bash
git add zakupki.html
git commit -m "feat(ui): zakupki — реестр как чертёжная ведомость, mono-номера позиций"
```

---

### Task 6: CSS — вынести токены в `assets/css/tokens.css`

Контекст: полный split tokens/components/layout сейчас опасен — в `theme-v2.css` (2995 строк) есть дубли селекторов с равной специфичностью (`.kpi-card` определён на строках 973, 1124, 1406, 1989 — каскад держится на порядке в файле). Механическая пересортировка сломает вид. Делаем безопасную фазу: только токены (оба `:root`-блока — contiguous в начале файла) + оглавление. Полный split — отдельный план после дедупликации.

**Files:**
- Create: `assets/css/tokens.css`
- Modify: `assets/theme-v2.css` (начало файла)
- Modify: `scripts/static-checks.js:11`

**Interfaces:**
- Produces: `assets/css/tokens.css` — все `--*`-переменные проекта; подключается ТОЛЬКО через `@import` в начале `theme-v2.css` (HTML-страницы не трогаем — 22 файла, кеш `?v=` продолжает работать).

- [ ] **Step 1: Определить границы блоков токенов**

Run: `grep -n ":root" assets/theme-v2.css`
Expected: 2 вхождения — основной `:root` в начале файла и `:root` блока «TZ VISUAL IDENTITY v3» (заканчивается ~строка 105, до комментария `.tz-stamp` из Task 1). Убедиться, что между ними и до них нет обычных CSS-правил кроме комментариев/`@font-face` (если `@font-face` есть — оставить его в theme-v2.css, в tokens.css идут только `:root`-блоки с комментариями).

- [ ] **Step 2: Перенос**

Вырезать оба `:root`-блока (с их банер-комментариями) из `theme-v2.css` в новый `assets/css/tokens.css` (порядок блоков сохранить). В начало `theme-v2.css` (самой первой строкой — `@import` обязан идти до любых правил):

```css
@import url('css/tokens.css?v=1');
/* ============================================================
   theme-v2.css — компоненты и layout. Токены: assets/css/tokens.css
   Оглавление: base → sidebar/layout → components (kpi, proc, badges,
   tz-*) → pages → mobile. ВНИМАНИЕ: есть дубли селекторов, каскад
   зависит от порядка правил — не пересортировывать.
   ============================================================ */
```

Путь в `@import` относительный от `assets/theme-v2.css` → `assets/css/tokens.css` = `css/tokens.css`. Проверить структуру: `ls assets/css` (папки может не быть — создать).

- [ ] **Step 3: static-checks**

`scripts/static-checks.js:11`:

```js
const cssFiles = ['assets/theme-v2.css', 'assets/deals-page.css', 'assets/css/tokens.css'];
```

- [ ] **Step 4: Проверка**

Run: `npm run check` → `Static checks passed`.
Визуально: `http://localhost:8080/index.html` и `landing.html` — цвета/тени на месте (если всё серое-чёрное — `@import` не резолвится, проверить путь). DevTools → Network: `tokens.css` загружен со статусом 200.

- [ ] **Step 5: Commit**

```bash
git add assets/css/tokens.css assets/theme-v2.css scripts/static-checks.js
git commit -m "refactor(css): токены вынесены в assets/css/tokens.css (@import), оглавление theme-v2"
```

---

### Task 7: README

- [ ] **Step 1: Дополнить `readme.txt`**

Добавить блок в «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ» (по конвенции репо — новый блок сверху раздела, дата 02.07.2026, формат как соседние): tz-stamp статусы (index/producer/proposals), tz-spec-strip вместо kpi-row (index #analyticsRow, producer #crmFunnel), login crop-marks + eyebrow + fonts.css, PDF — JetBrains Mono TTF (фикс кириллицы, Helvetica не умел кириллицу) + рамка/title-block + scripts/pdf-smoke.js, zakupki ведомость + zk-num, assets/css/tokens.css через @import + static-checks. Упомянуть: полный CSS-split отложен из-за дублей селекторов (каскад на порядке правил).

- [ ] **Step 2: Commit**

```bash
git add readme.txt
git commit -m "docs: readme — идентичность «Чертёжный цех» в кабинете, PDF, zakupki"
```

---

## Проверка всего плана перед сдачей

1. `npm run check` → `Static checks passed`.
2. `node scripts/pdf-smoke.js` → exit 0.
3. `grep -rn "Helvetica" export-pdf.js` → пусто.
4. Визуальный проход (мок-данные на localhost): index (штампы, spec-strip, mono-номера), producer (spec-strip, штампы в «Мои КП»), proposals (штампы), login (crop-marks, eyebrow), zakupki (ведомость, zk-num), landing (не изменился).
5. `git log --oneline` — 7 коммитов, `git status` чистый. **Не пушить.**
