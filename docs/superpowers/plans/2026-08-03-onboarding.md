# Онбординг «ценность до пароля» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Провести нового заказчика от «мне нужны манжеты» до опубликованной закупки, а новый завод — от ИНН до заполненного профиля, не требуя регистрации первым шагом.

**Architecture:** Два публичных мастера (`/zayavka`, `/zavod`) собирают черновик в `sessionStorage` и ходят в четыре гостевых эндпоинта `routes/public.js` с потолком по IP. Регистрация — последний шаг мастера; после неё фронт публикует накопленную закупку обычным `POST /api/orders` либо передаёт профиль в `POST /api/auth/register`. Серверные правила меняются в двух местах: первая закупка компании публикуется без подтверждённого email, но рассылки наружу придерживаются до подтверждения.

**Tech Stack:** Node.js 20, Express, PostgreSQL, `express-rate-limit` (уже в зависимостях), ванильный JS без сборки, `node --test` через `npm run test:unit`.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-08-03-onboarding-design.md`. Расхождение с ней — повод остановиться, а не «улучшить по ходу».
- Роутеры — фабрики `createXRouter(deps)`; зависимости приходят из `server.js`, напрямую ничего не импортировать.
- Тесты роутеров пишутся через `tests/unit/helpers.js` (`fakePool`, `serve`, `baseDeps`) и работают без базы.
- Гостевые эндпоинты **никогда** не отдают `phone`, `email`, `website` предприятий.
- Весь пользовательский текст — по-русски, без «Sorry», без англицизмов в интерфейсе.
- Любая интерполяция данных в HTML идёт через `escapeHtml` из `assets/app.js` — это проверяет `tests/unit/no-slop.test.js` и `scripts/static-checks.js`.
- Файлы `zakupki/*.html` руками не редактируются: они генерируются `scripts/sync-category-pages.js`, расхождение ловит `npm run check`.
- Перед каждым коммитом: `npm run check` и `npm run test:unit` — оба зелёные.
- Коммиты по-английски, тип `feat`/`fix`/`test`/`docs`, одна строка темы.

---

### Task 1: Гостевой подбор заводов и поиск стаба по ИНН

**Files:**
- Modify: `routes/public.js` (добавить два эндпоинта в конец фабрики, перед `return router`)
- Modify: `server.js:292-299` (лимитер для гостевых маршрутов)
- Test: `tests/unit/onboarding-public.test.js` (создать)

**Interfaces:**
- Consumes: `deps.pool`, `deps.rowToCompany`, `deps.matchedProducers(order, minScore, withReasons)` — уже приходят в `createPublicRouter`, кроме `matchedProducers`: его надо добавить в вызов `createPublicRouter({...})` в `server.js`.
- Produces:
  - `POST /api/public/match-preview` — тело `{ title, category, description, quantity }`, ответ `{ total: number, items: [{ company, city, products, score }] }`, максимум 6 элементов.
  - `GET /api/public/company-by-inn?inn=<10 или 12 цифр>` — ответ `{ found: boolean, company?: { id, company, city, products, specialization, source, claimed } }`.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/unit/onboarding-public.test.js`:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPublicRouter = require('../../routes/public');
const { fakePool, serve, baseDeps } = require('./helpers');

const MATCHES = [
    { company: 'ООО Рези', city: 'Казань', products: 'манжеты, кольца', phone: '+7 900 000-00-00', email: 'z@rezi.ru', website: 'rezi.ru', score: 82 },
    { company: 'ООО Уплотнения', city: 'Пермь', products: 'уплотнения', phone: '+7 901 000-00-00', email: 'p@upl.ru', website: 'upl.ru', score: 61 },
];

function router(overrides = {}) {
    return createPublicRouter(baseDeps({
        pool: fakePool([{ match: /FROM companies/i, rows: [] }]),
        matchedProducers: async () => MATCHES.concat(
            Array.from({ length: 20 }, (_, i) => ({ company: `Завод ${i}`, city: 'Омск', products: 'детали', score: 40 }))
        ),
        ...overrides,
    }));
}

test('подбор для гостя: отдаёт счётчик и не больше шести карточек', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/match-preview', {
            method: 'POST',
            body: { title: 'Манжеты', category: 'РТИ', description: 'полиуретан, 25 МПа' },
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.total, 22);
        assert.equal(res.json.items.length, 6);
        assert.equal(res.json.items[0].company, 'ООО Рези');
    } finally { await srv.close(); }
});

test('подбор для гостя: контакты предприятий не утекают', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/match-preview', {
            method: 'POST',
            body: { title: 'Манжеты', category: 'РТИ', description: 'полиуретан' },
        });
        const dump = JSON.stringify(res.json);
        for (const secret of ['+7 900 000-00-00', 'z@rezi.ru', 'rezi.ru']) {
            assert.ok(!dump.includes(secret), `в ответе не должно быть ${secret}`);
        }
    } finally { await srv.close(); }
});

test('подбор для гостя: без описания и названия — 400', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/match-preview', { method: 'POST', body: { category: 'РТИ' } });
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});

test('поиск по ИНН: находит стаб и отдаёт только публичные поля', async () => {
    const rows = [{
        id: 7, company: 'АО Ижнефтемаш', city: 'Ижевск', products: 'насосы', specialization: 'Нефтепромысловое оборудование',
        source: 'gisp-pp719', claimed: false, phone: '+7 902 000-00-00', email: 'info@izh.ru', website: 'izh.ru',
    }];
    const srv = await serve('/api', router({ pool: fakePool([{ match: /FROM companies/i, rows }]) }));
    try {
        const res = await srv.request('/api/public/company-by-inn?inn=1832000000');
        assert.equal(res.status, 200);
        assert.equal(res.json.found, true);
        assert.equal(res.json.company.company, 'АО Ижнефтемаш');
        const dump = JSON.stringify(res.json);
        assert.ok(!dump.includes('info@izh.ru') && !dump.includes('+7 902 000-00-00'), 'контакты стаба наружу не отдаём');
    } finally { await srv.close(); }
});

test('поиск по ИНН: мусор вместо ИНН — 400, ничего не найдено — found=false', async () => {
    const srv = await serve('/api', router({ pool: fakePool([{ match: /FROM companies/i, rows: [] }]) }));
    try {
        assert.equal((await srv.request('/api/public/company-by-inn?inn=123')).status, 400);
        const none = await srv.request('/api/public/company-by-inn?inn=7728000000');
        assert.equal(none.status, 200);
        assert.equal(none.json.found, false);
    } finally { await srv.close(); }
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `node --test tests/unit/onboarding-public.test.js`
Expected: FAIL — все пять тестов, статус 404 вместо 200/400.

- [ ] **Step 3: Реализовать эндпоинты**

В `routes/public.js` добавить `matchedProducers` в деструктуризацию `deps` (строки 7-17) и вставить перед `return router;`:

```javascript
    // ===================== ГОСТЕВОЙ ОНБОРДИНГ =====================
    // Показываем незарегистрированному заказчику, кто возьмётся за его задачу.
    // Контакты предприятий не отдаём: за ними на площадку и приходят.
    router.post('/public/match-preview', async (req, res, next) => {
        try {
            const { title, category, description, quantity } = req.body || {};
            if (!String(title || '').trim() && !String(description || '').trim()) {
                return res.status(400).json({ error: 'Опишите, что нужно изготовить' });
            }
            const draft = {
                title: String(title || '').slice(0, 200),
                category: String(category || '').slice(0, 100),
                description: String(description || '').slice(0, 4000),
                quantity: quantity ? Number(quantity) : null,
            };
            const matched = await matchedProducers(draft, 0, false);
            res.json({
                total: matched.length,
                items: matched.slice(0, 6).map(m => ({
                    company: m.company,
                    city: m.city || '',
                    products: String(m.products || '').slice(0, 160),
                    score: Number(m.score) || 0,
                })),
            });
        } catch (e) { next(e); }
    });

    // Завод вводит ИНН — показываем, что мы про него уже знаем из реестра.
    router.get('/public/company-by-inn', async (req, res, next) => {
        try {
            const inn = String(req.query.inn || '').replace(/\D/g, '');
            if (inn.length !== 10 && inn.length !== 12) {
                return res.status(400).json({ error: 'ИНН — 10 или 12 цифр' });
            }
            const { rows: [row] } = await pool.query(
                "SELECT id, company, city, products, specialization, source, claimed FROM companies WHERE inn = $1 AND role = 'producer' LIMIT 1",
                [inn]
            );
            if (!row) return res.json({ found: false });
            res.json({
                found: true,
                company: {
                    id: row.id,
                    company: row.company,
                    city: row.city || '',
                    products: String(row.products || '').slice(0, 400),
                    specialization: row.specialization || '',
                    source: row.source || '',
                    claimed: Boolean(row.claimed),
                },
            });
        } catch (e) { next(e); }
    });
```

- [ ] **Step 4: Прокинуть зависимость и лимитер**

В `server.js` найти вызов `createPublicRouter({ ... })` и добавить в объект `matchedProducers,`. Следом за блоком `aiLimiter` (`server.js:292-299`) добавить:

```javascript
// Гостевой онбординг: мастера работают без авторизации, поэтому потолок по IP.
const guestAiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Пока хватит — за час можно собрать три задания. Зарегистрируйтесь, чтобы продолжить без ограничений.' }
});
const guestLookupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Подождите немного или зарегистрируйтесь.' }
});
app.post('/api/public/tz-draft', guestAiLimiter);
app.post('/api/public/analyze-drawing', guestAiLimiter);
app.post('/api/public/match-preview', guestLookupLimiter);
app.get('/api/public/company-by-inn', guestLookupLimiter);
```

- [ ] **Step 5: Прогнать тесты**

Run: `node --test tests/unit/onboarding-public.test.js`
Expected: PASS, 5 тестов.

Run: `npm run check` и `npm run test:unit`
Expected: оба зелёные.

- [ ] **Step 6: Коммит**

```bash
git add routes/public.js server.js tests/unit/onboarding-public.test.js
git commit -m "feat(onboarding): guest match preview and registry lookup by INN"
```

---

### Task 2: Гостевая генерация ТЗ и разбор чертежа

**Files:**
- Modify: `routes/public.js` (два эндпоинта рядом с добавленными в Task 1)
- Modify: `server.js` (прокинуть зависимости в `createPublicRouter`)
- Test: `tests/unit/onboarding-public-ai.test.js` (создать)

**Interfaces:**
- Consumes: `generateProcurementTz({ brief, category, quantity, title })` и `analyzeDrawing(...)` из `lib/ai-client.js` — прокидываются в роутер как `deps.generateProcurementTz` и `deps.analyzeDrawing`; `deps.handleDrawingImageUpload` — уже существующий multer-middleware.
- Produces:
  - `POST /api/public/tz-draft` — тело `{ brief, category, quantity, title }`, ответ `{ title, description, checklist: string[] }`.
  - `POST /api/public/analyze-drawing` — multipart с полем `drawing`, ответ `{ card: {...}, model: string }`.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/unit/onboarding-public-ai.test.js`:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPublicRouter = require('../../routes/public');
const { fakePool, serve, baseDeps } = require('./helpers');

function router(overrides = {}) {
    return createPublicRouter(baseDeps({
        pool: fakePool([{ match: /FROM companies/i, rows: [] }]),
        generateProcurementTz: async ({ brief }) => ({
            title: 'Манжеты уплотнительные',
            description: `1. Назначение\n${brief}`,
            checklist: ['Уточнить размеры'],
        }),
        analyzeDrawing: async () => ({ card: { part: 'Втулка', material: 'Сталь 45' }, model: 'GigaChat-2-Max' }),
        ...overrides,
    }));
}

test('гостевое ТЗ: короткий бриф превращается в задание', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/tz-draft', {
            method: 'POST',
            body: { brief: 'манжеты полиуретан 25 МПа', category: 'РТИ', quantity: 200 },
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.title, 'Манжеты уплотнительные');
        assert.ok(res.json.description.includes('манжеты полиуретан'));
        assert.deepEqual(res.json.checklist, ['Уточнить размеры']);
    } finally { await srv.close(); }
});

test('гостевое ТЗ: пустой бриф — 400, к модели не идём', async () => {
    let called = false;
    const srv = await serve('/api', router({
        generateProcurementTz: async () => { called = true; return {}; },
    }));
    try {
        const res = await srv.request('/api/public/tz-draft', { method: 'POST', body: { brief: '   ' } });
        assert.equal(res.status, 400);
        assert.equal(called, false, 'пустой запрос не должен тратить вызов модели');
    } finally { await srv.close(); }
});

test('гостевое ТЗ: сбой модели отдаёт понятный текст, а не пятисотку', async () => {
    const srv = await serve('/api', router({
        generateProcurementTz: async () => { const e = new Error('Не удалось разобрать ответ модели'); e.code = 'AI_PARSE'; throw e; },
    }));
    try {
        const res = await srv.request('/api/public/tz-draft', { method: 'POST', body: { brief: 'манжеты' } });
        assert.equal(res.status, 502);
        assert.ok(res.json.error.length > 10);
    } finally { await srv.close(); }
});

test('гостевой разбор чертежа: без файла — 400', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/analyze-drawing', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `node --test tests/unit/onboarding-public-ai.test.js`
Expected: FAIL — 404 на обоих маршрутах.

- [ ] **Step 3: Реализовать эндпоинты**

В `routes/public.js` добавить в деструктуризацию `deps`: `generateProcurementTz`, `analyzeDrawing`, `handleDrawingImageUpload`. Вставить рядом с эндпоинтами из Task 1:

```javascript
    // Гостю ИИ доступен до регистрации — в этом весь смысл мастера. Потолок по IP
    // стоит в server.js, здесь только валидация и понятные ошибки.
    router.post('/public/tz-draft', async (req, res, next) => {
        try {
            const brief = String(req.body?.brief || '').trim();
            if (brief.length < 5) return res.status(400).json({ error: 'Опишите задачу — хотя бы пару слов' });
            const out = await generateProcurementTz({
                brief: brief.slice(0, 2000),
                category: String(req.body?.category || '').slice(0, 100),
                quantity: req.body?.quantity ? Number(req.body.quantity) : null,
                title: String(req.body?.title || '').slice(0, 200),
            });
            res.json(out);
        } catch (e) {
            if (e.code === 'AI_NOT_CONFIGURED') {
                return res.status(503).json({ error: 'Сборка задания временно недоступна. Заполните описание вручную — это не помешает разместить закупку.' });
            }
            if (e.code === 'AI_PARSE' || e.code === 'AI_EMPTY' || e.code === 'AI_RATE_LIMIT' || e.code === 'AI_AUTH') {
                return res.status(502).json({ error: 'Не получилось собрать задание с первого раза. Попробуйте ещё раз или опишите своими словами.' });
            }
            next(e);
        }
    });

    router.post('/public/analyze-drawing', handleDrawingImageUpload, async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Приложите чертёж — картинку или PDF' });
            const out = await analyzeDrawing(req.file);
            res.json(out);
        } catch (e) {
            if (e.code === 'AI_NOT_CONFIGURED' || e.code === 'DRAWING_FORMAT' || e.code === 'PDF_NO_TEXT') {
                return res.status(400).json({ error: e.message });
            }
            if (e.code === 'AI_PARSE' || e.code === 'AI_EMPTY') {
                return res.status(502).json({ error: 'Не получилось разобрать чертёж. Опишите деталь словами — так тоже работает.' });
            }
            next(e);
        }
    });
```

Точную сигнатуру `analyzeDrawing` взять из `lib/ai-client.js` и вызвать так же, как это делает `routes/ai.js:173-189` — если там передаётся `req.file` целиком, передавать `req.file`.

- [ ] **Step 4: Прокинуть зависимости**

В `server.js` в вызов `createPublicRouter({ ... })` добавить `generateProcurementTz`, `analyzeDrawing`, `handleDrawingImageUpload` (все три уже существуют в области видимости `server.js` — проверить по вызову `createAiRouter`).

- [ ] **Step 5: Прогнать тесты**

Run: `node --test tests/unit/onboarding-public-ai.test.js`
Expected: PASS, 4 теста.

Run: `npm run check` и `npm run test:unit`
Expected: зелёные.

- [ ] **Step 6: Коммит**

```bash
git add routes/public.js server.js tests/unit/onboarding-public-ai.test.js
git commit -m "feat(onboarding): let guests draft a spec and read a drawing"
```

---

### Task 3: Первая закупка без подтверждённого email, рассылки придержаны

**Files:**
- Modify: `routes/orders.js:167-231`
- Test: `tests/unit/onboarding-first-order.test.js` (создать)

**Interfaces:**
- Consumes: `deps.pool`, `deps.matchedProducers`, `deps.addNotification`, `deps.notifyCompanyEmail`, `deps.registryInviter.inviteStubsForOrder` — всё уже приходит в `createOrdersRouter`.
- Produces: правило публикации, на которое опирается финальный шаг мастера заказчика (Task 5). Внешний контракт `POST /api/orders` не меняется.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/unit/onboarding-first-order.test.js`:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createOrdersRouter = require('../../routes/orders');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

const ORDER_ROW = { id: 10, title: 'Манжеты', category: 'РТИ', deadline: '2026-09-01', company: 'ООО Заказчик' };

function router({ ordersCount = 0, verified = false, spy = {} } = {}) {
    const deps = baseDeps({
        pool: fakePool([
            { match: /COUNT\(\*\)[\s\S]*FROM orders/i, rows: [{ n: String(ordersCount) }] },
            { match: /INSERT INTO orders/i, rows: [ORDER_ROW] },
        ]),
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer', email: 'c@t.ru', email_verified: verified }),
        requireVerifiedEmail: (req, res, next) => {
            if (req.user.email_verified) return next();
            return res.status(403).json({ error: 'Подтвердите email' });
        },
        matchedProducers: async () => [{ company: 'ООО Рези', score: 80, reasons: ['совпадение по продукции'] }],
        addNotification: async (...a) => { (spy.notifications ||= []).push(a); },
        notifyCompanyEmail: async (...a) => { (spy.emails ||= []).push(a); },
        registryInviter: { inviteStubsForOrder: async () => { (spy.invites ||= []).push(1); return 1; } },
    });
    return createOrdersRouter(deps);
}

const BODY = { title: 'Манжеты', category: 'РТИ', deadline: '2026-09-01', description: 'полиуретан' };

test('первая закупка публикуется без подтверждённого email', async () => {
    const srv = await serve('/api/orders', router({ ordersCount: 0, verified: false }));
    try {
        const res = await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal(res.status, 201);
        assert.equal(res.json.id, 10);
    } finally { await srv.close(); }
});

test('вторая закупка без подтверждённого email — 403', async () => {
    const srv = await serve('/api/orders', router({ ordersCount: 1, verified: false }));
    try {
        const res = await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal(res.status, 403);
    } finally { await srv.close(); }
});

test('пока email не подтверждён: письма и инвайты не уходят, уведомление в кабинете есть', async () => {
    const spy = {};
    const srv = await serve('/api/orders', router({ ordersCount: 0, verified: false, spy }));
    try {
        await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal((spy.emails || []).length, 0, 'письма о матче не отправляем');
        assert.equal((spy.invites || []).length, 0, 'инвайты заводам не отправляем');
        assert.equal((spy.notifications || []).length, 1, 'уведомление внутри платформы остаётся');
    } finally { await srv.close(); }
});

test('с подтверждённым email рассылки работают как раньше', async () => {
    const spy = {};
    const srv = await serve('/api/orders', router({ ordersCount: 3, verified: true, spy }));
    try {
        const res = await srv.request('/api/orders', { method: 'POST', body: BODY });
        assert.equal(res.status, 201);
        assert.equal((spy.emails || []).length, 1);
        assert.equal((spy.invites || []).length, 1);
    } finally { await srv.close(); }
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `node --test tests/unit/onboarding-first-order.test.js`
Expected: FAIL — первый тест отдаёт 403 (жёсткий `requireVerifiedEmail`), третий шлёт письма.

- [ ] **Step 3: Реализовать правило**

В `routes/orders.js` заменить `requireVerifiedEmail` в цепочке `router.post('/')` (строка 167) на собственный middleware, объявленный выше в фабрике:

```javascript
    // Первая закупка компании публикуется без подтверждённого email: людей
    // приводит мастер, а почта на домене пока не поднята — терять их на письме
    // дороже, чем риск одной мусорной заявки. Рассылки наружу при этом
    // придерживаются (см. ниже allowOutbound).
    async function allowFirstOrderWithoutVerification(req, res, next) {
        try {
            if (req.user.role === 'admin' || req.user.email_verified) return next();
            const { rows: [row] } = await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE company = $1', [req.user.company]);
            if (Number(row?.n || 0) === 0) return next();
            return res.status(403).json({ error: 'Подтвердите email — ссылка в письме. После этого закупки размещаются без ограничений.' });
        } catch (e) { next(e); }
    }
```

Цепочка становится: `router.post('/', requireAuth, requireRole('customer'), allowFirstOrderWithoutVerification, handleDrawingUpload, async (req, res, next) => {`.

Внутри обработчика, сразу после `const newOrder = rowToOrder(newRow);`, добавить:

```javascript
            // Пока email не подтверждён, наружу ничего не шлём: одна мусорная
            // регистрация иначе разойдётся по двадцати живым заводам.
            const allowOutbound = req.user.role === 'admin' || Boolean(req.user.email_verified);
```

В блоке `await Promise.all(matched.map(async (m) => {` оставить `addNotification` безусловным, а `notifyCompanyEmail`, `sendPush` и `sendTelegramNotification` обернуть в `if (allowOutbound) { ... }`. Вызов `registryInviter.inviteStubsForOrder(newOrder)` тоже обернуть в `if (allowOutbound)`.

- [ ] **Step 4: Прогнать тесты**

Run: `node --test tests/unit/onboarding-first-order.test.js`
Expected: PASS, 4 теста.

Run: `npm run test:unit`
Expected: зелёный, включая существующие тесты заказов.

- [ ] **Step 5: Коммит**

```bash
git add routes/orders.js tests/unit/onboarding-first-order.test.js
git commit -m "feat(orders): publish the first order before email is verified, hold outbound mail"
```

---

### Task 4: Догоняющая рассылка после подтверждения email

**Files:**
- Modify: `routes/auth.js` (обработчик `POST /verify-email`, около строки 488)
- Modify: `db.js` (колонка-флаг у заказов)
- Test: `tests/unit/onboarding-verify-flush.test.js` (создать)

**Interfaces:**
- Consumes: правило `allowOutbound` из Task 3 — заказы, созданные при `email_verified = false`, помечаются `outbound_pending = true`.
- Produces: после успешного `POST /api/auth/verify-email` придержанные рассылки уходят один раз; повторный вызов ничего не шлёт.

- [ ] **Step 1: Добавить колонку**

В `db.js` рядом с остальными `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (около строки 289) добавить:

```sql
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS outbound_pending BOOLEAN NOT NULL DEFAULT false;
```

В `routes/orders.js` в `INSERT INTO orders (...)` добавить колонку `outbound_pending` со значением `!allowOutbound`. Значение `allowOutbound` вычислить **до** вставки.

- [ ] **Step 2: Написать падающий тест**

Создать `tests/unit/onboarding-verify-flush.test.js`:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuthRouter = require('../../routes/auth');
const { fakePool, serve, baseDeps } = require('./helpers');

function router({ pendingOrders = [], spy = {} } = {}) {
    return createAuthRouter(baseDeps({
        pool: fakePool([
            { match: /FROM users WHERE verify_token|verification/i, rows: [{ id: 1, email: 'c@t.ru', company: 'ООО Заказчик', role: 'customer' }] },
            { match: /UPDATE users SET email_verified/i, rows: [] },
            { match: /FROM orders WHERE[\s\S]*outbound_pending/i, rows: pendingOrders },
            { match: /UPDATE orders SET outbound_pending/i, rows: [] },
        ]),
        matchedProducers: async () => [{ company: 'ООО Рези', score: 80, reasons: ['совпадение по продукции'] }],
        notifyCompanyEmail: async (...a) => { (spy.emails ||= []).push(a); },
        registryInviter: { inviteStubsForOrder: async () => { (spy.invites ||= []).push(1); return 1; } },
    }));
}

test('подтверждение email отправляет придержанные письма по заказу', async () => {
    const spy = {};
    const srv = await serve('/api/auth', router({
        pendingOrders: [{ id: 10, title: 'Манжеты', category: 'РТИ', company: 'ООО Заказчик' }],
        spy,
    }));
    try {
        const res = await srv.request('/api/auth/verify-email', { method: 'POST', body: { token: 'tok' } });
        assert.equal(res.status, 200);
        assert.equal((spy.emails || []).length, 1);
        assert.equal((spy.invites || []).length, 1);
    } finally { await srv.close(); }
});

test('подтверждение email без придержанных заказов ничего не шлёт', async () => {
    const spy = {};
    const srv = await serve('/api/auth', router({ pendingOrders: [], spy }));
    try {
        const res = await srv.request('/api/auth/verify-email', { method: 'POST', body: { token: 'tok' } });
        assert.equal(res.status, 200);
        assert.equal((spy.emails || []).length, 0);
        assert.equal((spy.invites || []).length, 0);
    } finally { await srv.close(); }
});
```

Перед запуском открыть `routes/auth.js:488` и привести регулярки `fakePool` в соответствие с настоящими запросами обработчика — тест обязан описывать те запросы, которые код реально делает.

- [ ] **Step 3: Запустить тест, убедиться что падает**

Run: `node --test tests/unit/onboarding-verify-flush.test.js`
Expected: FAIL — писем ноль, потому что догоняющей рассылки ещё нет.

- [ ] **Step 4: Реализовать догоняющую рассылку**

В `routes/auth.js` после успешной установки `email_verified = true` добавить (внутри того же обработчика, после ответа клиенту — рассылка не должна задерживать ответ):

```javascript
            // Заказы, размещённые до подтверждения email, ждут рассылки — отпускаем их
            // ровно один раз: флаг снимается тем же запросом, что выбирает заказы.
            flushPendingOutbound(user.company).catch(e => console.error('outbound-flush:', e.message));
```

И объявить в фабрике:

```javascript
    async function flushPendingOutbound(company) {
        const { rows } = await pool.query(
            'UPDATE orders SET outbound_pending = false WHERE company = $1 AND outbound_pending = true RETURNING *',
            [company]
        );
        for (const row of rows) {
            const order = rowToOrder(row);
            const matched = await matchedProducers(order, 50, true);
            await Promise.all(matched.map(m => notifyCompanyEmail(
                m.company,
                `Подходящая закупка (${m.score}%): «${plainTitle(order.title)}»`,
                `Подходящая закупка (${m.score}%) — ТехЗаказ`,
                `<p style="font-size:15px;font-weight:600;color:#1E3A5F;">«${htmlEscape(plainTitle(order.title))}»</p>
                 <p style="margin-top:16px;"><a href="${APP_URL}/producer.html" style="display:inline-block;background:#FF6A00;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Открыть закупки →</a></p>`
            )));
            await registryInviter.inviteStubsForOrder(order);
        }
        return rows.length;
    }
```

Добавить `rowToOrder`, `matchedProducers`, `notifyCompanyEmail`, `registryInviter`, `plainTitle`, `htmlEscape`, `APP_URL` в деструктуризацию `deps` у `createAuthRouter` и в вызов `createAuthRouter({...})` в `server.js`, если чего-то там нет.

`UPDATE ... RETURNING` снимает флаг и выбирает заказы одним запросом — двойной клик по ссылке из письма не даст двойной рассылки.

- [ ] **Step 5: Прогнать тесты**

Run: `node --test tests/unit/onboarding-verify-flush.test.js`
Expected: PASS, 2 теста.

Run: `npm run test:unit`
Expected: зелёный.

- [ ] **Step 6: Коммит**

```bash
git add db.js routes/auth.js routes/orders.js tests/unit/onboarding-verify-flush.test.js
git commit -m "feat(auth): send held notifications once the email is confirmed"
```

---

### Task 5: Регистрация с профилем производителя

**Files:**
- Modify: `routes/auth.js:70-146`
- Test: `tests/unit/onboarding-register-profile.test.js` (создать)

**Interfaces:**
- Consumes: существующая транзакция регистрации и механика claim по ИНН (`routes/auth.js:123-134`).
- Produces: `POST /api/auth/register` принимает необязательное поле `profile`:
  `{ phone?: string, website?: string, city?: string, products?: string, capabilities?: string[], productionLoad?: number|null }`.
  Мастер завода (Task 7) шлёт именно эту форму.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/unit/onboarding-register-profile.test.js`:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuthRouter = require('../../routes/auth');
const { fakePool, serve, baseDeps } = require('./helpers');

function setup({ stub = null } = {}) {
    const calls = [];
    const pool = fakePool([
        { match: /FROM users WHERE LOWER\(email\)/i, rows: [] },
        { match: /FROM companies WHERE company = \$1 AND role = \$2 AND claimed = true/i, rows: [] },
        { match: /INSERT INTO users/i, rows: [{ id: 1, email: 'z@z.ru', company: 'ООО Завод', role: 'producer' }] },
        { match: /SELECT id FROM companies WHERE inn/i, rows: stub ? [stub] : [] },
        { match: /UPDATE companies SET/i, rows: (sql, params) => { calls.push({ sql, params }); return []; } },
        { match: /INSERT INTO companies/i, rows: (sql, params) => { calls.push({ sql, params }); return []; } },
    ]);
    const router = createAuthRouter(baseDeps({ pool, withTransaction: async (fn) => fn(pool) }));
    return { router, calls };
}

const BODY = {
    email: 'z@z.ru', password: 'parol1234', company: 'ООО Завод', inn: '1832000000',
    role: 'producer', consent: true,
    profile: { phone: '+7 900 111-22-33', website: 'zavod.ru', city: 'Ижевск', products: 'манжеты, кольца', capabilities: ['svarka', 'chpu'], productionLoad: 40 },
};

test('регистрация с профилем: поля мастера доезжают до companies', async () => {
    const { router, calls } = setup({ id: 7 });
    const srv = await serve('/api/auth', router);
    try {
        const res = await srv.request('/api/auth/register', { method: 'POST', body: BODY });
        assert.ok(res.status === 200 || res.status === 201, 'регистрация должна пройти');
        const dump = JSON.stringify(calls);
        assert.ok(dump.includes('+7 900 111-22-33'), 'телефон записан');
        assert.ok(dump.includes('Ижевск'), 'город записан');
        assert.ok(dump.includes('svarka'), 'операции записаны');
    } finally { await srv.close(); }
});

test('регистрация без профиля работает как раньше', async () => {
    const { router } = setup();
    const srv = await serve('/api/auth', router);
    try {
        const body = { ...BODY };
        delete body.profile;
        const res = await srv.request('/api/auth/register', { method: 'POST', body });
        assert.ok(res.status === 200 || res.status === 201);
    } finally { await srv.close(); }
});

test('чужой ИНН: занятый стаб не трогаем', async () => {
    const calls = [];
    const pool = fakePool([
        { match: /FROM users WHERE LOWER\(email\)/i, rows: [] },
        { match: /FROM companies WHERE company = \$1 AND role = \$2 AND claimed = true/i, rows: [] },
        { match: /INSERT INTO users/i, rows: [{ id: 2, email: 'x@z.ru', company: 'ООО Другой', role: 'producer' }] },
        // claimed = true в запросе стаба → выборка пустая, «усыновлять» нечего
        { match: /SELECT id FROM companies WHERE inn/i, rows: [] },
        { match: /UPDATE companies SET/i, rows: (sql, params) => { calls.push({ kind: 'update', sql, params }); return []; } },
        { match: /INSERT INTO companies/i, rows: (sql, params) => { calls.push({ kind: 'insert', sql, params }); return []; } },
    ]);
    const router = createAuthRouter(baseDeps({ pool, withTransaction: async (fn) => fn(pool) }));
    const srv = await serve('/api/auth', router);
    try {
        await srv.request('/api/auth/register', { method: 'POST', body: { ...BODY, email: 'x@z.ru', company: 'ООО Другой' } });
        assert.ok(!calls.some(c => c.kind === 'update'), 'занятую карточку не переписываем');
        assert.ok(calls.some(c => c.kind === 'insert'), 'заводим новую компанию');
    } finally { await srv.close(); }
});

test('операции из профиля фильтруются по справочнику', async () => {
    const { router, calls } = setup({ id: 7 });
    const srv = await serve('/api/auth', router);
    try {
        await srv.request('/api/auth/register', {
            method: 'POST',
            body: { ...BODY, profile: { ...BODY.profile, capabilities: ['svarka', '<script>', 'нет-такой-операции'] } },
        });
        const dump = JSON.stringify(calls);
        assert.ok(dump.includes('svarka'));
        assert.ok(!dump.includes('<script>'), 'мусор в операции не пролезает');
    } finally { await srv.close(); }
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `node --test tests/unit/onboarding-register-profile.test.js`
Expected: FAIL — телефон и город в запросах не встречаются.

- [ ] **Step 3: Реализовать приём профиля**

В начало `routes/auth.js` добавить:

```javascript
const { OPERATIONS } = require('../seo/operations-data');
const OPERATION_SLUGS = new Set(OPERATIONS.map(o => o.slug));

// Профиль из мастера завода: берём только известные поля и только валидные операции.
function sanitizeProducerProfile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const capabilities = Array.isArray(raw.capabilities)
        ? raw.capabilities.filter(s => OPERATION_SLUGS.has(String(s))).slice(0, 12)
        : [];
    const load = raw.productionLoad == null || raw.productionLoad === '' ? null
        : Math.min(100, Math.max(0, Number(raw.productionLoad) || 0));
    return {
        phone: String(raw.phone || '').slice(0, 60),
        website: String(raw.website || '').slice(0, 200),
        city: String(raw.city || '').slice(0, 100),
        products: String(raw.products || '').slice(0, 2000),
        capabilities,
        productionLoad: load,
    };
}
```

Экспорт проверен: `seo/operations-data.js` отдаёт `{ OPERATIONS, operationBySlug, producerText, producerHasOperation }` — импорт выше рабочий.

В обработчике `/register` после разбора `req.body` добавить `const profile = sanitizeProducerProfile(req.body.profile);`, а внутри транзакции:

- в ветке «стаб усыновлён» дополнить `UPDATE companies SET company = $1, claimed = true, status = 'На проверке'` полями профиля, когда `profile` не пуст и роль `producer`: `phone`, `website`, `city`, `products`, `capabilities` (JSON-строкой), `production_load`. Пустые строки профиля не должны затирать данные реестра — записывать только непустые значения;
- в ветке `INSERT INTO companies` добавить те же колонки со значениями из профиля.

`capabilities` хранится текстом JSON (`db.js:50`) — писать `JSON.stringify(profile.capabilities)`.

- [ ] **Step 4: Прогнать тесты**

Run: `node --test tests/unit/onboarding-register-profile.test.js`
Expected: PASS, 3 теста.

Run: `npm run test:unit`
Expected: зелёный, включая `auth-consent.test.js` и `auth-oauth-consent.test.js`.

- [ ] **Step 5: Коммит**

```bash
git add routes/auth.js tests/unit/onboarding-register-profile.test.js
git commit -m "feat(auth): accept a producer profile collected by the onboarding wizard"
```

---

### Task 6: Каркас мастера — страница заказчика `/zayavka`

**Files:**
- Create: `zayavka.html`
- Create: `assets/onboarding.css`
- Create: `assets/onboarding.js`
- Modify: `server.js:562-569` (`PUBLIC_PAGES`)
- Test: `tests/unit/onboarding-wizard.test.js` (создать)

**Interfaces:**
- Consumes: эндпоинты из Task 1 и Task 2; правило первой закупки из Task 3.
- Produces: `assets/onboarding.js` кладёт в `window` объект `TZWizard` с методами `mount(totalSteps)`, `getDraft()`, `setDraft(patch)`, `clearDraft()`, `goStep(n)`, `escapeHtml(s)`, `post(path, body)` — их переиспользует страница завода (Task 7).

- [ ] **Step 1: Написать падающий тест**

Создать `tests/unit/onboarding-wizard.test.js` — проверяем разметку статикой, без браузера:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = () => fs.readFileSync(path.join(root, 'zayavka.html'), 'utf8');

test('мастер заказчика: четыре шага и ни одного обращения к закрытым эндпоинтам', () => {
    const src = html();
    for (const step of ['data-step="1"', 'data-step="2"', 'data-step="3"', 'data-step="4"']) {
        assert.ok(src.includes(step), `нет ${step}`);
    }
    assert.ok(!/\/api\/ai\/generate-tz/.test(src), 'гостевая страница не должна звать закрытый эндпоинт');
    assert.ok(src.includes('/api/public/tz-draft'), 'должна звать гостевую сборку ТЗ');
    assert.ok(src.includes('/api/public/match-preview'), 'должна звать гостевой подбор');
});

test('мастер заказчика: подключает общий скрипт и стили мастера', () => {
    const src = html();
    assert.ok(src.includes('assets/onboarding.js'));
    assert.ok(src.includes('assets/onboarding.css'));
});

test('мастер заказчика: данные предприятий выводятся через экранирование', () => {
    const src = fs.readFileSync(path.join(root, 'assets', 'onboarding.js'), 'utf8');
    assert.ok(src.includes('escapeHtml'), 'вывод названий заводов обязан идти через escapeHtml');
    assert.ok(!/innerHTML\s*=\s*`[^`]*\$\{(?!escapeHtml)/.test(src), 'интерполяция в innerHTML без экранирования запрещена');
});

test('мастер заказчика: страница отдаётся по чистому адресу', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(server.includes("'zayavka.html'"), 'страница должна быть в PUBLIC_PAGES');
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `node --test tests/unit/onboarding-wizard.test.js`
Expected: FAIL — `ENOENT: zayavka.html`.

- [ ] **Step 3: Собрать страницу**

`assets/onboarding.js` — каркас без фреймворка:

```javascript
'use strict';

// Мастер онбординга: общий каркас шагов для /zayavka и /zavod.
// Черновик держим в sessionStorage — перезагрузка вкладки не должна стирать
// набранное; файл чертежа живёт только в памяти вкладки (см. комментарий ниже).
(function () {
    const KEY = 'tz-onboarding-draft';

    function loadDraft() {
        try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return {}; }
    }
    function saveDraft(draft) {
        try { sessionStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* приватный режим — переживём */ }
    }

    let draft = loadDraft();
    let current = 1;
    let total = 1;

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function goStep(n) {
        current = Math.min(Math.max(1, n), total);
        document.querySelectorAll('[data-step]').forEach(el => {
            el.style.display = Number(el.dataset.step) === current ? '' : 'none';
        });
        document.querySelectorAll('[data-progress-dot]').forEach(el => {
            el.classList.toggle('is-done', Number(el.dataset.progressDot) < current);
            el.classList.toggle('is-current', Number(el.dataset.progressDot) === current);
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        if (window.ym) window.ym(window.__ymId, 'reachGoal', 'onboarding_step_' + current);
    }

    window.TZWizard = {
        mount(totalSteps) { total = totalSteps; goStep(1); },
        getDraft() { return draft; },
        setDraft(patch) { draft = { ...draft, ...patch }; saveDraft(draft); return draft; },
        clearDraft() { draft = {}; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
        goStep,
        escapeHtml,
        async post(path, body) {
            const res = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'Не получилось. Попробуйте ещё раз.');
            return json;
        },
    };
})();
```

`zayavka.html` — четыре секции `data-step`:

1. `data-step="1"`: `<textarea id="brief">`, кнопка «Приложить чертёж» (`<input type="file" accept="image/*,application/pdf">`), кнопка «Собрать ТЗ» → `TZWizard.post('/api/public/tz-draft', {...})`, результат в редактируемое поле. Файл чертежа хранить в переменной модуля (`let drawingFile`), **не** в sessionStorage — бинарь туда не влезет и на диск гостю мы ничего не пишем.
2. `data-step="2"`: количество, срок (`<input type="date">`), город, `<select>` категории со значениями, совпадающими с категориями в базе (взять список из `seo/categories-data.js`).
3. `data-step="3"`: кнопка «Показать, кто это сделает» → `/api/public/match-preview`, вывод счётчика и до шести карточек через `escapeHtml`.
4. `data-step="4"`: форма регистрации (email, пароль, компания, ИНН, чекбокс согласия со ссылками на `/privacy` и `/terms` — без согласия `POST /api/auth/register` отдаст 400), затем `POST /api/orders` с `FormData`, включающей черновик и файл чертежа, и переход на `index.html`.

Стили — в `assets/onboarding.css`, поверх `assets/css/tokens.css`: срезанные углы, штамп-бейджи, угловые метки, шаги как «ведомость». Никаких мягких свечений и градиентных пилюль — их запрещает `tests/unit/no-slop.test.js`.

- [ ] **Step 4: Зарегистрировать страницу**

В `server.js:562` добавить `'zayavka.html'` в `PUBLIC_PAGES`.

- [ ] **Step 5: Прогнать тесты**

Run: `node --test tests/unit/onboarding-wizard.test.js`
Expected: PASS, 4 теста.

Run: `npm run check` и `npm run test:unit`
Expected: зелёные. `static-checks.js` проверит валидность HTML и inline-скриптов.

- [ ] **Step 6: Коммит**

```bash
git add zayavka.html assets/onboarding.css assets/onboarding.js server.js tests/unit/onboarding-wizard.test.js
git commit -m "feat(onboarding): public order wizard at /zayavka"
```

---

### Task 7: Мастер завода `/zavod`

**Files:**
- Create: `zavod.html`
- Modify: `assets/onboarding.js` (если понадобится общий хелпер — только добавление, ничего не ломая)
- Modify: `server.js:562-569` (`PUBLIC_PAGES`)
- Modify: `lib/registry-invites.js` (ссылка в письме)
- Modify: `dlya-postavshchikov.html` (CTA)
- Test: `tests/unit/onboarding-wizard-producer.test.js` (создать)

**Interfaces:**
- Consumes: `window.TZWizard` из Task 6; `GET /api/public/company-by-inn` из Task 1; `POST /api/public/match-preview` из Task 1; `POST /api/auth/register` с полем `profile` из Task 5.
- Produces: адрес `/zavod?inn=<ИНН>` — на него ведут инвайт-письма.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/unit/onboarding-wizard-producer.test.js`:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('мастер завода: шаг ИНН и три шага профиля', () => {
    const src = read('zavod.html');
    for (const step of ['data-step="1"', 'data-step="2"', 'data-step="3"', 'data-step="4"', 'data-step="5"']) {
        assert.ok(src.includes(step), `нет ${step}`);
    }
    assert.ok(src.includes('/api/public/company-by-inn'), 'должен искать стаб по ИНН');
});

test('мастер завода: операции берутся из справочника, а не из головы', () => {
    const src = read('zavod.html');
    const { OPERATIONS } = require('../../seo/operations-data');
    const some = OPERATIONS.slice(0, 3).map(o => o.slug);
    for (const slug of some) {
        assert.ok(src.includes(slug), `в чипах нет операции ${slug}`);
    }
});

test('мастер завода: инвайт-письмо ведёт в мастер, а не на общую регистрацию', () => {
    const src = read('lib', 'registry-invites.js');
    assert.ok(src.includes('/zavod'), 'ссылка приглашения должна вести на /zavod');
});

test('мастер завода: страница отдаётся по чистому адресу', () => {
    assert.ok(read('server.js').includes("'zavod.html'"));
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `node --test tests/unit/onboarding-wizard-producer.test.js`
Expected: FAIL — `ENOENT: zavod.html`.

- [ ] **Step 3: Собрать страницу**

`zavod.html`, пять секций:

1. `data-step="1"`: поле ИНН, кнопка «Найти предприятие» → `GET /api/public/company-by-inn`. Если `?inn=` есть в адресе — подставить и искать сразу. Нашли и `claimed = false` — карточка «Это ваше предприятие?» с названием, городом, продукцией и отметкой источника (`gisp-pp719` → «Реестр Минпромторга», иначе «Из открытых данных»). Нашли и `claimed = true` — текст «Предприятие уже зарегистрировано» и ссылка на вход. Не нашли — «Заведём профиль с нуля» и переход дальше.
2. `data-step="2"` «Контакты»: телефон, сайт, email — предзаполнены найденным.
3. `data-step="3"` «Что умеете»: чипы операций из `seo/operations-data.js` (список слагов и названий вшить в разметку — страница статическая) и поле продукции.
4. `data-step="4"` «Производство»: город, загрузка мощностей (`<input type="range" min="0" max="100">`).
5. `data-step="5"`: «Вам подходит N закупок» через `/api/public/match-preview` по продукции и специализации, затем регистрация: email, пароль, чекбокс согласия, `POST /api/auth/register` с `role: 'producer'`, ИНН из шага 1 и блоком `profile`. После успеха — переход на `producer.html`.

В `lib/registry-invites.js` заменить ссылку регистрации на `${APP_URL}/zavod?inn=${inn}&utm_source=registry-invite`. Порядок частей адреса — как принято в проекте: query до якоря.

В `dlya-postavshchikov.html` заменить CTA-ссылки регистрации на `/zavod`.

- [ ] **Step 4: Зарегистрировать страницу**

В `server.js:562` добавить `'zavod.html'` в `PUBLIC_PAGES`.

- [ ] **Step 5: Прогнать тесты**

Run: `node --test tests/unit/onboarding-wizard-producer.test.js`
Expected: PASS, 4 теста.

Run: `npm run check` и `npm run test:unit`
Expected: зелёные.

- [ ] **Step 6: Коммит**

```bash
git add zavod.html assets/onboarding.js server.js lib/registry-invites.js dlya-postavshchikov.html tests/unit/onboarding-wizard-producer.test.js
git commit -m "feat(onboarding): factory wizard at /zavod starting from the INN"
```

---

### Task 8: Точки входа и воронка

**Files:**
- Modify: `landing.html` (главный CTA и блок «как это работает»)
- Modify: `zakupki.html` (CTA)
- Modify: `scripts/sync-category-pages.js` (CTA категорийных страниц)
- Modify: `index.html:1021-1033` (пустое состояние ведёт в мастер)
- Modify: `producer.html:229-243` (карточка полноты профиля ведёт в мастер, если профиль пуст)
- Test: `tests/unit/onboarding-entrypoints.test.js` (создать)

**Interfaces:**
- Consumes: адреса `/zayavka` и `/zavod` из Task 6 и Task 7.
- Produces: ничего для последующих задач — это последний кусок.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/unit/onboarding-entrypoints.test.js`:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('лендинг ведёт заказчика в мастер, а не на форму регистрации', () => {
    const src = read('landing.html');
    assert.ok(src.includes('/zayavka'), 'главный CTA должен вести в мастер');
});

test('страница закупок и генератор категорий ведут в мастер', () => {
    assert.ok(read('zakupki.html').includes('/zayavka'));
    assert.ok(read('scripts', 'sync-category-pages.js').includes('/zayavka'));
});

test('пустое состояние кабинета заказчика предлагает мастер', () => {
    assert.ok(read('index.html').includes('/zayavka'));
});

test('сгенерированные категорийные страницы совпадают с генератором', () => {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'static-checks.js')], { stdio: 'pipe' });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `node --test tests/unit/onboarding-entrypoints.test.js`
Expected: FAIL — ни в одном файле нет `/zayavka`.

- [ ] **Step 3: Переставить точки входа**

- `landing.html`: главный CTA «Разместить закупку» ведёт на `/zayavka`; вторичная ссылка для заводов — на `/zavod`.
- `zakupki.html`: кнопка размещения закупки — на `/zayavka`.
- `scripts/sync-category-pages.js`: CTA в шаблоне — на `/zayavka`; после правки запустить `npm run sync:categories` (точное имя скрипта посмотреть в `package.json`) и закоммитить перегенерированные `zakupki/*.html`.
- `index.html:1021-1033`: в пустом состоянии `ctaText: '+ Создать закупку'` оставить модалку для тех, у кого закупки уже были, но добавить вторую ссылку «Собрать ТЗ с помощью ИИ» на `/zayavka`.
- `producer.html:229-243`: если `percent < 40`, кнопка «Заполнить профиль» ведёт на `/zavod?inn=<ИНН компании>` — мастер быстрее формы; иначе оставить `company-profile.html`.

- [ ] **Step 4: Прогнать тесты**

Run: `node --test tests/unit/onboarding-entrypoints.test.js`
Expected: PASS, 4 теста.

Run: `npm run check` и `npm run test:unit`
Expected: зелёные.

- [ ] **Step 5: Цели воронки в Метрике**

Шаги мастера уже шлют `onboarding_step_N` (Task 6). Добавить две цели-события: `onboarding_order_published` — после успешного `POST /api/orders` в `zayavka.html`, `onboarding_factory_claimed` — после успешной регистрации в `zavod.html`. Вызов такой же, как в существующем коде логина: `if (window.ym) window.ym(window.__ymId, 'reachGoal', '<цель>')`. Точное имя переменной счётчика взять из `login.html`. Сами цели в интерфейсе Метрики заводит владелец — в отчёте о выполнении плана это надо написать явно.

- [ ] **Step 6: Обновить документацию**

В `readme.txt` добавить раздел про мастера: адреса, гостевые эндпоинты с потолками, правило первой закупки, флаг `orders.outbound_pending`. В `docs/ARCHITECTURE.md` — строку про `zayavka.html`/`zavod.html` и `assets/onboarding.js` в таблице файлов.

- [ ] **Step 7: Коммит**

```bash
git add landing.html zakupki.html zakupki/ scripts/sync-category-pages.js index.html producer.html readme.txt docs/ARCHITECTURE.md tests/unit/onboarding-entrypoints.test.js
git commit -m "feat(onboarding): route every entry point into the wizards"
```

---

## Порядок и проверка целиком

Задачи идут строго по номерам: 6 и 7 опираются на эндпоинты из 1, 2 и правила из 3, 5; задача 8 — на страницы из 6, 7.

После задачи 8 — сквозная проверка на локальном сервере (`npm start`):

1. В приватном окне открыть `/zayavka`, описать задачу словами, собрать ТЗ, дойти до подбора, зарегистрироваться, убедиться, что закупка появилась в кабинете.
2. Проверить в базе, что у этой закупки `outbound_pending = true`, и что писем не ушло.
3. Подтвердить email по ссылке, убедиться, что рассылка ушла один раз (лог `outbound-flush` или счётчик `companies.invites_sent`).
4. В приватном окне открыть `/zavod?inn=<ИНН реального стаба из базы>`, пройти мастер, убедиться, что в кабинете профиль заполнен больше чем на 60% и стаб присвоен (`claimed = true`).
5. Проверить оба мастера на телефоне 390px и в WebKit — в этом проекте только WebKit ловил невидимый футер.

**Перед деплоем на прод:** `REGISTRY_INVITES_ENABLED=0` в `.env` на VPS на время ручной проверки, иначе тестовые закупки разойдутся письмами по живым заводам. После проверки — вернуть.
