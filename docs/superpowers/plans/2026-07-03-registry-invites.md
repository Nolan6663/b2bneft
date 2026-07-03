# Приглашения заводам из реестра (фаза B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** При публикации закупки площадка шлёт письма-приглашения подходящим заводам-стабам из реестра (контакты и продукция — обогащение из карточек ГИСП), с троттлингом и отпиской.

**Architecture:** Разведка карточки предприятия ГИСП — ворота плана (есть ли email/продукция публично). Обогащение — расширение браузерного фетчера (детальные страницы) → та же import-цепочка. Движок приглашений — `lib/registry-invites.js`, вызывается fire-and-forget из POST /api/orders рядом с существующей нотификацией matched-производителей; матчинг по ключевым словам продукции/специализации; отписка — stateless HMAC-токен от ИНН (секрет = JWT_SECRET).

**Tech Stack:** существующие Node/pg/Playwright/nodemailer; без новых зависимостей.

## Global Constraints

- Письма ТОЛЬКО стабам (`claimed=false`), только с `contact_email`, без `invite_optout`, не чаще 1 письма в 14 дней на завод (`last_invited_at`), максимум 20 писем на одну закупку.
- В письме обязательны: ссылка-приглашение с claim (`/login.html#register?claim=<inn>&company=<name>`) и ссылка отписки; честный тон («ваш завод есть в госреестре промышленности, на площадке появился подходящий заказ»), никаких «вы зарегистрированы».
- Отписка — без логина, один клик, идемпотентна.
- Разведка/обогащение ГИСП — только с ВЫКЛЮЧЕННЫМ VPN на машине пользователя (двухшаговый танец: команда → пользователь переключает VPN → читаем артефакты из tmp). Rate-limit ≥1500мс к госресурсу.
- Fire-and-forget: сбой приглашений не должен ломать создание закупки (try/catch, без await-блокировки ответа).
- После каждой задачи `npm run check`; коммиты локальные; push после финальной проверки.

---

### Task 1 (ВОРОТА): Разведка карточки предприятия ГИСП

**Files:** Modify: `scripts/fetch-gisp-browser.js`

**Interfaces:** Produces: режим `--org-recon` — открывает перечень, кликает «Предприятие» у первой строки, сохраняет в `os.tmpdir()`: `gisp-org.html`, `gisp-org.png`, `gisp-org-net.txt`. По артефактам контролёр решает: (A) email/продукция есть → Task 3 как написано; (B) продукция есть, email нет → Task 3 без email, движок писем остаётся спящим до другого источника контактов; (C) закрыто авторизацией → эскалация пользователю.

- [ ] **Step 1:** В `fetch-gisp-browser.js` добавить ветку до recon-блока:

```js
    if (process.argv.includes('--org-recon')) {
        // Карточка предприятия: клик по действию «Предприятие» первой строки
        const link = page.locator('a:has-text("Предприятие"), button:has-text("Предприятие")').first();
        if (!(await link.count())) { console.log('Ссылка «Предприятие» не найдена'); await browser.close(); return; }
        await link.click();
        await page.waitForTimeout(6000);
        fs.writeFileSync(path.join(RECON_DIR, 'gisp-org.html'), await page.content());
        await page.screenshot({ path: path.join(RECON_DIR, 'gisp-org.png'), fullPage: true });
        fs.writeFileSync(path.join(RECON_DIR, 'gisp-org-net.txt'), netLog.join('\n') || '(JSON не пойман)');
        console.log('URL карточки:', page.url());
        console.log('Сохранено в', RECON_DIR, ': gisp-org.html, gisp-org.png, gisp-org-net.txt');
        await browser.close();
        return;
    }
```

- [ ] **Step 2:** `node --check scripts/fetch-gisp-browser.js`; `npm run check`; commit `feat(catalog): --org-recon — разведка карточки предприятия ГИСП`.
- [ ] **Step 3 (пользователь, VPN off):** `node scripts/fetch-gisp-browser.js --org-recon`; контролёр читает артефакты и фиксирует вердикт A/B/C в леджере. Задачи 3 корректируются по вердикту.

---

### Task 2: Схема — контакты и отписка

**Files:** Modify: `db.js` (блок ALTER TABLE companies, рядом с source/claimed).

**Interfaces:** Produces: `companies.contact_email TEXT NOT NULL DEFAULT ''`, `companies.invite_optout BOOLEAN NOT NULL DEFAULT false`, `companies.last_invited_at TIMESTAMPTZ`, `companies.products TEXT NOT NULL DEFAULT ''` (список продукции из ГИСП одной строкой — для матчинга).

- [ ] **Step 1:** Добавить в существующий ALTER-блок:

```sql
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_email TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS invite_optout BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_invited_at TIMESTAMPTZ;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS products TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 2:** `node --check db.js`; `npm run check`; commit `feat(db): contact_email/invite_optout/last_invited_at/products для приглашений из реестра`.

---

### Task 3: Обогащение — детальные страницы ГИСП

**Files:** Modify: `scripts/fetch-gisp-browser.js`, `scripts/import-registry.js`

**Interfaces:**
- Produces: режим `--enrich N` — проходит первые N строк перечня, открывает карточку каждой, извлекает `{ inn, contact_email, products }` (селекторы подстроить по вердикту Task 1), пишет/дополняет `scripts/data/registry-enrich.json`; резюмируемо (уже обогащённые ИНН пропускаются при повторном запуске).
- `import-registry.js` принимает `--enrich file.json`: для каждой записи по ИНН обновляет у стаба `contact_email`, `products` и, если у стаба пустая specialization, — первые 80 символов products в specialization. Claimed-компании не трогаются.

- [ ] **Step 1: enrich-режим фетчера** (каркас; селекторы полей — по артефактам Task 1, точки вставки помечены комментарием `// SELECTORS: подставить по gisp-org.html`):

```js
    if (process.argv.includes('--enrich')) {
        const limit = argNum('--enrich', 50);
        const outFile = path.join(__dirname, 'data', 'registry-enrich.json');
        const done = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : [];
        const doneInn = new Set(done.map(r => r.inn));
        // Крупнее страница — меньше переходов
        const size100 = page.locator('.dx-page-size[aria-label="Display 100 items on page"]').first();
        if (await size100.count()) { await size100.click(); await page.waitForTimeout(4000); }
        let processed = 0;
        while (processed < limit) {
            const rows = await scrapeVisibleRows(page);
            for (let i = 0; i < rows.length && processed < limit; i++) {
                if (doneInn.has(rows[i].inn)) { processed++; continue; }
                // SELECTORS: ссылка «Предприятие» в строке i — подставить по gisp-org.html
                const rowLink = page.locator('a:has-text("Предприятие")').nth(i);
                if (!(await rowLink.count())) break;
                await rowLink.click();
                await page.waitForTimeout(3000);
                const detail = await page.evaluate(() => {
                    const text = document.body.innerText;
                    const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
                    // SELECTORS: блок продукции — подставить по gisp-org.html
                    const prod = [...document.querySelectorAll('.product-name, [class*="product"] td')]
                        .map(e => e.textContent.trim()).filter(Boolean).slice(0, 10).join('; ');
                    return { email, prod };
                });
                done.push({ inn: rows[i].inn, contact_email: detail.email, products: detail.prod });
                doneInn.add(rows[i].inn);
                processed++;
                fs.writeFileSync(outFile, JSON.stringify(done, null, 1));
                console.log(`${processed}/${limit}: ${rows[i].inn} email=${detail.email ? 'да' : 'нет'} prod=${detail.prod ? 'да' : 'нет'}`);
                await page.goBack();
                await page.waitForTimeout(1500);
            }
            if (processed < limit && !(await clickNextPage(page))) break;
            await page.waitForTimeout(1500);
        }
        console.log(`Готово: ${done.length} записей → ${outFile}`);
        await browser.close();
        return;
    }
```

- [ ] **Step 2: import-registry `--enrich`:**

```js
    // В run(), после разбора аргументов:
    const enrichIdx = process.argv.indexOf('--enrich');
    if (enrichIdx > -1) {
        require('dotenv').config();
        const { pool } = require('../db.js');
        const rows = JSON.parse(fs.readFileSync(path.resolve(process.argv[enrichIdx + 1]), 'utf8'));
        let updated = 0;
        for (const r of rows) {
            const inn = normalizeInn(r.inn);
            if (!inn) continue;
            const email = /@/.test(r.contact_email || '') ? r.contact_email.trim().toLowerCase() : '';
            const products = String(r.products || '').slice(0, 1000);
            const { rowCount } = await pool.query(
                `UPDATE companies SET
                    contact_email = CASE WHEN $1 <> '' THEN $1 ELSE contact_email END,
                    products = CASE WHEN $2 <> '' THEN $2 ELSE products END,
                    specialization = CASE WHEN specialization = '' AND $2 <> '' THEN LEFT($2, 80) ELSE specialization END
                 WHERE inn = $3 AND role = 'producer' AND claimed = false`,
                [email, products, inn]
            );
            updated += rowCount;
        }
        console.log('Обогащено стабов:', updated);
        await pool.end();
        return;
    }
```

- [ ] **Step 3:** `node --check` обоих; `npm run check`; тест обогащения без БД невозможен — проверка на VPS после прогона; commit `feat(catalog): обогащение стабов контактами и продукцией из карточек ГИСП`.

---

### Task 4: Движок приглашений (TDD чистой логики)

**Files:**
- Create: `lib/registry-invites.js`
- Create: `scripts/test-registry-invites.js`
- Modify: `server.js` (routesDeps + экспорт хелпера в lib), `routes/orders.js` (~строка 195, после notifyCompanyEmail-блока)

**Interfaces:**
- Produces: `createRegistryInviter({ pool, sendEmail, appUrl, jwtSecret })` → `{ inviteStubsForOrder(order), optoutToken(inn), verifyOptoutToken(inn, token), matchScoreStub(order, stub) }`.
- `matchScoreStub(order, stub)`: чистая функция (без БД) — пересечение слов (≥4 букв, нижний регистр) `order.title + order.category + order.description` с `stub.specialization + stub.products`; счёт = число совпавших слов; порог для письма ≥ 2.
- `optoutToken(inn)` = hex HMAC-SHA256(inn, jwtSecret).slice(0, 32); `verifyOptoutToken` — timing-safe сравнение.
- `inviteStubsForOrder(order)`: SELECT стабов (`claimed=false AND invite_optout=false AND contact_email <> '' AND (last_invited_at IS NULL OR last_invited_at < NOW() - INTERVAL '14 days')`), матчинг в JS, топ-20 по счёту, каждому — письмо + `UPDATE last_invited_at = NOW()`.

- [ ] **Step 1: тест чистой логики (ПЕРВЫМ), `scripts/test-registry-invites.js`:**

```js
'use strict';
const { createRegistryInviter } = require('../lib/registry-invites.js');
const inv = createRegistryInviter({ pool: null, sendEmail: null, appUrl: 'https://x', jwtSecret: 'test-secret' });

const order = { title: 'Уплотнение РТИ DN150', category: 'РТИ и уплотнения', description: 'кольца резиновые' };
const checks = [
    ['матч по продукции', inv.matchScoreStub(order, { specialization: '', products: 'кольца резиновые; манжеты' }) >= 2],
    ['матч по специализации', inv.matchScoreStub(order, { specialization: 'РТИ и уплотнения', products: '' }) >= 2],
    ['нет матча', inv.matchScoreStub(order, { specialization: 'кабельная продукция', products: '' }) === 0],
    ['короткие слова игнорируются', inv.matchScoreStub({ title: 'и на по для', category: '', description: '' }, { specialization: 'и на по для', products: '' }) === 0],
    ['токен детерминирован', inv.optoutToken('7701234567') === inv.optoutToken('7701234567')],
    ['токен верифицируется', inv.verifyOptoutToken('7701234567', inv.optoutToken('7701234567')) === true],
    ['чужой токен не проходит', inv.verifyOptoutToken('7701234567', inv.optoutToken('9999999999')) === false],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS' : 'FAIL') + ': ' + name); if (!pass) ok = false; }
process.exit(ok ? 0 : 1);
```

Run → FAIL (модуля нет) — красный.

- [ ] **Step 2: `lib/registry-invites.js`:**

```js
'use strict';
// Приглашения заводам-стабам из госреестра при появлении подходящей закупки.
// Только claimed=false, с contact_email, без optout, не чаще 1 письма/14 дней, топ-20 на закупку.
const crypto = require('crypto');

const MIN_SCORE = 2;
const MAX_INVITES_PER_ORDER = 20;

function words(s) {
    return String(s || '').toLowerCase().match(/[а-яёa-z]{4,}/g) || [];
}

function createRegistryInviter({ pool, sendEmail, appUrl, jwtSecret }) {
    function matchScoreStub(order, stub) {
        const orderWords = new Set(words(`${order.title} ${order.category} ${order.description}`));
        const stubWords = new Set(words(`${stub.specialization} ${stub.products}`));
        let score = 0;
        for (const w of stubWords) if (orderWords.has(w)) score++;
        return score;
    }

    function optoutToken(inn) {
        return crypto.createHmac('sha256', jwtSecret).update(String(inn)).digest('hex').slice(0, 32);
    }

    function verifyOptoutToken(inn, token) {
        const expected = optoutToken(inn);
        const a = Buffer.from(expected);
        const b = Buffer.from(String(token || ''));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    function inviteHtml(order, stub) {
        const claimUrl = `${appUrl}/login.html#register?claim=${encodeURIComponent(stub.inn)}&company=${encodeURIComponent(stub.company)}`;
        const optoutUrl = `${appUrl}/api/registry-invites/optout?inn=${encodeURIComponent(stub.inn)}&token=${optoutToken(stub.inn)}`;
        return `
            <p>Здравствуйте!</p>
            <p>Ваше предприятие «${stub.company}» состоит в реестре производителей промышленной
               продукции Минпромторга (ПП-719). На площадке прямых закупок ТехЗаказ появился заказ,
               который может вам подойти:</p>
            <p style="font-size:16px;font-weight:700">«${order.title}»${order.category ? ' · ' + order.category : ''}</p>
            <p>Чтобы откликнуться, присоедините профиль вашего предприятия (бесплатно, по ИНН):</p>
            <p><a href="${claimUrl}" style="display:inline-block;padding:10px 24px;background:#FF6A00;color:#fff;text-decoration:none;font-weight:600">Присоединить профиль и посмотреть заказ</a></p>
            <p style="color:#64748B;font-size:12px">Вы получили это письмо, потому что предприятие есть в открытом госреестре.
               Больше не присылать: <a href="${optoutUrl}">отписаться</a>.</p>`;
    }

    async function inviteStubsForOrder(order) {
        const { rows: stubs } = await pool.query(
            `SELECT id, company, inn, specialization, products, contact_email
             FROM companies
             WHERE role = 'producer' AND claimed = false AND invite_optout = false
               AND contact_email <> ''
               AND (last_invited_at IS NULL OR last_invited_at < NOW() - INTERVAL '14 days')`
        );
        const scored = stubs
            .map(s => ({ s, score: matchScoreStub(order, s) }))
            .filter(x => x.score >= MIN_SCORE)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_INVITES_PER_ORDER);
        for (const { s } of scored) {
            try {
                await sendEmail(s.contact_email, `Заказ на ТехЗаказ: ${order.title}`, inviteHtml(order, s));
                await pool.query('UPDATE companies SET last_invited_at = NOW() WHERE id = $1', [s.id]);
            } catch (e) {
                console.error('registry-invite fail', s.inn, e.message);
            }
        }
        return scored.length;
    }

    return { inviteStubsForOrder, optoutToken, verifyOptoutToken, matchScoreStub };
}

module.exports = { createRegistryInviter };
```

- [ ] **Step 3:** тест зелёный (`node scripts/test-registry-invites.js` → все PASS).
- [ ] **Step 4: подключение.** В server.js: `const { createRegistryInviter } = require('./lib/registry-invites');` после определения sendEmail/APP_URL/JWT_SECRET (JWT_SECRET взять из `require('./lib/auth-tokens')`): `const registryInviter = createRegistryInviter({ pool, sendEmail, appUrl: APP_URL, jwtSecret: JWT_SECRET });` и добавить `registryInviter` в `routesDeps`. В routes/orders.js: деструктурировать `registryInviter` из deps; после существующего matched-notify блока (~строка 195-201, вне await-цепочки ответа):

```js
            // Приглашения заводам из госреестра (fire-and-forget)
            registryInviter.inviteStubsForOrder(newOrder)
                .then(n => { if (n) console.log(`registry-invites: отправлено ${n} по заявке ${newOrder.id}`); })
                .catch(e => console.error('registry-invites:', e.message));
```

- [ ] **Step 5:** `node --check` server.js, routes/orders.js, lib/registry-invites.js; `npm run check`; commit `feat(invites): движок приглашений заводам из реестра при создании закупки`.

---

### Task 5: Отписка

**Files:** Modify: `server.js` (рядом с /api/public/geo-density).

**Interfaces:** Consumes: `registryInviter.verifyOptoutToken`. Produces: `GET /api/registry-invites/optout?inn=..&token=..` → HTML-страница «Вы отписаны» (или «ссылка недействительна»), идемпотентно.

- [ ] **Step 1:**

```js
// Отписка от приглашений из реестра (ссылка из письма, без логина)
app.get('/api/registry-invites/optout', async (req, res, next) => {
    try {
        const { inn, token } = req.query;
        const page = (title, text) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — ТехЗаказ</title></head>
            <body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#071B2A">
            <h2>${title}</h2><p style="color:#475569">${text}</p></body></html>`;
        if (!inn || !registryInviter.verifyOptoutToken(inn, token)) {
            return res.status(400).send(page('Ссылка недействительна', 'Проверьте ссылку из письма или напишите на info.texzakaz@gmail.com.'));
        }
        await pool.query(
            "UPDATE companies SET invite_optout = true WHERE inn = $1 AND role = 'producer' AND claimed = false",
            [String(inn).replace(/\D/g, '')]
        );
        res.send(page('Вы отписаны', 'Приглашения по этому предприятию больше приходить не будут.'));
    } catch (e) { next(e); }
});
```

- [ ] **Step 2:** `node --check server.js`; `npm run check`; commit `feat(invites): отписка от приглашений по HMAC-ссылке`.

---

### Task 6: README

- [ ] Блок «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (03.07.2026 — приглашения заводам из реестра, фаза B)»: схема (contact_email/products/invite_optout/last_invited_at); enrich-цепочка (`--org-recon` → `--enrich N` на машине с выключенным VPN → `import-registry --enrich`); движок (условия отбора, порог 2 слова, топ-20, 14 дней), отписка `/api/registry-invites/optout`; письма шлются только при заполненных contact_email (после обогащения). Commit `docs: readme — фаза B приглашений из реестра`.

---

## Проверка всего плана

1. `npm run check`; `node scripts/test-registry-invites.js` → PASS×7; `node scripts/test-import-registry.js` → PASS×5.
2. Task 1 вердикт зафиксирован в леджере; Task 3 селекторы подстроены по нему.
3. Не пушить до финального прогона; после пуша — enrich-прогон пользователем и импорт на VPS по readme.
