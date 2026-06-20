# SEO Analytics Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an SEO analytics module — HTML page auditor, Google Search Console integration, Yandex Webmaster integration, and intent classification — all surfaced in a new admin-only "SEO" tab.

**Architecture:** Three `seo/` modules (auditor, gsc, yandex, intents) called from new `/api/seo/*` routes in `server.js`. Both search-engine integrations use `enabled: false` graceful degradation when env vars are absent. A new "SEO" tab in `admin.html` shows audit results and query data.

**Tech Stack:** Node.js/CommonJS, Express 5, PostgreSQL (pg pool), `googleapis` npm package, native `fetch` (Node 18+), `@google/generative-ai` (already installed), Chart.js (already on CDN in analytics.html).

## Global Constraints

- CommonJS only (`"type": "commonjs"`) — no `import`/`export`
- All SEO routes: `requireAuth` + `requireRole('admin')` middleware (both already defined in `server.js`)
- Error pattern: `try { ... } catch (e) { next(e); }` — consistent with all existing routes
- Pool imported from `./db` — same pattern as all other routes
- `genAI` is defined in `server.js` and passed as argument to `seo/intents.js`
- `requireRole` is already defined in `server.js` — do not create a duplicate `requireAdmin`
- All new `seo/*.js` files live in `seo/` subdirectory at project root
- `googleapis` must be installed before Tasks 3–5 compile

---

### Task 1: DB Schema + Install googleapis

**Files:**
- Modify: `db.js` — add 3 new `CREATE TABLE IF NOT EXISTS` blocks inside `initDb()`
- Modify: `package.json` — add `googleapis` dependency
- Modify: `render.yaml` — add 4 env var entries

**Interfaces:**
- Produces: tables `seo_audits`, `seo_snapshots`, `seo_intents` in PostgreSQL

- [ ] **Step 1: Install googleapis**

```bash
cd C:\Users\Админ\source\repos
npm install googleapis
```

Expected: `added N packages` with `googleapis` in `node_modules`.

- [ ] **Step 2: Add tables to db.js**

Open `db.js`. Inside `initDb()`, find the end of the first `pool.query(` block (the one with `CREATE TABLE IF NOT EXISTS delivery_events`). Add the three new tables **inside the same template literal**, just before the closing backtick of that query:

```js
        CREATE TABLE IF NOT EXISTS seo_audits (
            id         SERIAL      PRIMARY KEY,
            page       TEXT        NOT NULL,
            score      INTEGER     NOT NULL,
            issues     JSONB       NOT NULL,
            audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS seo_snapshots (
            id          SERIAL      PRIMARY KEY,
            source      TEXT        NOT NULL DEFAULT 'google',
            date        DATE        NOT NULL,
            query       TEXT        NOT NULL,
            page        TEXT        NOT NULL,
            impressions INTEGER     NOT NULL DEFAULT 0,
            clicks      INTEGER     NOT NULL DEFAULT 0,
            ctr         REAL        NOT NULL DEFAULT 0,
            position    REAL        NOT NULL DEFAULT 0,
            UNIQUE(source, date, query, page)
        );
        CREATE TABLE IF NOT EXISTS seo_intents (
            query         TEXT        PRIMARY KEY,
            intent        TEXT        NOT NULL,
            intent_ru     TEXT        NOT NULL,
            classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
```

- [ ] **Step 3: Add env vars to render.yaml**

Open `render.yaml`. After the existing `GEMINI_API_KEY` entry, add:

```yaml
      - key: GOOGLE_SERVICE_ACCOUNT_JSON
        sync: false
      - key: GOOGLE_SITE_URL
        sync: false
      - key: YANDEX_WEBMASTER_TOKEN
        sync: false
      - key: YANDEX_WEBMASTER_HOST_ID
        sync: false
```

- [ ] **Step 4: Add placeholders to .env**

Open `.env`. Add at the end:

```
GOOGLE_SERVICE_ACCOUNT_JSON=
GOOGLE_SITE_URL=
YANDEX_WEBMASTER_TOKEN=
YANDEX_WEBMASTER_HOST_ID=
```

- [ ] **Step 5: Verify tables are created**

```bash
node -e "const {initDb} = require('./db'); initDb().then(() => { console.log('OK'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); })"
```

Expected output: `✓ База данных готова` (no error about missing tables).

- [ ] **Step 6: Commit**

```bash
git add db.js package.json package-lock.json render.yaml .env
git commit -m "feat(seo): add DB tables and install googleapis"
```

---

### Task 2: HTML Auditor + `/api/seo/audit` Route

**Files:**
- Create: `seo/auditor.js`
- Modify: `server.js` — add `require('./seo/auditor')` and `POST /api/seo/audit` route

**Interfaces:**
- Produces: `auditAll()` → `Promise<Array<{ page: string, score: number, issues: Array<{ type, severity, message, fix }> }>>`
- Produces: `auditPage(filename)` → `{ page, score, issues }`

- [ ] **Step 1: Create `seo/` directory and `seo/auditor.js`**

```bash
mkdir C:\Users\Админ\source\repos\seo
```

Write `seo/auditor.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function auditPage(filename) {
    const filepath = path.join(ROOT, filename);
    const html = fs.readFileSync(filepath, 'utf8');
    const issues = [];
    let penalty = 0;

    function add(type, severity, message, fix, cost) {
        issues.push({ type, severity, message, fix });
        penalty += cost;
    }

    // <title>
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch || !titleMatch[1].trim()) {
        add('title_missing', 'critical', 'Тег <title> отсутствует', 'Добавьте <title> с описанием страницы (10–60 символов)', 20);
    } else {
        const len = titleMatch[1].trim().length;
        if (len < 10) add('title_short', 'critical', `<title> слишком короткий (${len} симв.)`, 'Напишите title длиной 10–60 символов', 20);
        else if (len > 60) add('title_long', 'warning', `<title> слишком длинный (${len} симв., обрежется в SERP)`, 'Сократите title до 60 символов', 5);
    }

    // meta description
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']/i);
    if (!descMatch) {
        add('desc_missing', 'critical', 'Meta description отсутствует', 'Добавьте <meta name="description" content="..."> длиной 50–160 символов', 20);
    } else {
        const len = descMatch[1].trim().length;
        if (len < 50) add('desc_short', 'warning', `Meta description короткий (${len} симв.)`, 'Расширьте description до 50–160 символов', 5);
        else if (len > 160) add('desc_long', 'warning', `Meta description длинный (${len} симв.)`, 'Сократите description до 160 символов', 5);
    }

    // <h1>
    const h1count = [...html.matchAll(/<h1[\s>]/gi)].length;
    if (h1count === 0) {
        add('h1_missing', 'critical', 'Тег <h1> отсутствует', 'Добавьте один <h1> с главным заголовком страницы', 20);
    } else if (h1count > 1) {
        add('h1_multiple', 'warning', `Несколько тегов <h1> (${h1count} шт.)`, 'Оставьте только один <h1> на странице', 5);
    }

    // noindex
    if (/<meta\s+name=["']robots["'][^>]*noindex/i.test(html)) {
        add('noindex', 'critical', 'Страница закрыта от индексации (robots: noindex)', 'Удалите noindex из meta robots', 20);
    }

    // canonical
    if (!/<link\s+rel=["']canonical["']/i.test(html)) {
        add('no_canonical', 'info', 'Нет тега canonical', 'Добавьте <link rel="canonical" href="https://домен/страница">', 2);
    }

    // OG tags
    if (!/<meta\s+property=["']og:title["']/i.test(html) || !/<meta\s+property=["']og:description["']/i.test(html)) {
        add('no_og', 'info', 'Отсутствуют OG-теги (og:title, og:description)', 'Добавьте Open Graph мета-теги для корректного отображения в соцсетях', 2);
    }

    // empty alt
    const emptyAlts = [...html.matchAll(/<img[^>]+alt=["']\s*["']/gi)].length;
    if (emptyAlts > 0) {
        add('empty_alt', 'warning', `${emptyAlts} изображений с пустым alt`, 'Заполните атрибут alt для каждого изображения', 5);
    }

    // internal links
    if ([...html.matchAll(/href=["'][^"'#]*\.html["']/gi)].length === 0) {
        add('no_internal_links', 'warning', 'Нет внутренних ссылок на другие страницы', 'Добавьте ссылки на связанные страницы для перелинковки', 5);
    }

    return { page: filename, score: Math.max(0, 100 - penalty), issues };
}

async function auditAll() {
    const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
    return files.map(f => auditPage(f));
}

module.exports = { auditAll, auditPage };
```

- [ ] **Step 2: Verify auditor standalone**

```bash
node -e "const a = require('./seo/auditor'); a.auditAll().then(r => { console.log('Pages:', r.length); r.forEach(p => console.log(p.page, p.score, p.issues.length, 'issues')); })"
```

Expected: 19 lines, each with filename, score 0–100, and issue count. No errors.

- [ ] **Step 3: Add route to server.js**

Open `server.js`. Find the AI-search block (`app.post('/api/ai-search'`). After its closing `});`, add:

```js
// ===================== SEO =====================
const seoAuditor = require('./seo/auditor');

app.post('/api/seo/audit', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const results = await seoAuditor.auditAll();
        for (const r of results) {
            await pool.query(
                'INSERT INTO seo_audits (page, score, issues) VALUES ($1, $2, $3)',
                [r.page, r.score, JSON.stringify(r.issues)]
            );
        }
        res.json(results);
    } catch (e) { next(e); }
});
```

- [ ] **Step 4: Test the route**

Start the server locally: `node server.js`

In a second terminal, get an admin JWT first:
```bash
curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@platform.ru","password":"Admin2025"}' | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).accessToken))"
```

Then audit (replace TOKEN):
```bash
curl -s -X POST http://localhost:5000/api/seo/audit \
  -H "Authorization: Bearer TOKEN" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ const r=JSON.parse(d); console.log('Pages:', r.length); })"
```

Expected: `Pages: 19`

- [ ] **Step 5: Commit**

```bash
git add seo/auditor.js server.js
git commit -m "feat(seo): HTML auditor + POST /api/seo/audit"
```

---

### Task 3: Intent Classification (`seo/intents.js`)

**Files:**
- Create: `seo/intents.js`

**Interfaces:**
- Consumes: `genAI` (GoogleGenerativeAI instance from server.js), `pool` (pg Pool), `queries: string[]`
- Produces: `classifyIntents(queries, genAI, pool)` → `Promise<void>` (writes to `seo_intents`)

- [ ] **Step 1: Create `seo/intents.js`**

```js
'use strict';

const BATCH_SIZE = 50;

const INTENT_LABELS = {
    informational: 'Информационный',
    commercial: 'Коммерческий',
    navigational: 'Навигационный',
    transactional: 'Транзакционный',
};

async function classifyIntents(queries, genAI, pool) {
    if (!genAI || !queries || queries.length === 0) return;

    // filter already-cached queries
    const placeholders = queries.map((_, i) => `$${i + 1}`).join(',');
    const { rows: cached } = await pool.query(
        `SELECT query FROM seo_intents WHERE query IN (${placeholders})`,
        queries
    );
    const cachedSet = new Set(cached.map(r => r.query));
    const uncached = queries.filter(q => !cachedSet.has(q));
    if (uncached.length === 0) return;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        const prompt = `Классифицируй поисковые запросы B2B нефтесервисного маркетплейса по интенту.
Возможные интенты:
- informational — пользователь ищет информацию (что такое, как работает)
- commercial — пользователь выбирает поставщика или сравнивает предложения
- navigational — пользователь ищет конкретную компанию или бренд
- transactional — пользователь готов купить или заказать прямо сейчас

Запросы:
${batch.map((q, idx) => `${idx}. ${q}`).join('\n')}

Отвечай ТОЛЬКО валидным JSON-массивом без markdown. Пример:
[{"query":"буровое оборудование купить","intent":"transactional"}]`;

        let rawText;
        try {
            const result = await model.generateContent(prompt);
            rawText = result.response.text().trim().replace(/^```json|^```|```$/gm, '').trim();
        } catch (e) {
            console.error('[seo/intents] Gemini error:', e.message);
            continue;
        }

        let parsed;
        try { parsed = JSON.parse(rawText); }
        catch { console.error('[seo/intents] JSON parse error, skipping batch'); continue; }

        if (!Array.isArray(parsed)) continue;

        for (const item of parsed) {
            if (!item.query || !item.intent) continue;
            const intent_ru = INTENT_LABELS[item.intent] || item.intent;
            await pool.query(
                `INSERT INTO seo_intents (query, intent, intent_ru)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (query) DO UPDATE SET intent=$2, intent_ru=$3, classified_at=NOW()`,
                [item.query, item.intent, intent_ru]
            );
        }
    }
}

module.exports = { classifyIntents };
```

- [ ] **Step 2: Verify module loads without error**

```bash
node -e "const i = require('./seo/intents'); console.log(typeof i.classifyIntents);"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add seo/intents.js
git commit -m "feat(seo): Gemini intent classification module"
```

---

### Task 4: GSC + Yandex Clients

**Files:**
- Create: `seo/gsc.js`
- Create: `seo/yandex.js`

**Interfaces:**
- `seo/gsc.js` produces: `{ enabled: boolean, fetchSearchAnalytics(startDate, endDate) → Promise<Row[]> }`
- `seo/yandex.js` produces: `{ enabled: boolean, fetchQueries(startDate, endDate) → Promise<Row[]> }`
- Both `Row[]` have shape: `{ source, date, query, page, impressions, clicks, ctr, position }`

- [ ] **Step 1: Create `seo/gsc.js`**

```js
'use strict';

let googleLib;
try { googleLib = require('googleapis').google; } catch { googleLib = null; }

const SA_JSON  = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SITE_URL = process.env.GOOGLE_SITE_URL;

const enabled = !!(googleLib && SA_JSON && SITE_URL);

let _auth = null;
if (enabled) {
    try {
        const credentials = JSON.parse(SA_JSON);
        _auth = new googleLib.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        });
    } catch (e) {
        console.error('[seo/gsc] Failed to init auth:', e.message);
    }
}

async function fetchSearchAnalytics(startDate, endDate) {
    if (!enabled || !_auth) return [];
    const sc = googleLib.searchconsole({ version: 'v1', auth: _auth });
    const rows = [];
    const ROW_LIMIT = 25000;
    let startRow = 0;

    while (true) {
        const res = await sc.searchanalytics.query({
            siteUrl: SITE_URL,
            requestBody: {
                startDate,
                endDate,
                dimensions: ['query', 'page'],
                rowLimit: ROW_LIMIT,
                startRow,
            },
        });
        const batch = res.data.rows || [];
        rows.push(...batch);
        if (batch.length < ROW_LIMIT) break;
        startRow += ROW_LIMIT;
    }

    return rows.map(r => ({
        source: 'google',
        date: endDate,
        query: r.keys[0],
        page: r.keys[1],
        impressions: Math.round(r.impressions || 0),
        clicks: Math.round(r.clicks || 0),
        ctr: parseFloat((r.ctr || 0).toFixed(4)),
        position: parseFloat((r.position || 0).toFixed(2)),
    }));
}

module.exports = { enabled, fetchSearchAnalytics };
```

- [ ] **Step 2: Create `seo/yandex.js`**

```js
'use strict';

const TOKEN   = process.env.YANDEX_WEBMASTER_TOKEN;
const HOST_ID = process.env.YANDEX_WEBMASTER_HOST_ID;
const BASE    = 'https://api.webmaster.yandex.net/v4';

const enabled = !!(TOKEN && HOST_ID);

let _userId = null;

async function _getUserId() {
    if (_userId) return _userId;
    const res = await fetch(`${BASE}/user/`, {
        headers: { Authorization: `OAuth ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`[seo/yandex] user lookup HTTP ${res.status}`);
    const data = await res.json();
    _userId = data.user_id;
    return _userId;
}

async function fetchQueries(startDate, endDate) {
    if (!enabled) return [];
    const uid = await _getUserId();
    const all = [];
    const LIMIT = 500;
    let offset = 0;

    while (true) {
        const url = new URL(`${BASE}/user/${uid}/hosts/${HOST_ID}/search-queries/all-history`);
        url.searchParams.set('date_from', startDate);
        url.searchParams.set('date_to', endDate);
        url.searchParams.set('limit', String(LIMIT));
        url.searchParams.set('offset', String(offset));

        const res = await fetch(url.toString(), {
            headers: { Authorization: `OAuth ${TOKEN}` },
        });
        if (!res.ok) throw new Error(`[seo/yandex] queries HTTP ${res.status}`);

        const data = await res.json();
        const batch = data.queries || [];
        all.push(...batch);
        if (batch.length < LIMIT) break;
        offset += LIMIT;
    }

    return all.map(q => ({
        source: 'yandex',
        date: endDate,
        query: q.query_text,
        page: HOST_ID,
        impressions: q.indicators?.IMPRESSIONS ?? 0,
        clicks: q.indicators?.CLICKS ?? 0,
        ctr: parseFloat(((q.indicators?.CTR ?? 0)).toFixed(4)),
        position: parseFloat(((q.indicators?.POSITION ?? 0)).toFixed(2)),
    }));
}

module.exports = { enabled, fetchQueries };
```

- [ ] **Step 3: Verify both modules load and report enabled=false (no env vars set locally)**

```bash
node -e "const g = require('./seo/gsc'); const y = require('./seo/yandex'); console.log('gsc.enabled:', g.enabled, '| yandex.enabled:', y.enabled);"
```

Expected: `gsc.enabled: false | yandex.enabled: false`

- [ ] **Step 4: Commit**

```bash
git add seo/gsc.js seo/yandex.js
git commit -m "feat(seo): GSC and Yandex Webmaster API clients"
```

---

### Task 5: Sync + Data Routes

**Files:**
- Modify: `server.js` — add `require` imports for gsc/yandex/intents, add `POST /api/seo/sync` and `GET /api/seo/data`

**Interfaces:**
- Consumes: `seoGsc.fetchSearchAnalytics`, `seoYandex.fetchQueries`, `seoIntents.classifyIntents`, `genAI`, `pool`
- Produces: `POST /api/seo/sync` → `{ synced, newQueries, lastSync }`, `GET /api/seo/data` → `{ audit, gscEnabled, yandexEnabled, snapshots, lastSync }`

- [ ] **Step 1: Add requires + two routes in server.js**

Open `server.js`. Find the line `const seoAuditor = require('./seo/auditor');` (added in Task 2). Replace it with:

```js
const seoAuditor = require('./seo/auditor');
const seoGsc     = require('./seo/gsc');
const seoYandex  = require('./seo/yandex');
const seoIntents = require('./seo/intents');
```

Then, after the closing `});` of `POST /api/seo/audit`, add:

```js
app.post('/api/seo/sync', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const end   = new Date().toISOString().slice(0, 10);
        const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        const [gscRows, yandexRows] = await Promise.all([
            seoGsc.enabled    ? seoGsc.fetchSearchAnalytics(start, end) : [],
            seoYandex.enabled ? seoYandex.fetchQueries(start, end)      : [],
        ]);

        const allRows = [...gscRows, ...yandexRows];
        for (const r of allRows) {
            await pool.query(
                `INSERT INTO seo_snapshots (source, date, query, page, impressions, clicks, ctr, position)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (source, date, query, page)
                 DO UPDATE SET impressions=$5, clicks=$6, ctr=$7, position=$8`,
                [r.source, r.date, r.query, r.page, r.impressions, r.clicks, r.ctr, r.position]
            );
        }

        const uniqueQueries = [...new Set(allRows.map(r => r.query))];
        await seoIntents.classifyIntents(uniqueQueries, genAI, pool);

        const { rows: [lg] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='google'`);
        const { rows: [ly] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='yandex'`);

        res.json({
            synced: allRows.length,
            newQueries: uniqueQueries.length,
            lastSync: { google: lg?.d || null, yandex: ly?.d || null },
        });
    } catch (e) { next(e); }
});

app.get('/api/seo/data', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        // latest audit result per page
        const { rows: auditRows } = await pool.query(`
            SELECT DISTINCT ON (page) page, score, issues, audited_at
            FROM seo_audits
            ORDER BY page, audited_at DESC
        `);

        // latest snapshot per (source, query) with intent join
        const { rows: snapRows } = await pool.query(`
            SELECT s.source, s.query, s.page, s.impressions, s.clicks, s.ctr, s.position, s.date,
                   i.intent, i.intent_ru
            FROM seo_snapshots s
            LEFT JOIN seo_intents i ON i.query = s.query
            WHERE s.date = (
                SELECT MAX(s2.date) FROM seo_snapshots s2
                WHERE s2.source = s.source AND s2.query = s.query
            )
            ORDER BY s.impressions DESC
            LIMIT 1000
        `);

        // compute delta vs previous snapshot for each row
        const snapshots = await Promise.all(snapRows.map(async s => {
            const { rows: [prev] } = await pool.query(
                `SELECT position FROM seo_snapshots
                 WHERE source=$1 AND query=$2 AND date < $3
                 ORDER BY date DESC LIMIT 1`,
                [s.source, s.query, s.date]
            );
            const delta = prev ? parseFloat((s.position - prev.position).toFixed(2)) : null;
            return { ...s, delta };
        }));

        const { rows: [lg] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='google'`);
        const { rows: [ly] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='yandex'`);

        res.json({
            audit: auditRows,
            gscEnabled: seoGsc.enabled,
            yandexEnabled: seoYandex.enabled,
            snapshots,
            lastSync: { google: lg?.d || null, yandex: ly?.d || null },
        });
    } catch (e) { next(e); }
});
```

- [ ] **Step 2: Test sync returns correct shape when both disabled**

Start `node server.js`, then:

```bash
curl -s -X POST http://localhost:5000/api/seo/sync \
  -H "Authorization: Bearer TOKEN"
```

Expected JSON: `{"synced":0,"newQueries":0,"lastSync":{"google":null,"yandex":null}}`

- [ ] **Step 3: Test data endpoint returns audit results**

First run audit: `curl -s -X POST http://localhost:5000/api/seo/audit -H "Authorization: Bearer TOKEN"`

Then:
```bash
curl -s http://localhost:5000/api/seo/data \
  -H "Authorization: Bearer TOKEN" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ const r=JSON.parse(d); console.log('audit:', r.audit.length, 'pages | gsc:', r.gscEnabled, '| yandex:', r.yandexEnabled); })"
```

Expected: `audit: 19 pages | gsc: false | yandex: false`

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(seo): POST /api/seo/sync and GET /api/seo/data routes"
```

---

### Task 6: Admin UI — SEO Tab

**Files:**
- Modify: `admin.html` — add SEO tab button, SEO panel HTML, CSS styles, JS logic

**Interfaces:**
- Consumes: `GET /api/seo/data`, `POST /api/seo/audit`, `POST /api/seo/sync`
- Consumes: Chart.js (add CDN script tag — not currently in admin.html)

- [ ] **Step 1: Add Chart.js CDN and SEO CSS to `<head>` in admin.html**

Open `admin.html`. Find the line `<link rel="stylesheet" href="assets/theme-v2.css">`. After it, add:

```html
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        /* ── SEO tab ── */
        .seo-panel { display: none; }
        .seo-panel.active { display: block; }
        .seo-section-title { font-size: 13px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .5px; margin: 0 0 12px; }
        .seo-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; padding: 20px 24px; margin-bottom: 16px; }
        .seo-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
        .seo-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .seo-table th { text-align: left; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .4px; padding: 0 10px 10px; border-bottom: 1px solid var(--inner-border); }
        .seo-table td { padding: 10px; border-bottom: 1px solid var(--inner-border); color: var(--text-primary); vertical-align: top; }
        .seo-table tr:last-child td { border-bottom: none; }
        .seo-table tr.expandable { cursor: pointer; }
        .seo-table tr.expandable:hover td { background: var(--inner-bg); }
        .seo-score { display: inline-flex; align-items: center; justify-content: center; min-width: 42px; height: 24px; border-radius: 6px; font-size: 12px; font-weight: 700; padding: 0 8px; }
        .seo-score.green { background: rgba(74,222,128,.15); color: #4ade80; }
        .seo-score.yellow { background: rgba(250,204,21,.15); color: #facc15; }
        .seo-score.red { background: rgba(248,113,113,.15); color: #f87171; }
        .seo-issue-row td { background: var(--inner-bg); font-size: 12px; color: var(--text-secondary); }
        .seo-issue-row { display: none; }
        .seo-issue-row.open { display: table-row; }
        .seo-badge-sev { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; margin-right: 6px; }
        .seo-badge-sev.critical { background: rgba(248,113,113,.15); color: #f87171; }
        .seo-badge-sev.warning  { background: rgba(250,204,21,.15);  color: #facc15; }
        .seo-badge-sev.info     { background: rgba(148,163,184,.15); color: #94a3b8; }
        .seo-source-btn { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--inner-border); background: var(--inner-bg); color: var(--text-secondary); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: all .15s; }
        .seo-source-btn.active { background: var(--accent-bright); border-color: var(--accent-bright); color: #fff; }
        .seo-intent-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
        .seo-intent-badge.informational { background: rgba(99,102,241,.15); color: #818cf8; }
        .seo-intent-badge.commercial    { background: rgba(8,145,178,.15);  color: #22d3ee; }
        .seo-intent-badge.navigational  { background: rgba(74,222,128,.15); color: #4ade80; }
        .seo-intent-badge.transactional { background: rgba(251,146,60,.15); color: #fb923c; }
        .seo-delta.up   { color: #4ade80; font-weight: 700; }
        .seo-delta.down { color: #f87171; font-weight: 700; }
        .seo-banner { background: var(--inner-bg); border: 1px solid var(--inner-border); border-radius: 10px; padding: 16px 20px; font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
        .seo-banner code { font-family: monospace; background: var(--card-bg); padding: 1px 5px; border-radius: 4px; color: var(--accent-bright); font-size: 12px; }
        .seo-chart-wrap { position: relative; height: 220px; margin-top: 16px; }
    </style>
```

- [ ] **Step 2: Add SEO tab button to the tab bar**

In `admin.html`, find:
```html
                <button class="admin-tab" id="tabAll" onclick="loadRequests('all')">Все заявки</button>
```

After it, add:
```html
                <button class="admin-tab" id="tabSeo" onclick="showSeoTab()">SEO</button>
```

- [ ] **Step 3: Add SEO panel HTML**

In `admin.html`, find `<div id="requestsList">`. After the closing `</div>` of `requestsList`, add:

```html
        <div id="seoPanel" class="seo-panel">

            <!-- Audit section -->
            <div class="seo-card">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                    <p class="seo-section-title" style="margin:0;">Аудит страниц</p>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <select id="seoSevFilter" class="an-filter-select" style="height:32px;" onchange="renderAudit()">
                            <option value="">Все проблемы</option>
                            <option value="critical">Критические</option>
                            <option value="warning">Предупреждения</option>
                            <option value="info">Информация</option>
                        </select>
                        <button class="btn-primary" style="height:32px;padding:0 14px;font-size:12.5px;" onclick="runAudit()" id="auditBtn">Запустить аудит</button>
                    </div>
                </div>
                <div id="auditTable"><div class="admin-empty" style="padding:30px 0;">Нажмите «Запустить аудит»</div></div>
            </div>

            <!-- Queries section -->
            <div class="seo-card">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                    <p class="seo-section-title" style="margin:0;">Поисковые запросы</p>
                    <button class="btn-primary" style="height:32px;padding:0 14px;font-size:12.5px;" onclick="runSync()" id="syncBtn">Синхронизировать</button>
                </div>
                <div class="seo-toolbar">
                    <button class="seo-source-btn active" id="srcAll"    onclick="setSrc('')">Все</button>
                    <button class="seo-source-btn"        id="srcGoogle" onclick="setSrc('google')">Google</button>
                    <button class="seo-source-btn"        id="srcYandex" onclick="setSrc('yandex')">Яндекс</button>
                    <select id="seoIntentFilter" class="an-filter-select" style="height:32px;" onchange="renderSnapshots()">
                        <option value="">Все интенты</option>
                        <option value="informational">Информационный</option>
                        <option value="commercial">Коммерческий</option>
                        <option value="navigational">Навигационный</option>
                        <option value="transactional">Транзакционный</option>
                    </select>
                </div>
                <div id="gcBanner" class="seo-banner" style="display:none;">
                    Google Search Console не подключён. Добавьте в Render: <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> и <code>GOOGLE_SITE_URL</code>.
                </div>
                <div id="yaBanner" class="seo-banner" style="display:none;">
                    Яндекс.Вебмастер не подключён. Добавьте в Render: <code>YANDEX_WEBMASTER_TOKEN</code> и <code>YANDEX_WEBMASTER_HOST_ID</code>.
                </div>
                <div id="snapshotTable"><div class="admin-empty" style="padding:30px 0;">Нет данных — выполните синхронизацию</div></div>
                <div class="seo-chart-wrap"><canvas id="seoChart"></canvas></div>
            </div>

        </div>
```

- [ ] **Step 4: Add SEO JavaScript**

In `admin.html`, find the closing `</script>` of the main script block. Just before it, add:

```js
        // ── SEO ──
        let seoData = null;
        let seoSource = '';
        let seoChart = null;

        async function showSeoTab() {
            document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            document.getElementById('tabSeo').classList.add('active');
            document.getElementById('requestsList').style.display = 'none';
            document.getElementById('seoPanel').classList.add('active');
            document.querySelector('.admin-toolbar').style.display = 'none';
            await loadSeoData();
        }

        async function loadSeoData() {
            try {
                const r = await fetch(`${SERVER_URL}/api/seo/data`, {
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('authToken') }
                });
                if (!r.ok) return;
                seoData = await r.json();
                renderAudit();
                renderSnapshots();
                renderChart();
                document.getElementById('gcBanner').style.display = seoData.gscEnabled ? 'none' : '';
                document.getElementById('yaBanner').style.display = seoData.yandexEnabled ? 'none' : '';
            } catch (e) { console.error('[seo]', e); }
        }

        async function runAudit() {
            const btn = document.getElementById('auditBtn');
            btn.textContent = 'Запускаю...'; btn.disabled = true;
            try {
                const r = await fetch(`${SERVER_URL}/api/seo/audit`, {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('authToken') }
                });
                if (!r.ok) throw new Error('audit failed');
                const results = await r.json();
                if (seoData) seoData.audit = results;
                else seoData = { audit: results, snapshots: [], gscEnabled: false, yandexEnabled: false, lastSync: {} };
                renderAudit();
            } catch (e) { alert('Ошибка аудита: ' + e.message); }
            finally { btn.textContent = 'Запустить аудит'; btn.disabled = false; }
        }

        async function runSync() {
            const btn = document.getElementById('syncBtn');
            btn.textContent = 'Синхронизирую...'; btn.disabled = true;
            try {
                const r = await fetch(`${SERVER_URL}/api/seo/sync`, {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('authToken') }
                });
                if (!r.ok) throw new Error('sync failed');
                const info = await r.json();
                alert(`Синхронизировано: ${info.synced} записей, ${info.newQueries} новых запросов`);
                await loadSeoData();
            } catch (e) { alert('Ошибка синхронизации: ' + e.message); }
            finally { btn.textContent = 'Синхронизировать'; btn.disabled = false; }
        }

        function setSrc(src) {
            seoSource = src;
            ['srcAll','srcGoogle','srcYandex'].forEach(id => document.getElementById(id).classList.remove('active'));
            document.getElementById(src === '' ? 'srcAll' : src === 'google' ? 'srcGoogle' : 'srcYandex').classList.add('active');
            renderSnapshots();
            renderChart();
        }

        function scoreClass(s) { return s >= 80 ? 'green' : s >= 50 ? 'yellow' : 'red'; }

        function renderAudit() {
            const el = document.getElementById('auditTable');
            if (!seoData || !seoData.audit || !seoData.audit.length) {
                el.innerHTML = '<div class="admin-empty" style="padding:30px 0;">Нет данных — нажмите «Запустить аудит»</div>'; return;
            }
            const sevF = document.getElementById('seoSevFilter').value;
            let rows = '';
            seoData.audit.forEach((p, i) => {
                const filtered = sevF ? p.issues.filter(iss => iss.severity === sevF) : p.issues;
                const crits = p.issues.filter(iss => iss.severity === 'critical').length;
                const warns = p.issues.filter(iss => iss.severity === 'warning').length;
                rows += `<tr class="expandable" onclick="toggleAuditRow(${i})">
                    <td>${p.page}</td>
                    <td><span class="seo-score ${scoreClass(p.score)}">${p.score}</span></td>
                    <td>${crits ? `<span style="color:#f87171;font-weight:700;">${crits} крит.</span>` : '—'}</td>
                    <td>${warns ? `<span style="color:#facc15;font-weight:700;">${warns} пред.</span>` : '—'}</td>
                    <td style="font-size:11px;color:var(--text-muted);">${p.audited_at ? new Date(p.audited_at).toLocaleDateString('ru') : '—'}</td>
                </tr>
                <tr class="seo-issue-row" id="auditIssues${i}"><td colspan="5" style="padding:0 10px 10px;">`;
                if (filtered.length === 0) {
                    rows += '<span style="color:var(--text-muted);font-size:12px;">Нет проблем этого типа</span>';
                } else {
                    rows += filtered.map(iss => `
                        <div style="margin:6px 0;">
                            <span class="seo-badge-sev ${iss.severity}">${iss.severity}</span>
                            <strong>${iss.message}</strong>
                            <div style="margin-top:3px;color:var(--text-secondary);font-size:12px;">↳ ${iss.fix}</div>
                        </div>`).join('');
                }
                rows += '</td></tr>';
            });
            el.innerHTML = `<table class="seo-table">
                <thead><tr><th>Страница</th><th>Score</th><th>Крит.</th><th>Пред.</th><th>Дата</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
        }

        function toggleAuditRow(i) {
            const row = document.getElementById(`auditIssues${i}`);
            row.classList.toggle('open');
        }

        function renderSnapshots() {
            const el = document.getElementById('snapshotTable');
            if (!seoData || !seoData.snapshots || !seoData.snapshots.length) {
                el.innerHTML = '<div class="admin-empty" style="padding:30px 0;">Нет данных — выполните синхронизацию</div>'; return;
            }
            const intentF = document.getElementById('seoIntentFilter').value;
            let items = seoData.snapshots;
            if (seoSource) items = items.filter(s => s.source === seoSource);
            if (intentF)   items = items.filter(s => s.intent === intentF);

            const rows = items.slice(0, 200).map(s => {
                const srcBadge = s.source === 'google'
                    ? '<span style="background:rgba(8,145,178,.15);color:#22d3ee;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;">G</span>'
                    : '<span style="background:rgba(251,146,60,.15);color:#fb923c;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;">Я</span>';
                const intentBadge = s.intent
                    ? `<span class="seo-intent-badge ${s.intent}">${s.intent_ru || s.intent}</span>`
                    : '<span style="color:var(--text-muted);font-size:11px;">—</span>';
                const deltaHtml = s.delta == null ? '—'
                    : s.delta < 0 ? `<span class="seo-delta up">▲${Math.abs(s.delta)}</span>`
                    : s.delta > 0 ? `<span class="seo-delta down">▼${s.delta}</span>`
                    : '=';
                const pos = typeof s.position === 'number' ? s.position.toFixed(1) : '—';
                const ctrPct = typeof s.ctr === 'number' ? (s.ctr * 100).toFixed(1) + '%' : '—';
                return `<tr>
                    <td>${srcBadge}</td>
                    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${s.query}">${s.query}</td>
                    <td>${intentBadge}</td>
                    <td style="font-size:11px;color:var(--text-muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${s.page}</td>
                    <td style="font-weight:700;">${pos}</td>
                    <td>${deltaHtml}</td>
                    <td>${s.impressions}</td>
                    <td>${ctrPct}</td>
                </tr>`;
            }).join('');

            el.innerHTML = `<table class="seo-table">
                <thead><tr><th></th><th>Запрос</th><th>Интент</th><th>Страница</th><th>Позиция</th><th>Δ</th><th>Показы</th><th>CTR</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
        }

        function renderChart() {
            const canvas = document.getElementById('seoChart');
            if (seoChart) { seoChart.destroy(); seoChart = null; }
            if (!seoData || !seoData.snapshots || !seoData.snapshots.length) return;

            let items = seoData.snapshots;
            if (seoSource) items = items.filter(s => s.source === seoSource);

            const top10 = items.slice(0, 10);
            if (!top10.length) return;

            const COLORS = ['#22d3ee','#4ade80','#fb923c','#818cf8','#f87171','#facc15','#a78bfa','#34d399','#60a5fa','#f472b6'];
            seoChart = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: top10.map(s => s.query.length > 30 ? s.query.slice(0, 30) + '…' : s.query),
                    datasets: [{
                        label: 'Позиция (меньше = лучше)',
                        data: top10.map(s => s.position),
                        backgroundColor: COLORS.slice(0, top10.length),
                        borderRadius: 6,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { reverse: true, beginAtZero: false, title: { display: true, text: 'Позиция' } }
                    }
                }
            });
        }

        // patch existing tab functions to hide SEO panel when switching away
        const _origLoadRequests = loadRequests;
        loadRequests = function(filter) {
            document.getElementById('seoPanel').classList.remove('active');
            document.getElementById('requestsList').style.display = '';
            document.querySelector('.admin-toolbar').style.display = '';
            return _origLoadRequests(filter);
        };
```

- [ ] **Step 5: Test UI in browser**

Start server: `node server.js`

Open `http://localhost:5000/admin.html` in a browser, log in as admin, click "SEO" tab.

Verify:
- Audit panel shows "Нажмите «Запустить аудит»"
- Two banners visible: "Google Search Console не подключён" and "Яндекс.Вебмастер не подключён"
- Click «Запустить аудит» → table appears with 19 rows, each with a score badge
- Click a row → issues expand below
- Score badge is green (≥80), yellow (50–79), or red (<50)
- Severity filter works

- [ ] **Step 6: Commit**

```bash
git add admin.html
git commit -m "feat(seo): SEO tab in admin.html (audit panel + queries panel)"
```

---

### Task 7: Push to Production

**Files:**
- No code changes — git push triggers Render deploy

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Verify on Render**

After deploy completes (watch Render logs), open `https://b2bneft.onrender.com/admin.html`, log in as admin, open SEO tab, click «Запустить аудит».

Expected: 19 pages with scores and issues.

- [ ] **Step 3: Optional — connect Google Search Console**

In Google Cloud Console:
1. Create a Service Account → download JSON key
2. In GSC, grant the Service Account email "View" access to your property
3. In Render dashboard, set `GOOGLE_SITE_URL` and `GOOGLE_SERVICE_ACCOUNT_JSON` (paste full JSON as one line)
4. Redeploy → click «Синхронизировать» in SEO tab

- [ ] **Step 4: Optional — connect Yandex Webmaster**

1. Go to `https://oauth.yandex.ru/` → create app with `webmaster:verify` scope → get token
2. In Yandex Webmaster (`https://webmaster.yandex.ru/`), find your Host ID in the URL
3. In Render dashboard, set `YANDEX_WEBMASTER_TOKEN` and `YANDEX_WEBMASTER_HOST_ID`
4. Redeploy → click «Синхронизировать»

---

## Self-Review

**Spec coverage:**
- ✓ HTML audit (19 pages, 11 checks, score 0–100) → Task 2
- ✓ GSC integration with enabled/disabled → Task 4
- ✓ Yandex Webmaster integration with enabled/disabled → Task 4
- ✓ Intent classification via Gemini, cached in seo_intents → Task 3
- ✓ POST /api/seo/audit, POST /api/seo/sync, GET /api/seo/data → Task 5
- ✓ 3 DB tables (seo_audits, seo_snapshots with source column, seo_intents) → Task 1
- ✓ Admin UI: audit panel with expandable rows + severity filter → Task 6
- ✓ Admin UI: source switcher G/Я/Все, intent filter, delta column → Task 6
- ✓ Admin UI: banners when source not configured → Task 6
- ✓ Chart.js bar chart for top-10 queries → Task 6
- ✓ render.yaml + .env for 4 new env vars → Task 1
- ✓ delta: negative = improved (shown as ▲ green), positive = dropped (▼ red) → Task 6

**Placeholder scan:** No TBD/TODO found. All code blocks complete.

**Type consistency:**
- `auditAll()` returns `{ page, score, issues }[]` — matches usage in `/api/seo/audit` route ✓
- `fetchSearchAnalytics` / `fetchQueries` both return `{ source, date, query, page, impressions, clicks, ctr, position }[]` — matches upsert in `/api/seo/sync` ✓
- `classifyIntents(queries, genAI, pool)` signature matches call in `/api/seo/sync` ✓
- `GET /api/seo/data` response shape matches JS in admin.html (`seoData.audit`, `seoData.snapshots`, `seoData.gscEnabled`, etc.) ✓
