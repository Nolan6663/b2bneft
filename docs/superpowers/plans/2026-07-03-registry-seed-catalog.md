# Каталог из реестра промышленности (фаза A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Наполнить каталог реальными производителями из госреестра ГИСП (ПП-719): профили-стабы «из реестра» с бейджем, присоединение владельцем при регистрации по ИНН, формат-агностичный импорт.

**Architecture:** Стаб = строка `companies` без пользователя (`source='gisp-pp719'`, `claimed=false`); вся остальная логика площадки уже связывает users↔companies по имени компании, у стаба пользователей нет — уведомления/рассылки автоматически no-op. Импорт — idempotent upsert по ИНН, никогда не трогает claimed-компании. Claim: регистрация producer с ИНН, совпадающим со стабом → стаб «усыновляется» (у стаба нет активности, переименование безопасно).

**Tech Stack:** существующие Node/pg/vanilla-JS; без новых зависимостей.

## Global Constraints

- Данные — только реальные из госисточника; НИКАКИХ сгенерированных компаний/ИНН (урок FAKE_COMPANIES).
- Бейдж стаба: «Реестр Минпромторга» — НЕ «Проверено» (verified_* бейджи не выставлять импортом).
- Импорт не перезаписывает `claimed=true` компании ни при каких условиях.
- `scripts/fetch-gisp.js` работает на VPS (gisp.gov.ru недоступен с dev-машины — VPN); локально проверяется только парсинг фикстур.
- После каждой задачи `npm run check`; коммиты локальные; push после финальной проверки (схема «покажу → выкатываем» одобрена).
- Мигрция схемы — только ADD COLUMN IF NOT EXISTS (паттерн db.js).

---

### Task 1: Схема — source/claimed

**Files:** Modify: `db.js` (блок ALTER TABLE, рядом с `ADD COLUMN IF NOT EXISTS lat`).

**Interfaces:** Produces: `companies.source TEXT NOT NULL DEFAULT ''` (напр. `'gisp-pp719'`), `companies.claimed BOOLEAN NOT NULL DEFAULT true`. Стаб = `claimed=false AND source<>''`.

- [ ] **Step 1:** Найти блок миграций: `grep -n "ADD COLUMN IF NOT EXISTS lat" db.js`. Рядом добавить:

```sql
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS claimed BOOLEAN NOT NULL DEFAULT true;
```

(в том же стиле, что соседние ALTER, внутри существующего pool.query шаблона).

- [ ] **Step 2:** `node --check db.js` (тихо), `npm run check` → passed.
- [ ] **Step 3:** Commit `feat(db): companies.source/claimed — профили из реестра`.

---

### Task 2: Импорт-скрипт с dry-run (TDD)

**Files:**
- Create: `scripts/import-registry.js`
- Create: `scripts/data/registry-fixture.json`
- Create: `scripts/test-import-registry.js`

**Interfaces:**
- Produces: `node scripts/import-registry.js <file.json|file.csv> [--dry-run]`. Формат записи: `{ company, inn, city, specialization, ogrn }` (JSON-массив) или CSV с заголовком `company;inn;city;specialization;ogrn` (разделитель `;`). Экспортирует `parseRegistryFile(path)` → массив нормализованных записей (для теста и fetch-скрипта).
- Правила нормализации: trim всех полей; inn — только цифры, длина 10 или 12, иначе запись отбрасывается; company непустой; дубликаты inn внутри файла схлопываются (первая запись побеждает).

- [ ] **Step 1: Фикстура `scripts/data/registry-fixture.json`:**

```json
[
  { "company": "  ООО «Тестовый завод РТИ»  ", "inn": "7701234567", "city": "Пермь", "specialization": "РТИ и уплотнения", "ogrn": "1027700000000" },
  { "company": "АО «Насосмаш»", "inn": "16-58-012345", "city": "Казань", "specialization": "Насосное оборудование", "ogrn": "" },
  { "company": "Без ИНН", "inn": "", "city": "Москва", "specialization": "", "ogrn": "" },
  { "company": "ООО «Дубль»", "inn": "7701234567", "city": "Тверь", "specialization": "", "ogrn": "" },
  { "company": "ООО «Плохой ИНН»", "inn": "123", "city": "", "specialization": "", "ogrn": "" }
]
```

- [ ] **Step 2: Тест `scripts/test-import-registry.js` (пишется ДО скрипта):**

```js
'use strict';
const path = require('path');
let parseRegistryFile;
try { ({ parseRegistryFile } = require('./import-registry.js')); }
catch { console.error('FAIL: import-registry.js not found'); process.exit(1); }

const rows = parseRegistryFile(path.join(__dirname, 'data', 'registry-fixture.json'));
const checks = [
    ['валидных записей = 2', rows.length === 2],
    ['трим названия', rows[0].company === 'ООО «Тестовый завод РТИ»'],
    ['инн нормализован из 16-58-012345', rows[1].inn === '1658012345'],
    ['город на месте', rows[0].city === 'Пермь'],
    ['дубль по ИНН отброшен (не Тверь)', rows[0].city !== 'Тверь'],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS' : 'FAIL') + ': ' + name); if (!pass) ok = false; }
process.exit(ok ? 0 : 1);
```

Run: `node scripts/test-import-registry.js` → FAIL (файла нет) — красный.

- [ ] **Step 3: `scripts/import-registry.js`:**

```js
'use strict';
// Импорт производителей из реестра в каталог (стабы: claimed=false, source='gisp-pp719').
// Использование: node scripts/import-registry.js <file.json|file.csv> [--dry-run]
// Idempotent: upsert по ИНН; claimed=true компании НЕ трогаются никогда.
const fs = require('fs');
const path = require('path');

const SOURCE = 'gisp-pp719';

function normalizeInn(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    return (digits.length === 10 || digits.length === 12) ? digits : null;
}

function normalizeRow(r) {
    const inn = normalizeInn(r.inn);
    const company = String(r.company || '').trim();
    if (!inn || !company) return null;
    return {
        company,
        inn,
        city: String(r.city || '').trim(),
        specialization: String(r.specialization || '').trim(),
        ogrn: String(r.ogrn || '').replace(/\D/g, ''),
    };
}

function parseRegistryFile(file) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    let raw;
    if (file.toLowerCase().endsWith('.csv')) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        const head = lines.shift().split(';').map(s => s.trim().toLowerCase());
        raw = lines.map(l => {
            const cells = l.split(';');
            const o = {};
            head.forEach((h, i) => { o[h] = cells[i] || ''; });
            return o;
        });
    } else {
        raw = JSON.parse(text);
    }
    const seen = new Set();
    const out = [];
    for (const r of raw) {
        const n = normalizeRow(r);
        if (!n || seen.has(n.inn)) continue;
        seen.add(n.inn);
        out.push(n);
    }
    return out;
}

async function run() {
    const file = process.argv[2];
    const dryRun = process.argv.includes('--dry-run');
    if (!file) { console.error('usage: node scripts/import-registry.js <file.json|csv> [--dry-run]'); process.exit(1); }
    const rows = parseRegistryFile(path.resolve(file));
    console.log(`Распознано записей: ${rows.length}`);
    if (dryRun) {
        rows.slice(0, 5).forEach(r => console.log(' ', r.inn, r.company, '·', r.city));
        console.log('(dry-run: БД не тронута)');
        return;
    }
    require('dotenv').config();
    const { pool } = require('../db.js');
    let inserted = 0, updated = 0, skippedClaimed = 0;
    for (const r of rows) {
        const { rows: [existing] } = await pool.query(
            "SELECT id, claimed FROM companies WHERE inn = $1 AND role = 'producer' LIMIT 1", [r.inn]
        );
        if (existing && existing.claimed) { skippedClaimed++; continue; }
        if (existing) {
            await pool.query(
                "UPDATE companies SET company=$1, city=$2, specialization=$3, ogrn=$4, source=$5 WHERE id=$6",
                [r.company, r.city, r.specialization, r.ogrn, SOURCE, existing.id]
            );
            updated++;
        } else {
            await pool.query(
                "INSERT INTO companies (company, inn, role, specialization, status, city, ogrn, source, claimed) VALUES ($1,$2,'producer',$3,'Действующая',$4,$5,$6,false)",
                [r.company, r.inn, r.specialization, r.city, r.ogrn, SOURCE]
            );
            inserted++;
        }
    }
    console.log(`Вставлено: ${inserted}, обновлено стабов: ${updated}, пропущено claimed: ${skippedClaimed}`);
    await pool.end();
}

module.exports = { parseRegistryFile, normalizeInn };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
```

Перед написанием проверить экспорт pool: `grep -n "module.exports" db.js` — если pool экспортируется иначе (например `module.exports = pool`), поправить require соответственно.

- [ ] **Step 4:** `node scripts/test-import-registry.js` → все PASS. `node scripts/import-registry.js scripts/data/registry-fixture.json --dry-run` → «Распознано записей: 2», список, «БД не тронута».
- [ ] **Step 5:** `npm run check`; commit `feat(catalog): импорт производителей из реестра (upsert по ИНН, dry-run, фикстура+тест)`.

---

### Task 3: Фетчер ГИСП (для запуска на VPS)

**Files:** Create: `scripts/fetch-gisp.js`

**Interfaces:** Produces: `node scripts/fetch-gisp.js [--probe] [--pages N] [--out file.json]` → JSON в формате импорта (Task 2). По умолчанию out = `scripts/data/registry-gisp.json`.

Контекст: точная структура публичного каталога `gisp.gov.ru/pp719v2/pub/org/` не исследована (сайт недоступен с dev-машины — VPN; доступен с VPS). Скрипт строится разведочно: `--probe` печатает сырой ответ для подстройки селекторов/эндпоинтов.

- [ ] **Step 1: Скрипт:**

```js
'use strict';
// Выгрузка перечня производителей из ГИСП (ПП-719, публичный раздел) в формат импорта.
// ЗАПУСКАТЬ НА VPS (gisp.gov.ru блокирует зарубежные IP; локальная машина может быть за VPN).
// Разведка: node scripts/fetch-gisp.js --probe   (печатает начало ответа — подстроить парсер)
// Выгрузка: node scripts/fetch-gisp.js --pages 50 --out scripts/data/registry-gisp.json
const fs = require('fs');
const path = require('path');

const BASE = 'https://gisp.gov.ru';
const UA = 'TechZakaz-catalog/1.0 (info.texzakaz@gmail.com)';

async function get(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json, text/html' }, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', text };
}

// Кандидаты API (подстроить по факту --probe):
const CANDIDATES = [
    p => `${BASE}/pp719v2/pub/api/org/?page=${p}&size=100`,
    p => `${BASE}/pp719v2/api/pub/org/?page=${p}&size=100`,
    p => `${BASE}/pp719v2/pub/org/?page=${p}`,
];

function extractFromJson(obj) {
    // Ищем массив записей в типовых обёртках (content/items/results/data)
    const arr = Array.isArray(obj) ? obj : obj.content || obj.items || obj.results || obj.data || [];
    return arr.map(o => ({
        company: o.name || o.orgName || o.shortName || o.title || '',
        inn: o.inn || o.INN || '',
        city: o.city || o.region || o.address || '',
        specialization: o.industry || o.okpd2Name || '',
        ogrn: o.ogrn || '',
    }));
}

function extractFromHtml(html) {
    // Грубый фолбэк: строки таблицы с ИНН (10/12 цифр) рядом с названием
    const out = [];
    const rowRe = /<tr[\s\S]*?<\/tr>/g;
    for (const row of html.match(rowRe) || []) {
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
        const innCell = cells.find(c => /^\d{10}(\d{2})?$/.test(c.replace(/\D/g, '')) && c.replace(/\D/g, '').length >= 10);
        const nameCell = cells.find(c => c.length > 5 && !/^\d[\d\s-]*$/.test(c));
        if (innCell && nameCell) out.push({ company: nameCell, inn: innCell, city: cells[2] || '', specialization: '', ogrn: '' });
    }
    return out;
}

async function run() {
    const probe = process.argv.includes('--probe');
    const pagesIdx = process.argv.indexOf('--pages');
    const pages = pagesIdx > -1 ? Number(process.argv[pagesIdx + 1]) : 5;
    const outIdx = process.argv.indexOf('--out');
    const outFile = outIdx > -1 ? process.argv[outIdx + 1] : path.join(__dirname, 'data', 'registry-gisp.json');

    if (probe) {
        for (const mk of CANDIDATES) {
            const url = mk(0);
            try {
                const r = await get(url);
                console.log('\n===', url, '→', r.status, r.type);
                console.log(r.text.slice(0, 1500));
            } catch (e) { console.log('\n===', url, '→ ERROR', e.message); }
        }
        return;
    }

    let all = [];
    let working = null;
    for (const mk of CANDIDATES) {
        try {
            const r = await get(mk(0));
            if (r.status === 200) { working = mk; break; }
        } catch { /* следующий кандидат */ }
    }
    if (!working) { console.error('Ни один эндпоинт не ответил 200 — запусти с --probe и подстрой CANDIDATES'); process.exit(1); }

    for (let p = 0; p < pages; p++) {
        const r = await get(working(p));
        if (r.status !== 200) break;
        const batch = r.type.includes('json') ? extractFromJson(JSON.parse(r.text)) : extractFromHtml(r.text);
        if (!batch.length) break;
        all = all.concat(batch);
        console.log(`страница ${p}: +${batch.length} (всего ${all.length})`);
        await new Promise(res => setTimeout(res, 1500)); // вежливый rate limit к госресурсу
    }
    fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
    console.log(`Сохранено ${all.length} записей → ${outFile}. Дальше: node scripts/import-registry.js ${outFile} --dry-run`);
}

run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2:** `node --check scripts/fetch-gisp.js`; локальная проверка парсеров: `node -e "const m=require('./scripts/fetch-gisp.js')"` не нужна (нет экспортов) — вместо этого убедиться, что `--probe` без сети падает ожидаемо: запуск локально даст timeout/ERROR по кандидатам — это норм, фиксируем в выводе задачи.
- [ ] **Step 3:** `npm run check`; commit `feat(catalog): фетчер ГИСП ПП-719 (probe-режим, запуск на VPS)`.

---

### Task 4: Claim при регистрации + prefill

**Files:**
- Modify: `routes/auth.js` (~строки 78-84, блок создания компании при регистрации)
- Modify: `login.html` (обработка URL-параметров prefill; найти существующий invite-prefill: `grep -n "invite" login.html`)

**Interfaces:**
- Consumes: `companies.claimed/source` (Task 1).
- Produces: регистрация producer с ИНН стаба присоединяет стаб; URL `login.html#register?claim=<inn>&company=<name>` предзаполняет форму.

- [ ] **Step 1: routes/auth.js.** Блок (текущий вид, ~78-84):

```js
const { rows: [compExists] } = await client.query('SELECT 1 FROM companies WHERE company = $1 AND role = $2', [resolvedCompany, resolvedRole]);
if (!compExists) {
    await client.query(
        "INSERT INTO companies (company,inn,role,specialization,status) VALUES ($1,$2,$3,$4,$5)",
        [resolvedCompany, inn || '', resolvedRole, '', 'На проверке']
    );
}
```

заменить на:

```js
const { rows: [compExists] } = await client.query('SELECT 1 FROM companies WHERE company = $1 AND role = $2', [resolvedCompany, resolvedRole]);
if (!compExists) {
    // Присоединение профиля из реестра: ИНН совпал со стабом → «усыновляем»
    // (у стаба нет пользователей/заявок, переименование безопасно)
    const normInn = String(inn || '').replace(/\D/g, '');
    let adopted = null;
    if (resolvedRole === 'producer' && (normInn.length === 10 || normInn.length === 12)) {
        const { rows: [stub] } = await client.query(
            "SELECT id FROM companies WHERE inn = $1 AND role = 'producer' AND claimed = false LIMIT 1", [normInn]
        );
        if (stub) {
            await client.query(
                "UPDATE companies SET company = $1, claimed = true, status = 'На проверке' WHERE id = $2",
                [resolvedCompany, stub.id]
            );
            adopted = stub.id;
        }
    }
    if (!adopted) {
        await client.query(
            "INSERT INTO companies (company,inn,role,specialization,status) VALUES ($1,$2,$3,$4,$5)",
            [resolvedCompany, inn || '', resolvedRole, '', 'На проверке']
        );
    }
}
```

- [ ] **Step 2: login.html prefill.** Найти скрипт invite-prefill (`grep -n "invite" login.html`, ~строка 824+). Рядом добавить обработку claim (после DOMContentLoaded-логики invite, тот же стиль):

```js
// Prefill из каталога: «Это ваша компания?» (login.html#register?claim=INN&company=NAME)
(function () {
    const q = new URLSearchParams((location.hash.split('?')[1] || location.search.slice(1)) || '');
    const claimInn = q.get('claim');
    if (!claimInn) return;
    switchTab('register');
    const innInput = document.querySelector('#form-register input[name="inn"], #form-register #reg-inn');
    const companyInput = document.querySelector('#form-register input[name="company"], #form-register #reg-company');
    if (innInput) innInput.value = claimInn;
    if (companyInput && q.get('company')) companyInput.value = q.get('company');
})();
```

Перед вставкой проверить реальные id/name полей ИНН и компании в форме регистрации (`grep -n "inn" login.html | head`), подставить точные селекторы вместо перечисленных кандидатов.

- [ ] **Step 3:** `node --check routes/auth.js`; `npm run check`; ручная проверка prefill: `npx http-server -p 8080` → `http://localhost:8080/login.html#register?claim=7701234567&company=Тест` → форма регистрации открыта, ИНН/название заполнены.
- [ ] **Step 4:** Commit `feat(auth): присоединение профиля из реестра при регистрации по ИНН + prefill claim-ссылки`.

---

### Task 5: Бейджи и CTA в каталоге и профиле

**Files:**
- Modify: `routes/companies.js` и/или `lib/company-enrich.js` — отдавать `source`, `claimed` в API каталога/профиля (найти: `grep -n "verifiedEgrul\|verified_egrul" routes/companies.js lib/company-enrich.js` — добавить поля рядом, в том же стиле camelCase: `claimed: r.claimed !== false`, `fromRegistry: !r.claimed && !!r.source`).
- Modify: `catalog.html` (карточка ~739: рядом с `catalog-verified`), `company-profile.html` (рядом с verified-бейджами, `grep -n "platform-verified-badge" company-profile.html`).

**Interfaces:** Consumes: `fromRegistry` boolean из API.

- [ ] **Step 1: API.** Во всех местах, где каталог/профиль маппит компанию в JSON (routes/companies.js список + профиль; если каталог ходит через inline `/api/catalog` в server.js — `grep -n "api/catalog" server.js` и добавить там же), добавить:

```js
fromRegistry: !row.claimed && !!row.source,
```

(имя поля строки может быть `r`/`row`/`c` — по месту; если SELECT перечисляет колонки явно — добавить `claimed, source` в SELECT).

- [ ] **Step 2: catalog.html.** В карточке рядом с verified-бейджами (строка ~739) добавить ветку:

```js
${c.fromRegistry ? `<span class="catalog-verified catalog-registry"><span class="nav-label">Реестр Минпромторга</span></span>` : ''}
```

CSS рядом с `.catalog-verified--egrul` (строка ~123):

```css
.catalog-registry { color: #64748B; border-color: rgba(100,116,139,.45); }
```

И в карточке — CTA (мелкой строкой в подвале карточки, где ссылки на профиль):

```js
${c.fromRegistry ? `<a class="catalog-claim-link" href="/login.html#register?claim=${encodeURIComponent(c.inn || '')}&company=${encodeURIComponent(c.company || c.name || '')}" onclick="event.stopPropagation();">Это ваша компания?</a>` : ''}
```

```css
.catalog-claim-link { font-size: 11px; color: var(--tz-blueprint-blue); text-decoration: none; }
.catalog-claim-link:hover { text-decoration: underline; }
```

(точные имена полей `c.inn`/`c.company` сверить с рендером карточки — `grep -n "escapeHtml(c\." catalog.html | head`).

- [ ] **Step 3: company-profile.html.** Рядом с verified-бейджем — тот же бейдж «Реестр Минпромторга» + строка «Профиль создан по данным госреестра ГИСП (ПП-719). Представитель компании может присоединить его при регистрации.» + та же claim-ссылка.

- [ ] **Step 4:** `npm run check`; визуально с мок-данными нельзя (мок не знает fromRegistry) — проверка после импорта на проде/локальной БД; в этой задаче достаточно отсутствия JS-ошибок на catalog.html через `node scripts/…` нет — открыть `http://localhost:8080/catalog.html` в http-server, консоль без ошибок.
- [ ] **Step 5:** Commit `feat(catalog): бейдж «Реестр Минпромторга» и CTA «Это ваша компания?» для стабов`.

---

### Task 6: Геокодинг стабов

**Files:** Modify: `server.js:855-866` (`geocodeExisting`).

- [ ] **Step 1:** Поднять LIMIT 50 → 200 (Nominatim: 1.2с/шт ≈ 4 мин фоном за старт; города повторяются — добавить кэш в рамках прогона):

```js
async function geocodeExisting() {
    try {
        const { rows } = await pool.query(
            "SELECT id, city FROM companies WHERE role='producer' AND city != '' AND lat IS NULL LIMIT 200"
        );
        const cityCache = new Map();
        for (const r of rows) {
            const key = r.city.trim().toLowerCase();
            let coords = cityCache.get(key);
            if (coords === undefined) {
                coords = await geocodeCity(r.city);
                cityCache.set(key, coords);
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
            if (coords) await pool.query('UPDATE companies SET lat=$1,lng=$2 WHERE id=$3', [coords.lat, coords.lng, r.id]);
        }
    } catch {}
}
```

- [ ] **Step 2:** `node --check server.js`; `npm run check`; commit `feat(geo): геокодинг до 200 компаний за старт с кэшем городов (для стабов реестра)`.

---

### Task 7: README + инструкция запуска на VPS

- [ ] **Step 1:** Блок в «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ» readme.txt: схема source/claimed; import-registry (формат, dry-run, idempotent, claimed не трогается); fetch-gisp (ТОЛЬКО с VPS, --probe для подстройки); claim при регистрации по ИНН + ссылка `#register?claim=`; бейдж «Реестр Минпромторга»; геокодинг 200/старт. Плюс пошаговая инструкция:

```
  Наполнение каталога (на VPS):
    cd /var/www/neft
    node scripts/fetch-gisp.js --probe          # разведка (подстроить CANDIDATES при необходимости)
    node scripts/fetch-gisp.js --pages 20       # выгрузка → scripts/data/registry-gisp.json
    node scripts/import-registry.js scripts/data/registry-gisp.json --dry-run
    node scripts/import-registry.js scripts/data/registry-gisp.json
    pm2 restart neft                            # геокодинг подхватит города фоном
```

- [ ] **Step 2:** Commit `docs: readme — каталог из реестра ГИСП (импорт, claim, инструкция VPS)`.

---

## Проверка всего плана

1. `npm run check`; `node scripts/test-import-registry.js` → PASS×5.
2. Dry-run фикстуры: «Распознано записей: 2».
3. Prefill claim-ссылки в браузере.
4. После пуша: на VPS `--probe` (первый живой контакт с ГИСП — подстройка CANDIDATES возможна, это ожидаемо).
5. Не пушить до финального прогона пунктов 1-3.
