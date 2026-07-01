================================================================================
  ТЕХЗАКАЗ — B2B платформа прямых закупок для нефтесервисного рынка России
  texzakaz.ru
================================================================================

ОПИСАНИЕ ПРОЕКТА
----------------
Маркетплейс прямых закупок между нефтесервисными заказчиками и производителями/
поставщиками. Заказчики размещают заявки на детали, оборудование, РТИ и др.
Поставщики подают коммерческие предложения (КП). Платформа сопровождает сделку
от заявки до подтверждения поставки.

Домен: texzakaz.ru
Репозиторий: github.com/Nolan6663/b2bneft
Деплой (production): VPS, автодеплой через GitHub Actions (push → SSH → pm2 restart)
Сервер: /var/www/neft/
PM2 процесс: neft
Альтернатива: render.yaml (Render.com) — legacy/тестовый стенд, не основной prod

ВАЖНО — ВЕДЕНИЕ ДОКУМЕНТАЦИИ:
  После каждого существенного изменения кода дополнять этот README.txt
  (раздел «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ» + при необходимости API/деплой/известные проблемы).
  Сделал — дополнил. Не копить правки «в голове».


СТЕК ТЕХНОЛОГИЙ
---------------
Backend:
  - Node.js + Express
  - PostgreSQL (pg pool)
  - Socket.io (real-time чат)
  - JWT (access + refresh токены, httpOnly cookies)
  - Nodemailer (SMTP email уведомления)
  - Multer (загрузка файлов — чертежи, фото)
  - AWS S3 / Cloudflare R2 (хранение файлов в production)
  - Speakeasy + QRCode (TOTP 2FA)
  - node-cron (email дайджест для поставщиков; автозакрытие заявок по deadline)
  - ExcelJS (экспорт .xlsx)
  - pdfkit (экспорт .pdf)
  - googleapis (Google Search Console — SEO sync)
  - @sentry/node (мониторинг ошибок)
  - @google/generative-ai (Gemini — AI поиск поставщиков, пока не работает)

Frontend:
  - Vanilla JS (без фреймворков)
  - HTML/CSS с CSS-переменными (тёмная/светлая тема)
  - Chart.js (аналитика)
  - Socket.io client
  - Yandex Maps API (карта поставщиков)

CI/CD:
  - GitHub Actions (.github/workflows/deploy.yml) — основной prod (VPS)
  - SSH deploy через appleboy/ssh-action
  - Секреты: VPS_HOST, VPS_USER, VPS_KEY
  - render.yaml — опциональный деплой на Render (health: GET /api/health)

Тесты:
  - npm test / npm run check — статические проверки (scripts/static-checks.js):
      синтаксис JS (server, db, lib/*, routes/*), inline-скрипты в HTML,
      баланс CSS-скобок, guardrails доступа, import server.js
  - npm run smoke:api — smoke API
  - npm run test:e2e — Playwright (tests/e2e/)


СТРУКТУРА ФАЙЛОВ
----------------
server.js          — точка входа Express: middleware, Socket.io, оставшиеся
                     inline-роуты (dashboard, catalog, SEO, reviews, team…),
                     монтирование роутеров из routes/
export-pdf.js      — генерация PDF-отчётов (закупки, КП)
db.js              — инициализация БД, CREATE TABLE, ALTER TABLE, seed данные
storage.js         — абстракция хранения файлов (локально / S3)
package.json       — зависимости
ecosystem.config.js — конфиг PM2
.env               — переменные окружения (не в git; шаблон — раздел ниже)

lib/
  auth-tokens.js   — JWT, cookies, hash/verify паролей, prod-проверка JWT_SECRET
  company-enrich.js — enrichCompany(): рейтинг, stats, фото, isFavorite
  egrul-verify.js  — fetchEgrulData (ФНС), evaluateAutoVerification (автоверификация)

routes/
  auth.js          — все /api/auth/*
  orders.js        — все /api/orders/*
  proposals.js     — /api/proposals/* + createOrderProposalsRouter → /api/order-proposals/*
  companies.js     — /api/companies/* + createTopSuppliersRouter → /api/top-suppliers
  messages.js      — все /api/messages/* (включая /stats)
  deals.js         — все /api/deals/* (список, complete, timeline, delivery)

assets/
  app.js           — общий JS для всех страниц (apiFetch, escapeHtml,
                     showToast, initNotifications, shouldUseMockData,
                     window.socket (Socket.io), tz:* CustomEvents,
                     window.__spaNavigate — заглушка MPA, без SPA-роутера)
  tariffs.js       — конфиг тарифов (launchMode, планы, цены)
  theme-v2.css     — глобальные стили (тёмная/светлая тема)
  deals-page.css, settings-page.css — page-specific CSS (атрибут data-spa-page-css)
  zakupki-cat.css, fonts.css, ui-animations.js

seo/               — GSC, Yandex Webmaster, SEO-аудит, интенты (auditor.js, gsc.js…)
docs/              — competitors.md, architecture.md, api.md, roadmap.md…
scripts/           — static-checks.js (npm run check), mvp-api-smoke.js
tests/e2e/         — Playwright e2e

УДАЛЕНО (мёртвый код, не использовался в runtime):
  users.json, orders.json, companies.json, proposals.json, messages.json,
  favorites.json, notifications.json — legacy JSON в корне репозитория

Страницы (HTML):
  index.html           — личный кабинет заказчика (закупки, КП, чат)
  producer.html        — личный кабинет поставщика
  login.html           — вход / регистрация / 2FA / invite flow
  settings.html        — настройки (профиль, 2FA, интеграции, команда, дайджест)
  messages.html        — переписка (чат по заявкам)
  deals.html           — сделки (история, панель, трекинг, отзывы, Excel)
  analytics.html       — аналитика закупок (Chart.js, реальные данные из БД)
  catalog.html         — каталог поставщиков (фильтры, карточки, AI поиск)
  company-profile.html — профиль компании (реквизиты, фото, отзывы)
  delivery.html        — трекинг поставки (этапы, трек-номер)
  deliveries.html      — список всех поставок
  zakupki.html         — публичный реестр закупок (для незарегистрированных)
  zakupki/metall.html, armatura.html, elektro.html, rti.html — категории
  map.html             — карта поставщиков (Yandex Maps)
  favorites.html       — избранные поставщики
  proposals.html       — входящие КП (для поставщика)
  partners.html        — партнёры платформы
  landing.html         — лендинг
  dlya-postavshchikov.html — лендинг для поставщиков
  admin.html           — панель администратора (верификация, SEO)
  tariff.html          — страница тарифов (UI; оплата не подключена)
  404.html             — страница ошибки


БАЗА ДАННЫХ (PostgreSQL)
------------------------
Таблицы:

users                — аккаунты (email, password hash, role, company, inn,
                       email_verified, totp_secret, totp_enabled,
                       team_role, digest_frequency)

companies            — профили компаний (реквизиты, специализация, оборудование,
                       фото, сертификаты, геокоординаты, verified_by_platform,
                       verified_egrul, egrul_verified_at)

orders               — заявки на закупку (title, category, status, deadline,
                       quantity, description, drawing, company)

proposals            — коммерческие предложения (order_id, price, days,
                       company/supplier, status, kp_file, delivery_stage)

messages             — переписка (order_id, company, sender, text, read)

notifications        — уведомления в платформе

tasks                — задачи по сделкам (order_id, title, due_date, status)

reviews              — отзывы после сделок (from_company, to_company,
                       score 1-5, text, order_id — уникален per order+пара)

order_templates      — шаблоны закупок (title, category, description,
                       quantity, deadline_days, company)

invitations          — приглашения в команду (token, email, company, role,
                       team_role, invited_by, accepted, expires_at)

integrations         — настройки интеграций (company, provider, config JSONB)

favorites            — избранные поставщики

company_photos       — фотографии компаний

delivery_events      — этапы трекинга поставок

order_events         — аудит статусов закупок (event_type, title, detail, actor)

verification_requests — заявки на верификацию

refresh_tokens       — JWT refresh токены

password_reset_tokens — токены сброса пароля

email_verification_tokens — токены подтверждения email

seo_audits, seo_snapshots, seo_intents — SEO аналитика

Роли пользователей: 'customer' (заказчик), 'producer' (поставщик), 'admin'
team_role (внутри компании): 'admin', 'member', 'viewer'


ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (.env)
---------------------------
NODE_ENV=production
PORT=5000
DATABASE_URL=postgresql://user:password@host:5432/dbname
JWT_SECRET=длинная_случайная_строка
APP_URL=https://texzakaz.ru

# Email (SMTP через Nodemailer; без SMTP_* письма не отправляются)
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=noreply@texzakaz.ru

# Яндекс OAuth (вход через Яндекс ID)
YANDEX_CLIENT_ID=
YANDEX_CLIENT_SECRET=
YANDEX_REDIRECT_URI=https://texzakaz.ru/api/auth/yandex/callback

# CORS (доп. origin через запятую, кроме APP_URL)
CORS_ORIGIN=

# Геокодирование компаний при старте сервера (true/false)
GEOCODE_ON_START=false

# Файлы (Cloudflare R2 / S3)
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_URL=https://cdn.texzakaz.ru

# Карты
MAP_PROVIDER=yandex
YANDEX_MAPS_API_KEY=

# AI (Gemini — поиск поставщиков в каталоге; ключ AIzaSy... из Google AI Studio)
GEMINI_API_KEY=

# AI для генерации ТЗ закупки (отдельно от Gemini)
# DeepSeek: https://platform.deepseek.com — ключ sk-...
# OpenAI: AI_TZ_BASE_URL=https://api.openai.com/v1  AI_TZ_MODEL=gpt-4o-mini
# OpenRouter: AI_TZ_BASE_URL=https://openrouter.ai/api/v1  AI_TZ_MODEL=...
AI_TZ_API_KEY=
AI_TZ_BASE_URL=https://api.deepseek.com
AI_TZ_MODEL=deepseek-chat

# Google Search Console / SEO
GOOGLE_SERVICE_ACCOUNT_JSON=
GOOGLE_SITE_URL=
YANDEX_WEBMASTER_TOKEN=
YANDEX_WEBMASTER_HOST_ID=

# Мониторинг
SENTRY_DSN=

# Сид данных (только dev)
SEED_ADMIN=false
SEED_DEMO_DATA=false
ADMIN_EMAIL=admin@platform.ru
ADMIN_PASSWORD=


КЛЮЧЕВЫЕ API ЭНДПОИНТЫ
-----------------------
Служебные:
  GET  /api/health               — healthcheck (БД, storage: s3|local)

Auth:
  POST /api/auth/register        — регистрация (поддерживает inviteToken)
  POST /api/auth/login           — вход (поддерживает TOTP)
  POST /api/auth/logout
  POST /api/auth/refresh
  GET  /api/auth/me              — текущий пользователь (email, role, emailVerified,
                                   totpEnabled, digest_frequency, id)
  POST /api/auth/2fa/setup       — генерация QR для 2FA
  POST /api/auth/2fa/confirm     — активация 2FA
  POST /api/auth/2fa/disable
  PATCH /api/auth/digest         — настройка email дайджеста (daily/weekly/never)
  POST /api/auth/forgot-password
  POST /api/auth/reset-password
  POST /api/auth/verify-email
  POST /api/auth/resend-verification
  PUT  /api/auth/password        — смена пароля
  PUT  /api/auth/email           — смена email (сбрасывает email_verified)
  GET  /api/auth/yandex          — редирект на Яндекс OAuth
  GET  /api/auth/yandex/callback — callback OAuth

Закупки (Orders):
  GET    /api/orders             — список заявок компании
  GET    /api/orders/public      — публичный реестр (без auth)
  GET    /api/orders/match-scores — match-score для поставщика
  GET    /api/orders/:orderId/drawing — скачать чертёж (с проверкой доступа)
  POST   /api/orders             — создать заявку (multipart, чертёж; нужен verified email)
  PUT    /api/orders/:orderId    — редактировать
  POST   /api/orders/:orderId/cancel — отменить заявку

Предложения (Proposals / КП):
  GET  /api/proposals            — список КП (по роли)
  GET  /api/order-proposals/:orderId — КП по заявке
  POST /api/proposals            — подать КП (multipart; нужен verified email)
  POST /api/proposals/:proposalId/accept — принять КП (тригерит интеграции)
  POST /api/proposals/:proposalId/reject — отклонить КП
  PUT  /api/proposals/:proposalId — редактировать КП (поставщик)
  DELETE /api/proposals/:proposalId — удалить КП (поставщик)
  GET  /api/proposals/:proposalId/file — скачать файл КП

Сообщения:
  GET  /api/messages/conversations
  GET  /api/messages/:orderId/:company
  POST /api/messages             — отправить (+ email уведомление получателю)
  POST /api/messages/:orderId/:company/read
  GET  /api/messages/stats       — KPI (unread, total, replies today, avg response)
  GET  /api/conversation-context/:orderId/:company — контекст чата

Задачи по сделке:
  GET   /api/tasks
  POST  /api/tasks
  PATCH /api/tasks/:id

Сделки и поставки:
  GET  /api/deals                — список сделок
  PUT  /api/deals/:proposalId/complete — завершить сделку
  GET  /api/deals/:proposalId/delivery — этапы поставки
  POST /api/deals/:proposalId/delivery/stage — обновить этап

Компании:
  GET  /api/companies            — каталог поставщиков (фильтры)
  GET  /api/companies/:id        — профиль компании
  PUT  /api/companies/:id        — обновить профиль
  POST /api/companies/:id/photos — загрузить фото
  DELETE /api/companies/:id/photos/:photoId
  GET  /api/top-suppliers        — топ поставщиков для виджета
  GET  /api/catalog              — каталог (auth)
  GET  /api/map                  — точки на карте
  GET  /api/capacity             — мощности
  GET  /api/config/maps          — ключ карт для фронта
  GET  /api/dashboard/counts     — счётчики для дашборда
  GET  /api/public/stats         — публичная статистика
  GET  /api/producer/crm-stats   — CRM-статистика поставщика

Отзывы:
  POST /api/reviews                          — оставить отзыв (только после сделки)
  GET  /api/reviews/company/:name            — отзывы о компании
  GET  /api/reviews/check/:orderId/:toCompany — проверить, есть ли уже отзыв

Шаблоны закупок:
  GET    /api/templates
  POST   /api/templates
  DELETE /api/templates/:id

Команда:
  GET    /api/team/members
  POST   /api/team/invite          — пригласить по email (токен, 7 дней)
  DELETE /api/team/members/:id
  DELETE /api/team/invites/:id
  GET    /api/invitations/:token   — публичный, для prefill формы регистрации

Интеграции:
  GET    /api/integrations
  POST   /api/integrations/:provider      — сохранить конфиг
  POST   /api/integrations/:provider/test — проверить подключение
  DELETE /api/integrations/:provider

Экспорт:
  GET /api/export/orders.xlsx     — Excel закупок (заказчик)
  GET /api/export/proposals.xlsx  — Excel КП (заказчик или поставщик)
  GET /api/export/orders.pdf      — PDF закупок (заказчик)
  GET /api/export/proposals.pdf   — PDF КП (заказчик или поставщик)
  GET /api/export/compare-kp.pdf  — PDF сравнения КП по заявке (заказчик)
  GET /api/export/1c/:proposalId  — CommerceML XML для 1С

Закупки (доп.):
  GET /api/orders/:orderId/matched-suppliers  — match-score поставщиков для заявки
  GET /api/orders/:orderId/price-benchmark    — бенчмарк цен по категории (6 мес.)
  GET /api/orders/public/category-benchmark   — публичный бенчмарк по категории

Риск (без UI):
  GET /api/risk/:inn              — базовая проверка по ЕГРЮЛ

Аналитика:
  GET /api/customer/analytics    — KPI, динамика, категории, топ поставщики

AI:
  POST /api/ai-search            — поиск поставщиков через Gemini
  POST /api/ai/generate-tz       — генерация ТЗ закупки (DeepSeek / OpenAI-compatible)
  GET  /api/ai/tz-status         — настроен ли AI для ТЗ, имя модели

Уведомления:
  GET    /api/notifications/:company
  POST   /api/notifications/:company/read
  DELETE /api/notifications/:company

Избранное:
  GET    /api/favorites
  POST   /api/favorites
  DELETE /api/favorites/:companyId

Верификация компаний (admin.html + авто ЕГРЮЛ):
  POST /api/verification/request   — автопроверка ЕГРЮЛ или заявка платформе
                                     (body: { platformTier: true } — только ручная)
  GET  /api/verification/status    — none | pending | approved_egrul | approved | rejected
  GET  /api/verification/requests  — очередь (admin)
  POST /api/verification/:id/approve
  POST /api/verification/:id/reject

SEO (admin.html):
  GET  /api/seo/data
  POST /api/seo/audit
  POST /api/seo/sync

Файлы:
  GET /api/company-photos/:filename — фото компании (S3 или local)
  GET /uploads/:filename            — legacy uploads (auth)


ЧТО РЕАЛИЗОВАНО
---------------
Аутентификация и безопасность:
  [x] JWT access + refresh токены (httpOnly cookies)
  [x] Подтверждение email
  [x] Сброс пароля по email
  [x] TOTP двухфакторная аутентификация (speakeasy, QR-код)
  [x] Rate limiting на auth endpoints
  [x] Helmet, CORS, XSS защита
  [x] Яндекс OAuth

Закупки:
  [x] CRUD заявок с загрузкой чертежей
  [x] Шаблоны закупок (сохранить → создать из шаблона в 1 клик)
  [x] Публичный реестр по категориям (metall, armatura, elektro, rti)
  [x] SEO-оптимизированные страницы категорий

Коммерческие предложения:
  [x] Подача КП с файлом
  [x] Принятие/отклонение с email уведомлениями
  [x] Автоматический тригер интеграций при принятии КП
  [x] Сравнение КП в одной таблице (index.html, deals.html)
  [x] Preview чертежей PDF/изображений в браузере (?inline=1)

Закупки (доп.):
  [x] Match-score для заказчика + блок «Кому подходит закупка»
  [x] Match-score с причинами (reasons[]) для поставщика
  [x] «Горячий матч» ≥70% — push/Telegram + выделение в UI (producer.html)
  [x] Бенчмарк цен по платформе (медиана / диапазон по категории)
  [x] Публичный бенчмарк на zakupki.html
  [x] PDF сравнения КП (export-pdf.js, кнопка в index.html)
  [x] Автозакрытие заявок по deadline (cron 08:00 МСК) + email
  [x] Напоминание заказчику за 3 дня до дедлайна
  [x] Email поставщику о новой подходящей закупке (match ≥ 50%)

Переписка:
  [x] Real-time чат через Socket.io (см. раздел REAL-TIME ниже)
  [x] Email уведомления при новом сообщении получателю
  [x] Контекстная панель (реквизиты поставщика, задачи, КП файл)
  [x] Задачи по сделке (create, toggle done)
  [x] KPI карты с реальными данными (unread, total, avg response)

Сделки и поставки:
  [x] Трекинг этапов поставки
  [x] Экспорт в 1С (CommerceML 2.09 XML)
  [x] Экспорт в Excel (.xlsx, стилизованные заголовки)
  [x] Экспорт в PDF (.pdf) — закупки и КП
  [x] Отзывы после завершения сделки (1-5 звёзд + текст)

Аналитика:
  [x] KPI карты (объём, экономия, время отклика, конверсия)
  [x] Динамика по месяцам — реальные данные из БД (последние 6 мес.)
  [x] Воронка закупок (реальные счётчики)
  [x] Топ поставщики по объёму выигранных сделок
  [x] Разбивка по категориям

Профиль компании:
  [x] Реквизиты, специализация, оборудование
  [x] Загрузка фотографий производства
  [x] ISO и качественные сертификаты
  [x] Производственные мощности
  [x] Верификация платформой (ручная, admin.html)
  [x] Автоверификация по ЕГРЮЛ (бесплатно, lib/egrul-verify.js) — знак «Проверено по ЕГРЮЛ»
  [x] Два уровня: verified_egrul (авто) и verified_by_platform (ручная, выше)
  [x] Рейтинг надёжности (A+/A/B+/B/C) на основе статистики КП
  [x] Отзывы от заказчиков (с датой, компанией, звёздами)
  [x] Геокодирование (Yandex) и карта

Команда:
  [x] Приглашение сотрудников по email (токен, 7 дней)
  [x] Роли в команде (admin/member/viewer)
  [x] Управление участниками и отзыв инвайтов
  [x] Регистрация по invite-ссылке (prefill компании, email, роли)

Настройки:
  [x] 2FA (setup → QR → confirm → disable)
  [x] Email дайджест для поставщиков (daily/weekly/never, cron 09:00 МСК)
  [x] Интеграции: 1С (CommerceML), Bitrix24 (webhook), AmoCRM (Bearer token),
      SAP Business One (Service Layer REST), SAP S/4HANA (OData REST)
  [x] Все интеграции тригерятся при принятии КП (non-blocking)

Email уведомления (SMTP через Nodemailer):
  [x] Подтверждение email при регистрации
  [x] Новый отклик (КП) на заявку заказчика
  [x] КП принято / отклонено (поставщику)
  [x] Новое сообщение в чате (получателю, fire-and-forget)
  [x] Верификация одобрена / отклонена
  [x] Сброс пароля
  [x] Приглашение в команду (с ссылкой на invite flow)
  [x] Email дайджест новых заявок (cron, поставщикам)

SEO:
  [x] Статические страницы категорий с уникальным контентом
  [x] Категорийный навбар на странице закупок
  [x] SEO аудит (score, issues) в БД
  [x] Снапшоты из Google Search Console и Yandex Webmaster
  [x] Классификация поисковых интентов через AI
  [x] Брендинг «ТехЗаказ» в title / og / schema.org
  [x] Терминология: «прямые закупки» вместо «тендер» по публичным страницам
  [x] /favicon.ico → favicon.svg

Прочее:
  [x] AI-поиск поставщиков (Gemini — требует рабочий GEMINI_API_KEY)
  [x] Карта поставщиков (Yandex Maps)
  [x] Избранные поставщики
  [x] Тёмная/светлая тема
  [x] Тарифы UI (tariff.html, assets/tariffs.js) — режим launchMode: всё бесплатно
  [x] Блок тарифов на dlya-postavshchikov.html#tarify
  [x] Анализ конкурентов: docs/competitors.md


REAL-TIME (Socket.io)
---------------------
Клиент: assets/app.js — единый window.socket (withCredentials, JWT из httpOnly cookie).
Сервер: server.js — auth middleware на handshake, auto-join в комнату компании.

События сервер → клиент (в комнату company name):
  notification         — новое уведомление в колокольчике
  dashboard:refresh    — обновить badge сайдбара и уведомлений
  order:new            — новая подходящая закупка (поставщик)
  proposal:new         — новый отклик/КП (заказчик)
  deal:status          — смена этапа поставки / завершение сделки
  message              — новое сообщение в чате (обе стороны)
  conversation:update  — обновить список диалогов (messages.html)

События клиент → сервер:
  join-company         — комната компании (дублирует auto-join на connect)
  join-chat            — комната chat:{orderId}:{company} (модалка / messages.html)
  join-auction         — комната auction:{id}

CustomEvents на фронте (document):
  tz:message, tz:conversation:update, tz:order:new, tz:proposal:new, tz:deal:status
  tz:socket:connect, tz:socket:disconnect

Поллинг — только запасной вариант при обрыве сокета:
  messages.html — каждые 3 с (список + открытый чат), если socket.connected === false
  app.js modal chat — каждые 3 с, если сокет отключён
  badge уведомлений — 12 с; sidebar counts — 20 с

Нормальная задержка доставки: <1 с. Задержка ~7–8 с = сокет не работает, срабатывает поллинг.

Nginx (обязательно на prod для WebSocket):
  location /socket.io/ {
      proxy_pass http://127.0.0.1:5000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
  }
  После правки: nginx -t && systemctl reload nginx

Проверка в браузере: DevTools → Network → WS → /socket.io/ статус 101.
-------------------------------
  [x] AI-помощник для составления ТЗ (DeepSeek / OpenAI-compatible — AI_TZ_API_KEY)
  [x] UI-карточка риска поставщика (API /api/risk/:inn — catalog + company-profile)
  [x] Обратный аукцион для прямых закупок — авто-конвертация победившей ставки
      в сделку + уведомления (email/Telegram/колокольчик) при закрытии
  [ ] Тарифы / оплата (страница tariff.html есть; launchMode=true — всё бесплатно;
      биллинг и реальные платежи не подключены)
  [ ] Мобильное приложение (долгосрочно)
  [x] Web Push уведомления (settings.html + assets/sw.js + /api/push/* при VAPID в .env)
  [ ] Telegram-бот
  [ ] Разбить CSS на tokens/components/layout
  [x] Единая sticky-кнопка «Сохранить» на настройках
  [x] Пустые состояния и skeleton-загрузка
  [x] Таблицы → карточки на mobile (список заказов index.html ≤720px)
  [x] Command palette, таймлайн сделки


  • landing.html — FAQ: glass-панель, карточки-аккордеон; контакт info.texzakaz@gmail.com
  • Поддержка в сайдбаре (все страницы) → mailto:info.texzakaz@gmail.com

  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (02.07.2026 — завершение аукциона)
  --------------------------------------------------------------------------------
  • db.js — auction_bids.days, auctions.winner_proposal_id
  • lib/proposal-accept.js — acceptWonProposal(): общая логика принятия КП,
    вынесена из routes/proposals.js /accept, переиспользуется closeExpiredAuctions()
  • server.js — POST /api/auctions/:id/bid принимает days; closeExpiredAuctions()
    теперь авто-создаёт proposals('Выигран') из победившей ставки, шлёт
    email/Telegram/колокольчик победителю, заказчику и проигравшим участникам
  • producer.html — поле «Срок поставки» в форме ставки; слушатель auction:closed
    (toast + обновление списка аукционов)
  • index.html — слушатель auction:closed в панели заявки заказчика

  Проверка: npm run check

  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (01.07.2026 — кнопки, GigaChat, Telegram-бот через VPN)
  --------------------------------------------------------------------------------
  Визуал:
    • theme-v2.css, landing.html — .btn-primary/.lp-cta-primary: убран мягкий
      градиент + glow-тень, вместо этого плоская заливка + срезанный угол
      (clip-path) + жёсткая офсетная тень («штамп»); hover — сдвиг от тени,
      active — тень исчезает (кнопка «вжимается»). Убран старый
      !important-блок «HUMANIZATION», конфликтовавший с новым стилем.
    • landing.html — хедер: кнопка «Регистрация» переведена с инлайн-стилей на
      .lp-cta-primary; ссылки меню — анимированное подчёркивание на hover
      вместо смены цвета; тонкая градиентная линия снизу хедера вместо
      плоской серой.
    • landing.html — демо-модалка («Как работает ТехЗаказ»): убрана
      дублирующая inline-кнопка «Зарегистрироваться бесплатно» на шаге 4 (та
      же кнопка уже была в футере навигации и вела туда же).
    • index.html — иконка в .ai-tz-panel заменена с нечитаемой абстрактной
      кляксы на «искры» (стандартный AI-значок).

  AI-провайдер (lib/ai-client.js):
    • Groq (llama-3.3-70b-versatile) — подключили, но API вернул 403 Forbidden
      из РФ (гео-блокировка/комплаенс, ключ был рабочий).
    • Перешли на GigaChat (Sber): OAuth-обмен ключа на access_token (не
      статичный Bearer, как у OpenAI-совместимых), плюс обязателен Russian
      Trusted Root CA (certs/russian_trusted_root_ca.pem, скачан с gu-st.ru,
      лежит в репо) через NODE_EXTRA_CA_CERTS — без него TLS self-signed
      certificate error.
    • parseJsonFromLlm — fallback: если модель (GigaChat без строгого
      json_object режима) обернула JSON текстом, вырезаем первый {...} блок.
    • ecosystem.config.js — NODE_EXTRA_CA_CERTS перенесён сюда (в env: {}),
      т.к. Node читает эту переменную только при старте процесса — через
      .env/dotenv не сработает. Обычный `pm2 restart neft` теперь эту
      переменную переживает без танцев с env $(cat .env...).

  Telegram-бот — сеть и стабильность:
    • Баг: bot.launch() в telegram-bot.js вызывался без .catch(); при сетевой
      ошибке необработанный reject ронял ВЕСЬ процесс сервера, не только
      бота (Node 20 по умолчанию убивает процесс на unhandled rejection).
      Исправлено — лог ошибки + global.__tgBot = null, процесс живёт дальше.
    • Причина сетевой ошибки: VPS не может достучаться до api.telegram.org
      (ETIMEDOUT и по IPv4, и по IPv6) — блокировка на уровне сети РФ, не код.
    • Решение — AmneziaWG split-tunnel: только сети Telegram
      (149.154.160.0/20, 91.108.0.0/13-диапазоны, 95.161.64.0/20,
      185.76.151.0/24) маршрутизируются через собственный Amnezia-сервер
      пользователя в Финляндии; всё остальное (Postgres, GigaChat, SSH) — как
      обычно, напрямую.
    • На VPS: `apt install amneziawg` (PPA ppa:amnezia/ppa) не завёл модуль
      ядра → собрали amneziawg-go из исходников (нужен build-essential для
      CGO). Конфиг клиента (/etc/amnezia/amneziawg/awg0.conf) — реальные
      параметры обфускации (Jc/Jmin/Jmax/S1-S4/H1-H4) взяты с самого сервера
      (docker exec amnezia-awg2 cat /opt/amnezia/awg/awg0.conf), т.к.
      shareable vpn://-ссылка Amnezia содержит только шаблоны/диапазоны для
      генерации внутри приложения, не готовые значения.
    • Важно: один и тот же WireGuard-пир не может быть подключён с двух
      устройств одновременно — сервер путает эндпоинт, хендшейк проходит, но
      трафик не маршрутизируется обратно. Если повторится — завести отдельный
      пир под сервер через приложение Amnezia, не переиспользовать личный.
    • Автозапуск: `systemctl enable awg-quick@awg0`.

  Проверено на проде: curl https://api.telegram.org отвечает через туннель
  (HTTP/2 302), pm2 status стабилен (uptime растёт, рестартов не прибавляется).

  Незавершено: живая отправка Telegram-пуша (напоминание об аукционе) не
  проверена end-to-end на реально привязанном аккаунте — только что бот
  поднялся и API отвечает. Проверить через settings.html → «Подключить
  Telegram» на тестовом аккаунте, затем прогнать сценарий аукциона.

  Проверка: npm run check

  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (01.07.2026 — AI для поставщика, напоминание об аукционе)
  --------------------------------------------------------------------------------
  • lib/ai-client.js — generateProposalMessage(): AI-черновик сопроводительного
    текста к КП (для поставщика, симметрично generateProcurementTz для заказчика)
  • POST /api/ai/generate-proposal — генерация текста по брифу поставщика +
    контексту заявки (title/description/category), доступно роли producer
  • producer.html — панель «AI-помощник» в модалке отклика + поле
    «Сопроводительное сообщение» (proposalMessage)
  • db.js — proposals.message (TEXT), auctions.reminder_sent (BOOLEAN)
  • routes/proposals.js — message в POST/PUT /api/proposals
  • index.html — сообщение поставщика показывается в списке откликов заказчика
  • server.js — notifyAuctionsEndingSoon(): cron каждую минуту, за 10 мин до
    конца активного аукциона шлёт Telegram-пуш всем участвовавшим в ставках
    поставщикам (sendTelegramNotification + getUserIdsByCompany, переиспользованы
    из hot-match уведомлений); reminder_sent защищает от повторной отправки

  Проверено локально: заявка → аукцион → ставка → сгенерирован текст КП через
  GigaChat → через 70 сек cron поймал аукцион, reminder_sent выставлен в true.
  Реальная отправка в Telegram не проверялась (TELEGRAM_BOT_TOKEN не задан
  локально) — sendTelegramNotification no-op без токена, проверить на проде.

  Проверка: npm run check

  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (01.07.2026 — визуальная идентичность v3 «Чертёжный цех»)
  ----------------------------------------------------------------------------
  Дизайн-направление выбрано и задокументировано (без смены HTML-структуры,
  без новых шрифтов/библиотек) — см. docs/design/texzakaz-visual-identity.md.

  • assets/theme-v2.css — новый блок токенов «TZ VISUAL IDENTITY v3» в :root:
    --tz-stamp-orange/ink-navy/blueprint-blue/paper/graphite/verified-green,
    --tz-surface-elevated, --tz-border-strong, --tz-shadow-stamp, --tz-focus-ring,
    --tz-tick-size/color, --tz-stamp-tilt, --tz-mono-tracking. Существующие
    переменные не переопределены, только дополнение.
  • landing.html — hero: штамп-полоса (.lp-stamp-strip) вместо трёх одинаковых
    stat-карточек (#lp-stats); угловые «crop-mark» засечки на #lp-hero
    (.lp-crop-mark, скрыты на ≤900px); FAQ-панель (.lp-faq-panel) — убран
    backdrop-filter: blur, заменён на непрозрачный navy + чертёжная сетка.
  • .ai-tz-panel, .kp-rec-card, .cp-hero — хардкод #0B8FCE заменён на
    var(--tz-blueprint-blue); .kp-rec-card — убран backdrop-filter: blur
    (тот же анти-паттерн, что и в FAQ-панели лендинга).
  • Verified-бейджи (company-profile.html, catalog.html) — вид «оттиска
    печати» вместо круглой пилюли: .platform-verified-badge / .catalog-verified
    (моноширинный uppercase, двойная рамка, поворот -2deg) + модификатор
    --egrul для verified_egrul (синий) против оранжевого verified_by_platform.
  • index.html — .proc-detail-panel: одна угловая чертёжная засечка (::after),
    скрыта в mobile bottom-sheet (≤640px).

  Проверка: npm run check. Вручную — десктоп и ≤520px лендинг, FAQ-аккордеон,
  verified-бейджи на company-profile/catalog, sticky-панель закупки при скролле,
  bottom-sheet на мобиле (≤640px).

  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (30.06.2026 — AI-помощник ТЗ, DeepSeek)
  ----------------------------------------------------------------
  • lib/ai-client.js — OpenAI-compatible API (по умолчанию DeepSeek deepseek-chat)
  • POST /api/ai/generate-tz — генерация title + description + checklist по brief
  • GET /api/ai/tz-status — статус конфигурации
  • index.html — панель «AI-помощник для ТЗ» в модалке создания закупки
  • env: AI_TZ_API_KEY, AI_TZ_BASE_URL, AI_TZ_MODEL (Gemini только для ai-search)

  Проверка: npm run check


  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (30.06.2026 — демо, онбординг, рекомендация КП)
  ----------------------------------------------------------------
  1. landing.html — интерактивное демо «Посмотреть демо» (4 шага без входа):
     закупка Уплотнение РТИ DN150 → КП от 3 поставщиков → сравнение → рекомендация
     + CTA «Зарегистрироваться бесплатно» (login.html#register); glass-панель, progress dots,
     prefers-reduced-motion, мобильный bottom-sheet

  2. Онбординг (assets/app.js, assets/theme-v2.css):
     - ob_welcome_v2 / ob_checklist_v2 (миграция с ob_checklist)
     - markOnboardingStep / obCompleteStep: авто-шаги при заказе, каталоге, профиле с ИНН,
       настройках, просмотре заявок (producer), отправке КП
     - fix openModal в чеклисте (index.html?create=1 fallback)
     - celebration ob-cl-complete при 100%, safe-area над bottom nav

  3. Рекомендация КП (assets/app.js, index.html, theme-v2.css):
     - computeKpRecommendation() — веса: цена 40%, срок 25%, верификация 15%, рейтинг 10%, match 10%
     - renderKpRecommendationCard() в панели закупки (2+ КП) и вверху таблицы сравнения
     - kp-rank-badge вместо unicode-звёзд в renderKpCompareTable

  Проверка: npm run check


  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (30.06.2026 — UI без emoji)
  ----------------------------------------------------------------
  • assets/app.js — хелпер uiIcon() / uiIconLabel(); SVG вместо emoji в toast,
    уведомлениях, match-score, сравнении КП, таймлайне сделок, переключателе темы
  • index.html — блок «Бенчмарк по платформе», аукцион, ссылки на файл КП
  • producer.html, tariff.html, favorites.html, proposals.html, messages.html,
    supplier-public.html, zakupki/*.html — emoji заменены на SVG или текстовые метки
  • routes/orders.js — уведомления о матче без emoji в тексте


  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (30.06.2026 — UI без emoji)
  ----------------------------------------------------------------
  • assets/app.js — uiIcon(), uiIconLabel(), setAuctionBtnLabel(), kpFileLinkHtml()
  • Эмодзи в интерфейсе заменены на SVG-иконки (Feather-style) или текст
  • index.html — бенчмарк, аукцион, ссылки на файлы КП
  • producer.html, tariff.html, catalog.html, messages.html, company-profile.html
  • zakupki/*.html — метаданные карточек без emoji
  • routes/orders.js — уведомления о матче без emoji в тексте

  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (30.06.2026 — backlog sprint)
  ----------------------------------------------------------------
  P1 — UX:
  • index.html — мобильные карточки закупок (orders-mobile-list, ≤720px, как deals.html)
  • index.html — черновик закупки в localStorage (tz_order_draft_*), баннер «Восстановить»
  • catalog.html — фильтр «Только проверенные» (verifiedByPlatform / verifiedEgrul)
  • catalog.html — бейдж риска поставщика через GET /api/risk/:inn
  • db.js — таблица order_events; логирование create/update/cancel/close
  • routes/deals.js — таймлайн дополнен событиями order_events (аудит статусов)

  P2 — аналитика и polish:
  • GET /api/customer/analytics — dynamics[].avgDays и conversion по месяцам (sparklines)
  • analytics.html — CSV-экспорт по REAL-данным API; sparkline для времени и конверсии
  • catalog.html, deals.html — skeleton при загрузке; empty states (ранее index/deals)

  P3:
  • settings-page.css — sticky .form-row-actions для кнопок «Сохранить»
  • assets/app.js — command palette: карта, «Создать закупку», маршрут index.html?create=1
  • Web Push — уже wired (sw.js, settings, /api/push/*); нужны VAPID_* в .env на prod

  DEPLOY (nginx WebSocket): см. раздел REAL-TIME — location /socket.io/ обязателен на prod.

  Проверка: npm run check


  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (30.06.2026 — top-3 product features)
  ----------------------------------------------------------------
  1. Сравнение КП (index.html, assets/app.js, assets/theme-v2.css):
     - Чекбоксы в модалке откликов: выбор 2–4 КП
     - Sticky-панель «Сравнить» внизу экрана (kp-compare-bar)
     - Таблица сравнения: цена, срок, поставщик, верификация, статус, рейтинг
     - API order-proposals отдаёт verifiedByPlatform / verifiedEgrul

  2. Отзывы после сделок (deals.html):
     - Баннер «Оцените поставщика» для завершённых сделок без отзыва
     - GET /api/reviews/check/:orderId/:toCompany (исправлен orderId)
     - Модалка звёзд 1–5 + текст, кнопка в панели сделки
     - sessionStorage dismiss «Позже» — не блокирует основные потоки

  3. Умные уведомления (assets/app.js, routes/deals.js):
     - Toast при новом сообщении (если не на messages.html)
     - Socket deal:status — смена этапа поставки / завершение сделки
     - Email на критические этапы: Отгружен, Принят заказчиком, завершение
     - proposal:new и notification — без изменений (уже работали)

  4. Mobile UX:
     - deals.html + deals-page.css — карточки заказов при ≤720px
     - map.html — кнопка «Фильтры» + выдвижная панель категорий/региона

  Проверка: npm run check


  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (30.06.2026 — mobile responsive UX)
  ----------------------------------------------------------------
  Мобильная вёрстка (без изменений desktop вне @media):

  • assets/theme-v2.css — блок MOBILE UX ENHANCEMENTS:
      - --mobile-bottom-nav-height (safe-area)
      - touch targets ≥44px (кнопки, пагинация, proc-row)
      - font-size 16px в полях ввода (без zoom на iOS)
      - модалки / command palette — bottom sheet на ≤600–520px
      - toast над нижней навигацией
      - user-dropdown привязан к кнопке профиля в шапке (не к низу экрана)
      - графики max-height, профильные сетки в 1–2 колонки

  • messages.html — чат fullscreen с корректным отступом под bottom nav,
    кнопка «Назад» 44px, ширина пузырей 88%

  • map.html — заголовок/поиск в колонку, карта vh-based, список заводов
    с touch-friendly карточками

  • analytics.html — фильтры столбиком, графики и таблицы со скроллом

  • company-profile.html — hero и мета на узком экране

  • admin.html — KPI 1 колонка ≤480px, горизонтальный скролл таблицы

  • viewport meta на всех страницах кабинета/лендинга:
    width=device-width, initial-scale=1.0, viewport-fit=cover

  Breakpoints: 980 / 768 / 720 / 600 / 520 / 480 px
  Ручная проверка: iPhone Safari, Android Chrome, планшет 768px.


  ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (29.06.2026 — company-profile без ?id=)
  ----------------------------------------------------------------
  • company-profile.html — при открытии без ?id= подставляет ID своей
    компании из /api/auth/me или кеша _myCompanyId
  • UI профиля: светлая карточка вместо тёмного градиента; бейдж риска — SVG-иконки
  • map.html — фикс съезжающей вёрстки: карта/панели одной высоты, статистика не наезжает
  • analytics.html — null в рейтинге → «—»; sparkline скрыт без динамики; API: avgScore, avgResponseHours


ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (30.06.2026 — демо лендинга, онбординг, рекомендация КП)
------------------------------------------------------------------------
  • landing.html — интерактивное демо «Посмотреть демо»: 4 шага (закупка →
    КП → сравнение → выбор), full-screen modal / mobile bottom sheet, swipe,
    typewriter-анимация формы, prefers-reduced-motion
  • assets/app.js — markOnboardingStep(id): автозавершение шагов (order,
    catalog, profile, settings, browse, proposal); welcome ob_welcome_v2
    с 4 шагами в сетке 2×2; fix data-action=openModal; celebration 100%
  • assets/app.js — scoreProposalForRecommendation(), renderKpRecommendationCard(),
    kp-rank-badge вместо ★★★; карточка в detPanel и compare modal
  • assets/theme-v2.css — .kp-rec-card, .kp-rec-reasons; polish ob-modal/checklist;
    checklist над mobile bottom nav
  • index.html — рекомендация КП в панели деталей; markOnboardingStep при создании закупки
  • company-profile.html — markOnboardingStep('profile') при ИНН / сохранении
  • producer.html — markOnboardingStep('proposal') при отправке КП


ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (29.06.2026 — автоверификация ЕГРЮЛ)
----------------------------------------------------------------
  • lib/egrul-verify.js — запрос к egrul.nalog.ru (бесплатно), правила автопроверки
  • db.js — companies.verified_egrul, egrul_verified_at
  • POST /api/verification/request:
      - по умолчанию: авто ЕГРЮЛ (ИНН, действующая, возраст ≥6 мес., ОГРН, профиль)
      - при успехе: verified_egrul=true, status approved_auto, уведомление + email
      - при сбое ФНС / молодая компания: pending на ручную модерацию
      - platformTier:true — сразу ручная заявка (расширенная верификация)
  • UI: company-profile (две кнопки/бейджа), catalog, index, admin (approved_auto)
  • Платный API (DaData/Kontur) не требуется для базового уровня

  Деплой: push main → pm2 restart neft (миграция ALTER TABLE при старте db.js)


ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (29.06.2026 — realtime, багфиксы, тарифы, дифференциация)
--------------------------------------------------------------------------------
  Багфиксы:
    • assets/app.js — unhandledrejection для AbortError (View Transitions)
    • assets/app.js — SVG rotate в onboarding checklist (закрывающая скобка)
    • routes/messages.js — GET /api/messages/stats 500 (алиас orig vs m в SQL)

  Тарифы (UI, без оплаты):
    • assets/tariffs.js — launchMode: true (ранний доступ, всё бесплатно)
    • tariff.html — планы: Ранний доступ / Старт / Бизнес / Корпоративный
    • dlya-postavshchikov.html — публичный блок #tarify из tariffs.js

  Дифференциация vs конкуренты:
    • docs/competitors.md — сравнение с B2B-Center, Supl, Enex и др.
    • routes/orders.js — hot match ≥70% (push/Telegram), match-scores + reasons[]
    • GET /api/orders/public/category-benchmark, UI на zakupki.html
    • export-pdf.js — buildCompareKpPdf; GET /api/export/compare-kp.pdf
    • catalog.html — production load bar; producer.html — hot match badges

  Real-time (несколько итераций):
    • server.js — emitRealtime(), emitDashboardRefresh(); auto-join company на connect
    • routes/orders.js — order:new + dashboard:refresh поставщикам при новой заявке
    • routes/proposals.js — proposal:new + dashboard:refresh заказчику при новом КП
    • routes/messages.js — message + conversation:update в комнаты обеих компаний
      (раньше message шёл только в chat:* — без join-chat сообщения не доходили)
    • assets/app.js — window.socket, tz:* CustomEvents, поллинг только без сокета
    • messages.html — убран второй io() без auth; join-chat; dedup по msg.id
    • producer.html / index.html — слушатели tz:order:new / tz:proposal:new
    • Задержка ~7 с на prod = поллинг-фолбэк; норма <1 с при рабочем WebSocket

  Деплой: push main → GitHub Actions → pm2 restart neft
  Проверка: npm run check; DevTools WS /socket.io/ → 101


ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (29.06.2026 — рефакторинг backend + UI/SEO)
-----------------------------------------------------------------
  См. также update.txt — журнал фич до 23.06.

  РЕФАКТОРИНГ server.js (поэтапный, API не менялся — только структура кода):

  Шаг 1 — auth + чистка:
    • lib/auth-tokens.js — cookies, JWT, hash/verify, проверка JWT_SECRET в prod
    • routes/auth.js — все 16 эндпоинтов /api/auth/*
    • server.js — app.use('/api/auth', createAuthRouter(...))
    • assets/app.js — удалён отключённый SPA-роутер (~60 строк);
      осталась заглушка window.__spaNavigate = url => location.assign(url)
    • Удалены мёртвые JSON в корне: users.json, orders.json, companies.json,
      proposals.json, messages.json, favorites.json, notifications.json

  Шаг 2 — orders + proposals:
    • routes/orders.js — /api/orders/* (public, CRUD, drawing, match-scores,
      matched-suppliers, price-benchmark, producer-benchmark, cancel)
    • routes/proposals.js — /api/proposals/* + createOrderProposalsRouter
      для /api/order-proposals/:orderId
    • server.js — routesDeps + app.use для трёх роутеров;
      inline-обработчики orders/proposals удалены из server.js

  Шаг 3 — companies + messages + deals:
    • lib/company-enrich.js — computeProducerRating, enrichCompany и др.
      (используется роутерами и оставшимися inline-роутами: public/companies, favorites)
    • routes/companies.js — /api/companies/*, фото; createTopSuppliersRouter → /api/top-suppliers
    • routes/messages.js — /api/messages/* (conversations, thread, post, read, stats)
    • routes/deals.js — /api/deals/* (список, complete, timeline, delivery/stage)
    • server.js — расширен routesDeps (optionalAuth, enrichCompany, geocodeCity,
      handlePhotoUpload, canAccessOrderThread, rowToMessage, getIo);
      inline companies/messages/deals удалены

  Что ОСТАЛОСЬ в server.js (ещё не вынесено):
    dashboard, public/stats, catalog, map, capacity, SEO, CRM, reviews,
    templates, export, team, favorites, integrations, tasks, notifications,
    verification, admin, Socket.io, cron, статика

  scripts/static-checks.js — починен npm run check (раньше всегда падал):
    • deals-page.css убран из node --check (был ERR_UNKNOWN_FILE_EXTENSION)
    • CSS проверяется отдельно (theme-v2.css + deals-page.css)
    • Плейсхолдеры supplier-public.html (<!--COMPANY_ID-->, <!--CANONICAL_URL-->)
    • Guardrails доступа ищутся в server.js + routes/orders|proposals|messages.js
    • SPA-проверка заменена на MPA: window.__spaNavigate в app.js
    • settings.html — добавлен data-spa-page-css на settings-page.css

  UI / SEO (тот же период, без смены API):
    • index.html — «Итоги недели» из /api/deals (7 дней), без фейковых поставщиков
    • catalog.html — выравнивание строки поиска (иконка + поле + кнопка AI)
    • theme-v2.css — при свёрнутом сайдбаре скрывается только текст логотипа, не «Т»
    • SEO meta: landing, zakupki, dlya-postavshchikov, catalog, map
      (РТИ/мехобработка, texzakaz.ru, чертёж→КП, 1200+ заводов)

  Проверка перед деплоем:
    npm run check
    → Static checks passed: N HTML files, M inline scripts

  Деплой: push main → GitHub Actions → /var/www/neft → pm2 restart neft

ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (29.06.2026 — design refresh)
----------------------------------------------------
  См. также update.txt — подробный журнал.

  Frontend / UI:
    • SPA-роутер отключён — полная перезагрузка страниц (стабильная вёрстка)
    • Единый сайдбар: partials/sidebar.html + scripts/sync-sidebar.js
    • Группировка меню: Закупки / Сделки / Компания + Настройки / Поддержка
    • server.js — инъекция сайдбара при отдаче страниц кабинета (prod)
    • Настройки: вынесены стили в settings-page.css, вкладки на desktop/mobile
    • theme-v2.css: удалён дублирующий блок (~690 строк), кэш ?v=7
    • View Transitions: сайдбар статичен, контент плавно меняется
    • «Мой профиль» виден с первого кадра (CSS + initSidebarProfileLink)
    • KPI на index/deals: убраны фейковые sparklines и дельты «↑ 8%»
    • Аватар в настройках — фирменный градиент (navy/orange)

  После правки partials/sidebar.html:
    node scripts/sync-sidebar.js

  Деплой на prod:
    push в main → GitHub Actions → VPS /var/www/neft → pm2 restart neft
    Жёсткое обновление в браузере: Ctrl+Shift+R

  Проверить на texzakaz.ru:
    • Группированный сайдбар, без promo/support-блоков
    • Настройки: 5 вкладок на desktop
    • Нет ☆ после заголовков h2
    • KPI без фейковых процентов

ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (23.06.2026)
----------------------------------
  См. также update.txt — подробный журнал.

  Фичи:
    • PDF-экспорт закупок и КП (export-pdf.js, pdfkit)
    • Автозакрытие заявок по deadline + cron 08:00 МСК
    • Email: подходящая закупка поставщику, напоминание −3 дня, автозакрытие
    • Бенчмарк цен по категории (API + UI в index.html)
    • Match-score / «Кому подходит закупка» для заказчика
    • Сравнение КП, preview чертежей в браузере

  SEO / брендинг:
    • «ТехЗаказ», «прямые закупки», favicon.svg

  UI (частично, сайдбар — см. известные проблемы):
    • Убрана двойная оранжевая полоска active (ui-animations.js)
    • Упрощены стили sidebar, scroll только в .main-content
    • Попытка убрать дёрганье при переходах между страницами — не помогло


ИЗВЕСТНЫЕ ПРОБЛЕМЫ
------------------
  - Real-time на prod: если сообщения приходят с задержкой 3–8 с — WebSocket не
    проксируется nginx (см. раздел REAL-TIME). Нужен location /socket.io/

  - Сайдбар при MPA-переходах: частично смягчено (View Transitions, prefetch,
    единый partial). При дальнейших правках — node scripts/sync-sidebar.js

  - GEMINI_API_KEY: ключ формата AQ.* даёт 401 Unauthorized.
    Нужен ключ формата AIzaSy... из Google AI Studio с настроенным биллингом.
    До решения AI-поиск возвращает 503.

  - shouldUseMockData() = true на localhost → часть данных моковая в dev
    (намеренное поведение, в production моки не показываются).

  - Пакет resend удалён из зависимостей — email только через SMTP.

  - Аукцион и обычные КП по одной заявке: если заказчик одновременно ведёт
    аукцион и получает обычные КП по той же заявке, закрытие аукциона
    отклонит все прочие КП по этой заявке (та же логика, что при ручном
    accept). Это ожидаемое поведение, не баг.


ВАЖНЫЕ УТИЛИТЫ (assets/app.js)
-------------------------------
  SERVER_URL           — базовый URL API (автоопределяется по хосту)
  window.socket        — глобальный Socket.io клиент (null если нет сессии)
  apiFetch(url, opts)  — fetch с credentials: include и авторефрешем сессии
  hasSession()         — есть ли активная сессия (httpOnly cookies)
  applyAuthSession()   — сохранить userRole/company после login
  escapeHtml(str)      — XSS защита
  showToast(msg, type) — уведомления (success / error / warn)
  shouldUseMockData()  — true только на localhost / file:
  initNotifications()  — подгрузка badge уведомлений в шапке
  initSidebarBadges()  — badge непрочитанных сообщений в навбаре


ДЕПЛОЙ
------
При push в ветку main GitHub Actions автоматически:
  1. SSH на VPS (секреты: VPS_HOST, VPS_USER, VPS_KEY)
  2. git pull origin main
  3. npm install --production
  4. pm2 stop neft && pm2 delete neft
  5. env $(cat .env | grep -v '^#' | xargs) pm2 start ecosystem.config.js

Ручной деплой:
  ssh root@VPS_IP
  cd /var/www/neft
  git pull && npm install --production && pm2 restart all

Обновить переменную окружения:
  nano /var/www/neft/.env   (добавить/изменить строку KEY=value)
  pm2 restart all
================================================================================
Обновлено: 29.06.2026 — автоверификация ЕГРЮЛ (verified_egrul), realtime, тарифы
Подробности: update.txt (фичи до 23.06), docs/competitors.md, TEST-REPORT.md
================================================================================
