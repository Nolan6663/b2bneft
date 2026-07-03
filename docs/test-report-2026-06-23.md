# Отчёт глобального тестирования — ТехЗаказ

**Дата:** 23.06.2026  
**Репозиторий:** `C:\Users\Админ\source\repos`  
**Окружение:** локальный код-ревью + `npm test` (static-checks)

---

## 1. Методология

| Уровень | Что проверялось | Результат |
|---------|-----------------|-----------|
| Статика | `scripts/static-checks.js` — синтаксис JS, inline-скрипты HTML, битые ссылки, CSS, импорт server.js, guardrails | **PASS** (exit 0) |
| Backend | `server.js`, `db.js`, `storage.js`, `export-pdf.js`, `seo/*` | Ревью + исправления |
| Frontend | `assets/app.js`, ключевые HTML (index, producer, delivery, settings) | Ревью + исправления |
| E2E | `tests/e2e/*.spec.js` | Не запускались (нужен поднятый сервер + Playwright) |
| Smoke API | `scripts/mvp-api-smoke.js` | Пропущен (нужен `MVP_SMOKE_RUN=1` + живой API + PostgreSQL) |

---

## 2. Автотесты

```
npm test  →  node scripts/static-checks.js  →  exit 0
```

Проверено: 16+ HTML, все inline-скрипты, локальные `src`/`href`, баланс скобок в `theme-v2.css`, отсутствие production JWT fallback, access guardrails в server.js.

---

## 3. Модули

### Backend (`server.js`)

| Область | Статус | Комментарий |
|---------|--------|-------------|
| Auth / JWT / cookies | OK | Регистрация усилена (см. исправления) |
| Закупки / КП / сделки | OK + fix | Cron deadline, accept после дедлайна |
| Чат / Socket.io | OK | `io` null-guard на аукционах |
| Файлы / uploads | FIX | IDOR на `/uploads/:filename` закрыт |
| Tasks API | FIX | Добавлена проверка `canAccessOrderThread` |
| Conversation context | FIX | Добавлена проверка доступа |
| Risk `/api/risk/:inn` | FIX | SQL `name` → `company` |
| PDF export | OK + fix | Обработка ошибок stream |
| Cron (deadline, auctions) | FIX | Статус `Дедлайн истёк`, лог ошибок |
| Telegram notify on KP | FIX | `proposalRow` → корректные переменные |
| SEO routes | OK | auditor/yandex мелкие фиксы |

### `storage.js`

| Проверка | Статус |
|----------|--------|
| Local file 404 | OK |
| S3 NoSuchKey | **FIX** — возвращает 404 JSON |

### `export-pdf.js`

| Проверка | Статус |
|----------|--------|
| Генерация PDF | OK |
| Ошибки stream | **FIX** |

### `db.js`

| Проверка | Статус |
|----------|--------|
| Seed flags | OK |
| email_verified backfill | Открыто (legacy-поведение) |

### Frontend

| Страница / модуль | Статус |
|-------------------|--------|
| `index.html` | **FIX** — фильтр «Активные» включает `Дедлайн истёк` |
| `producer.html` | **FIX** — гость → `/orders/public` |
| `delivery.html` | **FIX** — `apiFetch` вместо Bearer без токена |
| `settings.html` | **FIX** — Telegram URL без двойного `/api` |
| `assets/app.js` | OK |
| `theme-v2.css` | Открыто — дёрганье сайдбара на MPA |

### SEO (`seo/`)

| Модуль | Статус |
|--------|--------|
| `auditor.js` | **FIX** — try/catch на чтение HTML |
| `yandex.js` | **FIX** — дата снапшота = `endDate` |

---

## 4. Исправленные баги (в этой сессии)

| # | Severity | Проблема | Файл | Исправление |
|---|----------|----------|------|-------------|
| 1 | **Critical** | Регистрация в чужую компанию по названию | `server.js` | 409 если компания уже есть без invite |
| 2 | **High** | `/api/risk/:inn` — SQL column `name` | `server.js` | `company` |
| 3 | **High** | ReferenceError `proposalRow` в Telegram | `server.js` | `req.user.company`, `newProposal.price` |
| 4 | **High** | IDOR `/uploads/:filename` | `server.js` | `canAccessStoredFile()` |
| 5 | **High** | IDOR conversation-context | `server.js` | `canAccessOrderThread` |
| 6 | **High** | IDOR tasks API | `server.js` | `canAccessOrderThread` на GET/POST/PATCH |
| 7 | **High** | Telegram 404 (двойной `/api`) | `settings.html` | `${SERVER_URL}/telegram/...` |
| 8 | **High** | Delivery stage — фейковый успех | `delivery.html` | `apiFetch`, убран mock fallback |
| 9 | **Medium** | Cron закрывал закупку → нельзя принять КП | `server.js`, `index.html` | Статус `Дедлайн истёк`, UI-фильтр |
| 10 | **Medium** | `io.emit` без проверки | `server.js` | `if (io)` на аукционах |
| 11 | **Medium** | S3 ошибки не → 404 | `storage.js` | catch NoSuchKey |
| 12 | **Low** | SEO auditor падал на битом файле | `seo/auditor.js` | try/catch |
| 13 | **Low** | PDF stream error | `export-pdf.js` | `doc.on('error')` |
| 14 | **Low** | Гость на producer без закупок | `producer.html` | `/orders/public` |

---

## 5. Открытые проблемы (не исправлялись)

| # | Severity | Описание | Рекомендация |
|---|----------|----------|--------------|
| 1 | High | Поставщик видит **все** закупки всех заказчиков в `GET /api/orders` | Фильтр / публичные поля |
| 2 | Medium | `team_role` (viewer/member) не проверяется на invite/delete | Проверка `team_role === 'admin'` |
| 3 | Medium | `verifyPassword` plaintext fallback | Принудительный reset |
| 4 | Medium | `analytics.html` — демо-данные на prod | Убрать MOCK или явный флаг |
| 5 | Medium | Сайдбар дёргается при MPA-навигации | SPA layout / отдельный разбор |
| 6 | Low | `/api/risk/:inn` без auth | `requireAuth` или жёсткий rate limit |
| 7 | Low | Auction socket rooms не используются | Реализовать join или убрать |
| 8 | Low | `landing-hero.png` — проверить наличие на prod | Файл или redirect |

---

## 6. Что запустить вручную

```powershell
cd C:\Users\Админ\source\repos
npm test
npm start
# в другом терминале:
npm run test:e2e
# против staging/prod:
$env:MVP_SMOKE_RUN="1"
$env:MVP_SMOKE_BASE_URL="https://texzakaz.ru/api"
npm run smoke:api
```

### Smoke-чеклист после деплоя

- [ ] Login / register (без invite в существующую компанию → 409)
- [ ] Создание закупки, КП, accept
- [ ] Чат + контекстная панель
- [ ] Delivery stage update (`delivery.html`)
- [ ] Telegram link в settings
- [ ] PDF export `/api/export/orders.pdf`
- [ ] `/api/risk/7707083893` (тестовый ИНН) — не 500

---

## 7. Итог

- **Автотесты:** static-checks — OK  
- **Исправлено:** 14 багов (1 critical, 7 high, 4 medium/low)  
- **Отложено:** 8 известных проблем (см. раздел 5)  
- **Деплой:** `git push origin main` → GitHub Actions → VPS
