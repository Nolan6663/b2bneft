# SEO Analytics Module — Design Spec
Date: 2026-06-20

## Overview

SEO-модуль для B2B Нефтесервис маркетплейса. Три субпроекта в одном плане:
1. **SEO-аудит страниц** — статический анализ 19 HTML-файлов, работает сразу
2. **GSC-интеграция** — Google Search Console API + классификация интентов через Gemini, включается через env-переменную
3. **Яндекс.Вебмастер-интеграция** — Yandex Webmaster API, тот же паттерн enabled/disabled, данные в той же таблице `seo_snapshots` с колонкой `source`

Дашборд — только для администратора, новая вкладка в `admin.html`.

## Architecture

```
seo/
  auditor.js     — читает HTML-файлы с диска, возвращает [{page, score, issues}]
  gsc.js         — клиент GSC API (googleapis); disabled если нет GOOGLE_SERVICE_ACCOUNT_JSON
  yandex.js      — клиент Яндекс.Вебмастер API; disabled если нет YANDEX_WEBMASTER_TOKEN
  intents.js     — батч-классификация запросов по интентам через Gemini (reuses genAI)
server.js        — маршруты /api/seo/audit, /api/seo/sync, /api/seo/data (admin only)
admin.html       — вкладка «SEO»: панель аудита + панель поисковых запросов (Google + Яндекс)
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
  source      TEXT NOT NULL DEFAULT 'google',  -- 'google' | 'yandex'
  date        DATE NOT NULL,
  query       TEXT NOT NULL,
  page        TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  ctr         REAL NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  UNIQUE(source, date, query, page)
);
```
Upsert при каждой синхронизации. 90 дней истории. Данные Google и Яндекса хранятся в одной таблице и различаются по колонке `source`.

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

## Yandex Webmaster Integration (`seo/yandex.js`)

- Пакет: `node-fetch` (уже используется в проекте) или встроенный `fetch` Node 18+
- Auth: OAuth-токен из env `YANDEX_WEBMASTER_TOKEN` (получается один раз через браузер на oauth.yandex.ru)
- Host ID из env `YANDEX_WEBMASTER_HOST_ID` (числовой ID хоста в Вебмастере, виден в URL после авторизации)
- Если переменные не заданы — `yandex.enabled === false`

Endpoint API: `GET https://api.webmaster.yandex.net/v4/user/{userId}/hosts/{hostId}/search-queries/all-history`
- Параметры: `date_from`, `date_to`, `limit=500`, `offset`
- Возвращает: `queries[]` с полями `query_text`, `indicators: { IMPRESSIONS, CLICKS, CTR, POSITION }`
- Pagination: offset-based, тянем до исчерпания

Метод `fetchQueries(startDate, endDate)`:
- Получает `userId` через `GET /v4/user/` (одноразово при инициализации)
- Тянет данные постранично, нормализует в тот же формат что GSC: `{ source:'yandex', date, query, page, impressions, clicks, ctr, position }`
- `page` для Яндекса = `YANDEX_WEBMASTER_HOST_ID` (Вебмастер не разбивает по страницам в этом endpoint)

Синхронизация: тот же `POST /api/seo/sync` — вызывает и GSC, и Яндекс параллельно (`Promise.all`), upsert обоих в `seo_snapshots`.

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
  "yandexEnabled": false,
  "snapshots": [{ "source", "query", "page", "intent", "intent_ru", "impressions", "clicks", "ctr", "position", "delta" }],
  "lastSync": { "google": "2026-06-20T10:00:00Z", "yandex": null }
}
```

`delta` = разница позиций между последним и предпоследним снапшотом того же запроса (delta < 0 = позиция улучшилась, например было 5 стало 3 → delta = −2). В UI: delta < 0 показывается как `▲|delta|` зелёным, delta > 0 как `▼delta` красным.

## Admin UI (новая вкладка в `admin.html`)

### Панель «Аудит страниц»
- Кнопка «Запустить аудит»
- Таблица: страница | score (цветной бейдж: ≥80 зелёный, 50–79 жёлтый, <50 красный) | критических | предупреждений | дата
- Клик по строке → разворачивается список проблем с полем `fix`
- Фильтр по severity

### Панель «Поисковые запросы»
- Переключатель источника: **Google** / **Яндекс** / **Все**
- Если выбранный источник не настроен → баннер с инструкцией:
  - Google: добавить `GOOGLE_SERVICE_ACCOUNT_JSON` и `GOOGLE_SITE_URL` в Render
  - Яндекс: добавить `YANDEX_WEBMASTER_TOKEN` и `YANDEX_WEBMASTER_HOST_ID` в Render
- Кнопка «Синхронизировать» (синхронизирует оба источника параллельно, если оба включены)
- Таблица: источник (бейдж G/Я) | запрос | интент | страница | позиция | Δ | показы | CTR
- Фильтр по интенту
- График позиций топ-10 запросов за 90 дней (Chart.js — уже подключён, данные по выбранному источнику)

## Environment Variables

| Переменная | Где | Описание |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Render dashboard | JSON Service Account для GSC API |
| `GOOGLE_SITE_URL` | Render dashboard | URL сайта в GSC, напр. `https://b2bneft.onrender.com/` |
| `YANDEX_WEBMASTER_TOKEN` | Render dashboard | OAuth-токен Яндекс (получить на oauth.yandex.ru) |
| `YANDEX_WEBMASTER_HOST_ID` | Render dashboard | Числовой ID хоста в Яндекс.Вебмастере |

В `render.yaml` добавляются четыре новых `sync: false` ключа.

## Success Criteria

- `POST /api/seo/audit` возвращает score и issues для всех 19 страниц
- В admin.html видна вкладка SEO с таблицей страниц и проблем
- При `gscEnabled: false` и `yandexEnabled: false` показываются баннеры с инструкцией, не ошибка
- При `gscEnabled: true` sync пишет данные Google в `seo_snapshots` с `source='google'`
- При `yandexEnabled: true` sync пишет данные Яндекса в `seo_snapshots` с `source='yandex'`
- Переключатель G/Я/Все в UI фильтрует таблицу и график по источнику
- Интенты классифицируются и кэшируются в `seo_intents` (один раз для обоих источников — запрос один и тот же)
