# SEO Analytics Module — Design Spec
Date: 2026-06-20

## Overview

SEO-модуль для B2B Нефтесервис маркетплейса. Два субпроекта в одном плане:
1. **SEO-аудит страниц** — статический анализ 19 HTML-файлов, работает сразу
2. **GSC-интеграция** — Google Search Console API + классификация интентов через Gemini, включается через env-переменную

Дашборд — только для администратора, новая вкладка в `admin.html`.

## Architecture

```
seo/
  auditor.js     — читает HTML-файлы с диска, возвращает [{page, score, issues}]
  gsc.js         — клиент GSC API (googleapis); disabled если нет GOOGLE_SERVICE_ACCOUNT_JSON
  intents.js     — батч-классификация запросов по интентам через Gemini (reuses genAI)
server.js        — маршруты /api/seo/audit, /api/seo/sync, /api/seo/data (admin only)
admin.html       — вкладка «SEO»: панель аудита + панель GSC-запросов
```

## Data Model

### `seo_audits`
```sql
CREATE TABLE IF NOT EXISTS seo_audits (
  id         SERIAL PRIMARY KEY,
  page       TEXT NOT NULL,
  score      INTEGER NOT NULL,
  issues     JSONB NOT NULL,
  audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
Накапливает историю — виден прогресс score после правок.

### `seo_snapshots`
```sql
CREATE TABLE IF NOT EXISTS seo_snapshots (
  id          SERIAL PRIMARY KEY,
  date        DATE NOT NULL,
  query       TEXT NOT NULL,
  page        TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  ctr         REAL NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  UNIQUE(date, query, page)
);
```
Upsert при каждой синхронизации. 90 дней истории.

### `seo_intents`
```sql
CREATE TABLE IF NOT EXISTS seo_intents (
  query         TEXT PRIMARY KEY,
  intent        TEXT NOT NULL,
  intent_ru     TEXT NOT NULL,
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
Кэш классификаций. Повторный запрос не идёт в Gemini API.

## SEO Auditor (`seo/auditor.js`)

Парсит HTML строками (без внешних зависимостей). Проверки:

| Проверка | Severity | Штраф |
|---|---|---|
| `<title>` отсутствует или < 10 символов | critical | −20 |
| `<title>` > 60 символов | warning | −5 |
| `<meta description>` отсутствует | critical | −20 |
| `<meta description>` < 50 или > 160 символов | warning | −5 |
| `<h1>` отсутствует | critical | −20 |
| Более одного `<h1>` | warning | −5 |
| `robots: noindex` | critical | −20 |
| `<link rel="canonical">` отсутствует | info | −2 |
| OG-теги отсутствуют (`og:title`, `og:description`) | info | −2 |
| Пустой `alt=""` у изображений | warning | −5 |
| Нет внутренних ссылок `href="*.html"` | warning | −5 |

Score = max(0, 100 − сумма штрафов).

Каждая проблема: `{ type, severity, message, fix }` — `fix` содержит конкретное действие.

Endpoint: `POST /api/seo/audit` (requireAuth + admin check)
- Читает все `*.html` из корня проекта
- Upsert в `seo_audits` (новая строка на каждый запуск, история сохраняется)
- Возвращает массив результатов

## GSC Integration (`seo/gsc.js`)

- Пакет: `googleapis` (npm)
- Auth: Service Account JSON из env `GOOGLE_SERVICE_ACCOUNT_JSON` (строка JSON)
- Site URL из env `GOOGLE_SITE_URL` (например `https://b2bneft.onrender.com/`)
- Если переменные не заданы — `gsc.enabled === false`, эндпоинты возвращают `{ enabled: false }`

Метод `fetchSearchAnalytics(startDate, endDate)`:
- Dimensions: `['query', 'page']`
- Тянет данные за 90 дней при первом sync, потом только за последние 7 дней

Endpoint: `POST /api/seo/sync` (admin only)
- Вызывает `gsc.fetchSearchAnalytics()`
- Upsert в `seo_snapshots`
- Передаёт новые запросы в `intents.js` для классификации (только те, которых нет в `seo_intents`)
- Возвращает `{ synced: N, newQueries: M }`

## Intent Classification (`seo/intents.js`)

- Reuses `genAI` из `server.js` (передаётся как аргумент)
- Батч по 50 запросов в один промпт
- Промпт на русском, результат JSON: `[{ query, intent, intent_ru }]`
- 4 интента: `informational` / `commercial` / `navigational` / `transactional`
- Результат пишется в `seo_intents` (upsert)

## API Endpoints

| Method | Path | Auth | Описание |
|---|---|---|---|
| POST | `/api/seo/audit` | admin | Запуск аудита всех HTML-страниц |
| POST | `/api/seo/sync` | admin | Синхронизация с GSC + классификация интентов |
| GET | `/api/seo/data` | admin | Данные для дашборда (последний аудит + снапшоты) |

`GET /api/seo/data` возвращает:
```json
{
  "audit": [{ "page", "score", "issues", "audited_at" }],
  "gscEnabled": true,
  "snapshots": [{ "query", "page", "intent", "intent_ru", "impressions", "clicks", "ctr", "position", "delta" }],
  "lastSync": "2026-06-20T10:00:00Z"
}
```

`delta` = разница позиций между последним и предпоследним снапшотом того же запроса (отрицательное = позиция улучшилась).

## Admin UI (новая вкладка в `admin.html`)

### Панель «Аудит страниц»
- Кнопка «Запустить аудит»
- Таблица: страница | score (цветной бейдж: ≥80 зелёный, 50–79 жёлтый, <50 красный) | критических | предупреждений | дата
- Клик по строке → разворачивается список проблем с полем `fix`
- Фильтр по severity

### Панель «Поисковые запросы»
- Если `gscEnabled: false` → баннер с инструкцией (добавить `GOOGLE_SERVICE_ACCOUNT_JSON` и `GOOGLE_SITE_URL` в Render)
- Если включено:
  - Кнопка «Синхронизировать»
  - Таблица: запрос | интент | страница | позиция | Δ | показы | CTR
  - Фильтр по интенту
  - График позиций топ-10 запросов за 90 дней (Chart.js — уже подключён)

## Environment Variables

| Переменная | Где | Описание |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Render dashboard | JSON Service Account для GSC API |
| `GOOGLE_SITE_URL` | Render dashboard | URL сайта в GSC, напр. `https://b2bneft.onrender.com/` |

В `render.yaml` добавляются два новых `sync: false` ключа.

## Success Criteria

- `POST /api/seo/audit` возвращает score и issues для всех 19 страниц
- В admin.html видна вкладка SEO с таблицей страниц и проблем
- При `gscEnabled: false` показывается баннер с инструкцией, не ошибка
- При `gscEnabled: true` (после настройки) sync пишет данные в БД, таблица запросов отображается
- Интенты классифицируются и кэшируются в `seo_intents`
