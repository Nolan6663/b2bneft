B2B Нефтесервис — журнал изменений
Дата: 23.06.2026
================================================================================

ОБЗОР
-----
В этой сессии закрыты критические баги перед запуском, добавлена поддержка
облачного хранилища файлов (S3/R2), переведена авторизация на httpOnly-cookies
и внедрена верификация email при регистрации.


================================================================================
ЧАСТЬ 1 — КРИТИЧЕСКИЕ ИСПРАВЛЕНИЯ (безопасность и mock-данные)
================================================================================

server.js
---------
- IDOR на чертежах: функция canAccessOrderDrawing() — доступ имеют владелец
  заявки, производитель с КП или admin.
- Socket.IO: JWT из cookie; join-company только для своей компании;
  join-chat через canAccessOrderThread().
- КП на закрытые заявки: POST /api/proposals → 400, если статус не «Активный».

assets/app.js
-------------
- Socket.IO: withCredentials: true, подключение при hasSession().

HTML (mock-данные на проде)
-----------------------------
При пустом ответе API или ошибке фейковые данные больше не показываются на
production. Mock только при shouldUseMockData() (localhost).

  deliveries.html, deals.html, delivery.html, index.html, proposals.html,
  partners.html, producer.html

scripts/static-checks.js
------------------------
- Проверка canAccessOrderDrawing в access guardrails.


================================================================================
ЧАСТЬ 2 — ОБЛАКОНОЕ ХРАНИЛИЩЕ ФАЙЛОВ (S3 / Cloudflare R2)
================================================================================

НОВЫЙ ФАЙЛ: storage.js
----------------------
- S3/R2 при S3_BUCKET + ключах, иначе локальный uploads/.
- saveFile(), deleteStored(), streamToResponse(), photoPublicUrl().
- Префиксы: drawings/, kp/, photos/.

server.js
---------
- Multer → memoryStorage() → storage.saveFile().
- GET /api/company-photos/:filename (вместо публичной статики /company-photos).
- Скачивание чертежей и КП через storage.streamToResponse().
- /api/health: поле storage = "s3" | "local".

package.json — добавлен @aws-sdk/client-s3

Переменные: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT,
S3_REGION, S3_FORCE_PATH_STYLE, S3_PUBLIC_URL

company-profile.html — фото через p.url или /api/company-photos/...


================================================================================
ЧАСТЬ 3 — JWT В httpOnly COOKIES
================================================================================

server.js
---------
- Cookies: b2b_access (1 ч), b2b_refresh (30 дней).
- httpOnly, Secure в production, SameSite=Lax.
- requireAuth: cookie, затем Bearer (для smoke/API).
- CORS: credentials: true.

assets/app.js
-------------
- applyAuthSession(), hasSession(), clearAuthSession().
- apiFetch() с credentials: include.
- authGuard(): гости без requiredRole (карта, доставки).
- logout() через /api/auth/logout.
- localStorage: isLoggedIn, userRole, userCompany, emailVerified — без токенов.

login.html
----------
- credentials: include; applyAuthSession(); verify по ?verify=TOKEN.
- После регистрации — сразу вход в кабинет.

Обновлены: admin, company-profile, deals, delivery, favorites, messages,
partners, proposals, catalog, settings, tariff, analytics, landing, producer.

Обратная совместимость: login/register возвращают token в JSON для smoke-тестов.


================================================================================
ЧАСТЬ 4 — ВЕРИФИКАЦИЯ EMAIL
================================================================================

db.js
-----
- Таблица email_verification_tokens, колонка users.email_verified.
- Миграция: существующие пользователи → verified.
- Admin при сиде: email_verified = true.

server.js
---------
- sendVerificationEmail() при регистрации и смене email.
- requireVerifiedEmail на POST /api/orders и POST /api/proposals.
- POST /api/auth/verify-email, POST /api/auth/resend-verification.
- GET /api/auth/me — emailVerified.

assets/app.js — баннер «Подтвердите email».


================================================================================
ЧАСТЬ 5 — КОНФИГУРАЦИЯ
================================================================================

НОВЫЙ: env.example — шаблон переменных окружения.
render.yaml — S3/R2 env, SEED_ADMIN=false, SEED_DEMO_DATA=false.


================================================================================
ПОСЛЕ ОБНОВЛЕНИЯ
================================================================================

  npm install
  npm test
  npm start

На Render: S3/R2, RESEND_API_KEY, APP_URL.

Smoke: MVP_SMOKE_RUN=1 MVP_SMOKE_BASE_URL=https://b2bneft.onrender.com/api npm run smoke:api


================================================================================
НЕ СДЕЛАНО
================================================================================

- analytics.html, settings.html, tariff.html — часть fetch может быть не на cookies.
- Ручная миграция старых файлов с Render disk на R2.
- Playwright e2e, Sentry, платежи.


================================================================================
Конец файла — 23.06.2026
================================================================================
