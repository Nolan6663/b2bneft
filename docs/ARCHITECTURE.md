# Архитектура ТехЗаказ

Актуально на 03.07.2026. Дополнять при изменениях структуры; детальная история — в `readme.txt`.
(Предыдущая версия этого файла описывала эпоху Render+Resend+localStorage — всё изменилось.)

## Общая картина

```
Браузер (MPA, vanilla JS, без сборщика)
   │  HTML-страницы в корне репо; стили: assets/css/tokens.css (переменные) → theme-v2.css
   │  auth: access-JWT в cookie (+ Bearer fallback), refresh-токены в БД
   ▼
Node.js / Express 5 (server.js, PM2 process "neft", VPS /var/www/neft)
   ├── routes/*  — вынесенные роутеры (auth, orders, proposals, companies, messages, deals)
   ├── inline-роуты в server.js — admin, export, ai, auctions, reviews, favorites,
   │   notifications, push, telegram-link, team, templates, integrations, seo, map…
   ├── Socket.io — real-time чат, proposal:new, обновление дашбордов
   ├── node-cron — автозакрытие заявок/аукционов, напоминания о дедлайнах,
   │   уведомления «аукцион завершается через 10 минут»
   ├── lib/registry-invites.js — при новой закупке email top-20 заводам из реестра ГИСП
   └── telegram-bot.js (telegraf) — уведомления и привязка аккаунта
   ▼
PostgreSQL (Render; с dev-машин НЕдоступен — только с VPS)
S3/Cloudflare R2 — файлы (чертежи, КП, фото) через storage.js; локально fallback uploads/
```

## Модули и ответственность

| Файл/каталог | Что делает |
|---|---|
| `server.js` (~2.1k строк) | bootstrap: helmet/cors/rate-limit, auth middleware (`requireAuth`, `requireRole`, `requireVerifiedEmail`), маппинг строк БД → API-объектов (`rowToCompany` и др.), socket.io, cron'ы, email/push/TG-хелперы и интеграционные push-хелперы (Bitrix24/AmoCRM/SAP), оставшиеся inline-роуты — только инфраструктура (health, company-photos, registry-optout, auth/digest, rate-limiterы) |
| `db.js` | вся схема: 24 таблицы, создание при старте, «миграции» = `ALTER TABLE ... IF NOT EXISTS` внизу файла. Новая колонка → добавляй туда же |
| `routes/auth.js` | регистрация (+claim профиля из реестра по ИНН), login, 2FA (speakeasy), OAuth Яндекс, refresh-токены/сессии, сброс пароля, email-верификация |
| `routes/orders.js` | CRUD закупок, матчинг поставщиков (`computeMatchScore`), «горячий матч» ≥70% → email/push/TG, триггер registry-invites |
| `routes/proposals.js` | подача/редактирование/принятие/отклонение КП, файл КП, договор PDF (`GET /:id/contract.pdf`) |
| `routes/companies.js` | каталог/профили компаний, PUT профиля (вкл. реквизиты для договоров), фото |
| `routes/deals.js` | сделки = принятые КП; этапы поставки (`DELIVERY_STAGES`), timeline событий |
| `routes/messages.js` | чат по закупке (REST + socket.io), уведомления о сообщениях |
| `routes/export.js` | экспорт: Excel/PDF заявок и КП, PDF сравнения КП, CommerceML XML для 1С |
| `routes/auctions.js` | обратные аукционы: создание, ставки, списки (cron автозакрытия — в server.js) |
| `routes/reviews.js`, `routes/favorites.js` | отзывы после сделки; избранные поставщики |
| `routes/ai.js` | AI-поиск поставщиков (Gemini) + генерация ТЗ/КП (через lib/ai-client) |
| `routes/admin.js` | верификация компаний (ЕГРЮЛ-авто + ручная платформой) и админка (stats/users) |
| `routes/push.js`, `routes/telegram.js` | подписки Web Push; привязка/отвязка Telegram |
| `routes/team.js` | команда: участники, приглашения по email, публичный `/invitations/:token` |
| `routes/templates.js`, `routes/tasks.js`, `routes/notifications.js` | шаблоны закупок; задачи в чате сделки + контекст переписки; колокольчик |
| `routes/seo.js` | админ-SEO: аудит страниц, синк GSC/Я.Вебмастер, данные для дашборда |
| `routes/integrations.js` | CRUD подключений 1С/Bitrix24/AmoCRM/SAP |
| `routes/public.js` | публичная статистика, geo-density, карта заводов, биржа мощностей, каталог, риск-скоринг по ИНН, публичная карточка компании |
| `routes/analytics.js` | dashboard counts, CRM-стата поставщика, аналитика заказчика |
| `lib/integrations-push.js` | push принятого КП в Bitrix24/AmoCRM/SAP (`triggerIntegrations`, `sapB1Login`) — фабрика над pool |
| `lib/ai-client.js` | генерация ТЗ (заказчик) и сопроводительного письма КП (поставщик). Провайдер сменный через env; прод — GigaChat (нужен русский CA-сертификат из `certs/`, переменная в ecosystem.config.js) |
| `lib/auth-tokens.js` | JWT: access из cookie или Bearer-заголовка, refresh в таблице `refresh_tokens` |
| `lib/proposal-accept.js` | транзакция «принять КП»: статусы Выигран/Проигран, закрытие заявки, нотификации всем сторонам |
| `lib/registry-invites.js` | инвайты заводам-заглушкам: matchScore≥2, ≤1 письма/14 дней, ≤20/закупку, opt-out по HMAC-ссылке. Kill switch `REGISTRY_INVITES_ENABLED=0` |
| `lib/egrul-verify.js` | верификация компаний по ЕГРЮЛ |
| `export-pdf.js` | все PDF: заявки/КП/сравнение КП/договор+спецификация. Кириллица ТОЛЬКО через встроенный JetBrains Mono (`assets/fonts/pdf/`) — стандартная Helvetica её ломает. Рамка+title-block на каждой странице (`drawTitleBlocks`) |
| `storage.js` | абстракция файлов: S3/R2 если настроен, иначе локальный `uploads/` |
| `scripts/fetch-gisp-*.js`, `import-*.js` | пайплайн реестра ГИСП ПП-719 (4286 заводов-заглушек в каталоге). gisp.gov.ru блокирует VPS и VPN-выходы — скрейпинг с локальной машины БЕЗ VPN, импорт в БД — с VPS |

## Ключевые потоки

**Закупка → сделка:**
заказчик создаёт заявку (чертёж PDF/DWG/STEP, AI-помощник ТЗ) → матчинг: подходящим
поставщикам email/push/TG «горячий матч», заводам-заглушкам из реестра — invite-письмо →
поставщики подают КП (файл + цена + срок + сообщение) → заказчик сравнивает (таблица,
взвешенный скоринг, бенчмарк цен по категории, PDF для руководства) → принимает КП
(`lib/proposal-accept.js`: победитель/проигравшие, заявка закрыта) → сделка: чат,
договор+спецификация PDF, этапы поставки (`delivery_events`), приёмка → отзыв.

**Уведомления (fan-out при любом событии):** колокольчик в UI (таблица `notifications`) +
email (SMTP/nodemailer) + Web Push (VAPID) + Telegram (если привязан). Хелперы в
`server.js`, зовутся из роутов параллельно.

**Auth:** пароль (+опционально TOTP 2FA) или Яндекс OAuth → access-JWT (cookie, 1ч) +
refresh-токен (БД; страница «Активные сессии» в settings). `window.open` на скачивание
файлов/PDF работает за счёт cookie.

## Данные (группы таблиц)

- **Учётки:** users, refresh_tokens, password_reset_tokens, email_verification_tokens, invitations (команда)
- **Компании:** companies (профиль + реквизиты договоров + geo + реестр: claimed/source/invites_sent), company_photos, verification_requests, reviews, favorites
- **Сделки:** orders, proposals, delivery_events, order_events (лог), order_templates, messages, notifications
- **Аукционы:** auctions, auction_bids
- **Прочее:** tasks, integrations (1С/Bitrix24/AmoCRM), push_subscriptions, seo_audits/snapshots/intents

Связь заказчик↔компания — **по строковому имени компании** (`orders.company`,
`proposals.company`), не по FK. Историческое решение; переименование компании ломает
связи, поэтому название в настройках read-only.

## Инфраструктура

- **VPS** (РФ): `/var/www/neft`, PM2 (`ecosystem.config.js`, process `neft`), Node 20+.
- **Деплой:** push в `main` → GitHub Actions (`.github/workflows/deploy.yml`) → SSH →
  `git reset --hard` + `npm install --production` + `pm2 restart neft`.
- **БД:** PostgreSQL на Render. Доступна только с VPS — все скрипты импорта гонять там.
- **Файлы:** Cloudflare R2 (S3 API) через `storage.js`.
- **Telegram:** api.telegram.org с VPS заблокирован (сетевой уровень) → split-tunnel
  AmneziaWG: только CIDR Телеграма идут через self-hosted сервер в Финляндии, остальной
  трафик (БД, GigaChat, SSH) — напрямую. Детали в readme.txt.
- **AI:** GigaChat (Sber) через OAuth + русский trusted root CA (`certs/`), западные
  API (Groq и т.п.) блокируют запросы из РФ.
- **Мониторинг:** Sentry (`SENTRY_DSN`), `/api/health` (ok+db), Яндекс.Метрика на фронте.

## Ловушки (стоили реальных инцидентов)

1. `pm2 restart neft` НЕ перечитывает `ecosystem.config.js` — только `pm2 delete neft && pm2 start ecosystem.config.js`.
2. `NODE_ENV` был в `.env` вместо ecosystem → прод месяц работал в development-режиме (не-Secure cookies, dev-сид, lax CORS). Исправлено 02.07.2026, не повторять.
3. `NODE_EXTRA_CA_CERTS` Node читает один раз при старте процесса — только через ecosystem.config.js.
4. Тестовая закупка на проде без `REGISTRY_INVITES_ENABLED=0` шлёт письма до 20 реальным заводам.
5. pdfkit + Helvetica = кракозябры вместо кириллицы. Только зарегистрированные TTF из `assets/fonts/pdf/`.
6. `theme-v2.css` содержит дублированные селекторы, каскад зависит от порядка правил — не пересортировывать; переменные править в `assets/css/tokens.css` (+bump `?v=` в @import первой строки theme-v2.css).
7. Один AmneziaWG-пир = одно устройство. Тот же конфиг со второго устройства — сервер флип-флопит endpoint, трафик молча умирает.

## CI

Пуш в `main` сначала проходит job `check` (npm ci → `npm run check` → юнит-тесты
`tests/unit` → pdf-smoke) и только потом деплоится. Битый синтаксис/HTML и
регрессии в покрытых роутерах до прода не доедут; сквозной флоу по-прежнему
проверять вручную после значимых изменений.

## Известные долги

- `server.js` — остатки: public/misc-роуты (dashboard, map, catalog, capacity, risk, analytics) + интеграционные push-хелперы можно увести в lib/.
- Публичного partner-API нет (карточка в settings честно говорит «в разработке»); экспорт 1С есть.
- Тесты: юниты на критичные роуты есть (tests/unit — fakePool, без БД, гоняются в CI); полного покрытия нет.
