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
  - npm test / npm run check — статические проверки (scripts/static-checks.js)
  - npm run smoke:api — smoke API
  - npm run test:e2e — Playwright (tests/e2e/)


СТРУКТУРА ФАЙЛОВ
----------------
server.js          — весь бэкенд (Express роуты, Socket.io, логика)
export-pdf.js      — генерация PDF-отчётов (закупки, КП)
db.js              — инициализация БД, CREATE TABLE, ALTER TABLE, seed данные
storage.js         — абстракция хранения файлов (локально / S3)
package.json       — зависимости
ecosystem.config.js — конфиг PM2
.env               — переменные окружения (не в git; шаблон — раздел ниже)

assets/
  app.js           — общий JS для всех страниц (apiFetch, escapeHtml,
                     showToast, initNotifications, shouldUseMockData и др.)
  theme-v2.css     — глобальные стили (тёмная/светлая тема)
  zakupki-cat.css, fonts.css, ui-animations.js

seo/               — GSC, Yandex Webmaster, SEO-аудит, интенты (auditor.js, gsc.js…)
scripts/           — static-checks.js, mvp-api-smoke.js
tests/e2e/         — Playwright e2e

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
                       фото, сертификаты, геокоординаты, verified_by_platform)

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

# AI (Gemini — нужен ключ формата AIzaSy... из Google AI Studio)
GEMINI_API_KEY=

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
  GET /api/export/1c/:proposalId  — CommerceML XML для 1С

Закупки (доп.):
  GET /api/orders/:orderId/matched-suppliers  — match-score поставщиков для заявки
  GET /api/orders/:orderId/price-benchmark    — бенчмарк цен по категории (6 мес.)

Риск (без UI):
  GET /api/risk/:inn              — базовая проверка по ЕГРЮЛ

Аналитика:
  GET /api/customer/analytics    — KPI, динамика, категории, топ поставщики

AI:
  POST /api/ai-search            — поиск поставщиков через Gemini

Уведомления:
  GET    /api/notifications/:company
  POST   /api/notifications/:company/read
  DELETE /api/notifications/:company

Избранное:
  GET    /api/favorites
  POST   /api/favorites
  DELETE /api/favorites/:companyId

Верификация компаний (admin.html):
  POST /api/verification/request   — подать заявку (поставщик)
  GET  /api/verification/status
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
  [x] Бенчмарк цен по платформе (медиана / диапазон по категории)
  [x] Автозакрытие заявок по deadline (cron 08:00 МСК) + email
  [x] Напоминание заказчику за 3 дня до дедлайна
  [x] Email поставщику о новой подходящей закупке (match ≥ 50%)

Переписка:
  [x] Real-time чат через Socket.io
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
  [x] Верификация платформой
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


ЧТО НЕ РЕАЛИЗОВАНО / В ПЛАНАХ
-------------------------------
  [ ] AI-помощник для составления ТЗ (Gemini не работает — проблема с ключом)
  [ ] UI-карточка риска поставщика (API /api/risk/:inn уже есть)
  [ ] Обратный аукцион для прямых закупок (reverse auction)
  [ ] Тарифы / оплата (страница tariff.html есть; биллинг не подключён)
  [ ] Мобильное приложение (долгосрочно)
  [ ] Web Push уведомления (UI-заглушка есть, логика не реализована)
  [ ] Telegram-бот
  [ ] .env.example, чистка legacy SVG/docs


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
  - Сайдбар дёргается при переходе между HTML-страницами (MPA).
    Пробовали: убрать @view-transition, отключить transition на sidebar,
    раннее скрытие пунктов по роли, кеш бейджей — на prod эффекта нет.
    Нужен отдельный разбор (возможно SPA-обёртка или единый layout).

  - GEMINI_API_KEY: ключ формата AQ.* даёт 401 Unauthorized.
    Нужен ключ формата AIzaSy... из Google AI Studio с настроенным биллингом.
    До решения AI-поиск возвращает 503.

  - shouldUseMockData() = true на localhost → часть данных моковая в dev
    (намеренное поведение, в production моки не показываются).

  - Пакет resend удалён из зависимостей — email только через SMTP.


ВАЖНЫЕ УТИЛИТЫ (assets/app.js)
-------------------------------
  SERVER_URL           — базовый URL API (автоопределяется по хосту)
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
Обновлено: 23.06.2026 — глобальное тестирование, 14 багфиксов
Подробности: update.txt, TEST-REPORT.md
================================================================================
