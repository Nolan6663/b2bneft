# ТехЗаказ — дизайн доработок платформы
Дата: 2026-06-29

## Scope

Шесть независимых блоков работ, от быстрых фиксов до крупных фич. Выполняются последовательно от простого к сложному.

---

## Блок 1: Быстрые фиксы

### 1.1 Минимальная длина пароля
**Файл:** `server.js` — эндпоинт `PUT /api/auth/password`
Унифицировать минимум до 8 символов (сейчас 6). Привести сообщение об ошибке к единому виду с `/api/auth/reset-password`.

### 1.2 Rate limiting
**Файл:** `server.js`
Добавить два лимитера через `express-rate-limit`:
- `generalLimiter`: 60 req/мин на IP → применить на все `/api/` роуты (`app.use('/api/', generalLimiter)`)
- `aiLimiter`: 5 req/мин на IP → применить только на `POST /api/ai-search`
Auth-эндпоинты уже имеют свой `authLimiter` (15 req/15мин) — не трогать.

### 1.3 Логирование ошибок email
**Файл:** `server.js`
Во всех fire-and-forget блоках (отправка уведомлений в чате, дайджест и т.д.) заменить пустой `catch {}` на `catch (e) { console.error('[email]', e.message) }`.

### 1.4 README
**Файл:** `README.txt`
Убрать пункт `[ ] landing-hero.png (og:image — файл отсутствует)` из раздела «ЧТО НЕ РЕАЛИЗОВАНО» — файл уже присутствует в репозитории.

### 1.5 Socket.io join-auction
**Файл:** `server.js`
Таблицы `auctions` в БД пока нет — функция аукционов не реализована. Хэндлер `join-auction` сделать явным no-op: принимать событие но ничего не делать. Комментарий: «TODO: проверить доступ когда auctions будут реализованы».

---

## Блок 2: Кэширование CSS/JS

**Файл:** `server.js` — middleware статики (`app.use('/assets', express.static(...))`)

Заменить для CSS и JS файлов:
```
'public, max-age=31536000, immutable'
```
на:
```
'no-cache'
```

Браузер будет делать conditional GET (If-None-Match / ETag) — при отсутствии изменений получает 304 без перекачки файла. Шрифты и изображения оставить с длинным кэшем (`immutable`).

---

## Блок 3: Web Push уведомления

### 3.1 Зависимости
Добавить npm пакет: `web-push`

### 3.2 Переменные окружения (`.env`)
```
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:noreply@texzakaz.ru
```
VAPID ключи генерируются один раз командой `web-push generate-vapid-keys` и вписываются в `.env`.

### 3.3 БД
Новая таблица (добавить в `db.js`):
```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.4 Service Worker
**Файл:** `assets/sw.js` (новый)
- Регистрируется в `app.js` при `hasSession()`
- Слушает событие `push` → вызывает `self.registration.showNotification(title, { body, icon, data: { url } })`
- Слушает `notificationclick` → открывает `event.notification.data.url`

### 3.5 API эндпоинты
**Файл:** `server.js`
- `GET /api/push/vapid-key` — возвращает `VAPID_PUBLIC_KEY` для фронта (без auth)
- `POST /api/push/subscribe` — сохраняет subscription в `push_subscriptions` (requireAuth)
- `DELETE /api/push/subscribe` — удаляет subscription текущего пользователя (requireAuth)

### 3.6 Хелпер
**Файл:** `server.js`
```js
async function sendPush(userId, title, body, url) { … }
```
Загружает все подписки пользователя из БД, отправляет через `webpush.sendNotification()`. Ошибки 410/404 (подписка устарела) — удалять запись из БД. Остальные ошибки — логировать.

### 3.7 Точки вызова `sendPush`
Вызывается (fire-and-forget) в тех же местах что `sendEmail`:
- `POST /api/proposals` — заказчику: «Новое КП на заявку»
- `POST /api/proposals/:id/accept` — поставщику: «КП принято»
- `POST /api/proposals/:id/reject` — поставщику: «КП отклонено»
- `POST /api/messages` — получателю: «Новое сообщение»
- Cron deadline (−3 дня) — заказчику: «Дедлайн через 3 дня»
- `POST /api/verification/:id/approve` — компании: «Верификация одобрена»
- `POST /api/auth/register` при использовании `inviteToken` — членам команды компании: «Новый участник присоединился»

### 3.8 UI в settings.html
Кнопка «Включить Push-уведомления» / «Отключить».
При включении: `Notification.requestPermission()` → `registration.pushManager.subscribe()` → `POST /api/push/subscribe`.

---

## Блок 4: UI-карточка риска поставщика

### 4.1 company-profile.html — блок «Проверка надёжности»
- Загружается lazy при открытии страницы если у компании есть ИНН
- Запрос: `GET /api/risk/:inn`
- Отображает: статус ЕГРЮЛ, дата регистрации, уставной капитал, признаки риска
- Цветовая индикация: зелёный (действует), жёлтый (предупреждения), красный (ликвидируется / ликвидирована)

### 4.2 index.html — модалка при принятии КП
- При клике «Принять КП» — сначала загрузить `/api/risk/:inn` поставщика
- Показать модалку с кратким резюме: статус + одна ключевая строка
- Кнопки: «Всё равно принять» (продолжает существующий флоу) и «Отмена»
- Если ИНН поставщика неизвестен или API недоступен — пропустить модалку, принять сразу

---

## Блок 5: SPA-роутер (сайдбар)

### 5.1 Принцип
Сайдбар рендерится один раз. Переходы по ссылкам в навбаре подменяют только `<main id="spa-content">` через fetch. Прямые URL, F5 и открытие в новой вкладке работают как раньше.

### 5.2 Изменения в HTML-страницах
Каждая страница:
1. `<main>` → `<main id="spa-content">`
2. Page-specific `<script>` в конце body оборачивается в `window.__pageInit = function() { … }` — функция вызывается роутером после подмены контента

### 5.3 Роутер в assets/app.js (~150 строк)
```
initSpaRouter():
  - document.addEventListener('click') на <a> внутри сайдбара
  - если href — внутренняя страница: preventDefault, navigateTo(href)
  
navigateTo(url):
  - fetch(url) → response.text()
  - DOMParser → извлечь innerHTML #spa-content и <title>
  - Заменить document.querySelector('#spa-content').innerHTML
  - Обновить document.title
  - history.pushState({}, '', url)
  - Найти <script> теги с window.__pageInit в fetched HTML, выполнить через new Function(scriptContent)()
  - Примечание: innerHTML не выполняет <script> теги автоматически — нужно явное извлечение
  - Переинициализировать Socket.io если нужно

window.addEventListener('popstate'):
  - navigateTo(location.pathname)
```

### 5.4 Страницы для обновления
Все ~20 HTML-файлов в корне репозитория.

### 5.5 Ограничения
- `login.html` — исключить из SPA-навигации (редирект на полную загрузку)
- Страницы с файловыми загрузками (multer) — работают как раньше, SPA только навигация
- Socket.io соединение переиспользуется между страницами

---

## Блок 6: Telegram-бот (полноценный кабинет)

### 6.1 Стек
- Библиотека: `telegraf` (npm)
- Модуль: `telegram-bot.js` (новый файл)
- Запуск: `startTelegramBot()` вызывается из `start()` в `server.js`
- Переменная окружения: `TELEGRAM_BOT_TOKEN`

### 6.2 БД
Добавить поля в `users`:
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_token VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_expires TIMESTAMPTZ;
```

### 6.3 Привязка аккаунта
**В settings.html:**
- Кнопка «Подключить Telegram» → `POST /api/telegram/link-token`
- Сервер генерирует случайный токен, сохраняет в `telegram_link_token` с TTL 15 минут
- Возвращает deep link: `https://t.me/<BOT_NAME>?start=<token>` (BOT_NAME берётся из env `TELEGRAM_BOT_NAME` или через `bot.telegram.getMe()`)
- Пользователь открывает ссылку в Telegram
- Бот получает `/start <token>`, находит пользователя, записывает `telegram_id`

**Новые эндпоинты:**
- `POST /api/telegram/link-token` — генерирует токен привязки (requireAuth)
- `DELETE /api/telegram/unlink` — отвязать Telegram (requireAuth)
- `GET /api/telegram/status` — проверить привязан ли аккаунт (requireAuth)

### 6.4 Команды и меню бота
Главное меню — Reply Keyboard (постоянные кнопки):
```
[ 📋 Закупки ]  [ 📨 КП      ]
[ 💬 Чат     ]  [ 📦 Сделки  ]
[ 🔔 Уведом. ]  [ ⚙️ Профиль ]
```

**`/start`** — если не привязан: инструкция как привязать. Если привязан: приветствие + меню.

**📋 Закупки:**
- Заказчик: список своих активных заявок (title, статус, кол-во КП), inline-кнопки: «Детали», «КП по заявке»
- Поставщик: список активных закупок с match ≥ 50%, inline-кнопки: «Детали», «Подать КП» (открывает сайт)

**📨 КП:**
- Заказчик: ожидающие КП по активным заявкам, inline-кнопки: «Принять», «Отклонить»
- Поставщик: свои КП, статусы

**💬 Чат:**
- Список непрочитанных переписок (order + компания + последнее сообщение)
- Inline-кнопки «Ответить» → FSM: ожидает текст сообщения, отправляет через API

**📦 Сделки:**
- Список активных сделок с этапами поставки
- Inline-кнопки для поставщика: «Обновить этап»

**🔔 Уведомления:**
- Последние 10 уведомлений из платформы
- Inline-кнопка «Отметить все прочитанными»

**⚙️ Профиль:**
- Краткая информация: email, компания, роль
- Ссылка на сайт: «Открыть ТехЗаказ →»
- Кнопка «Отвязать Telegram»

### 6.5 Push-уведомления через Telegram
Функция `sendTelegramNotification(userId, text)` — альтернатива Web Push для пользователей с привязанным Telegram. Вызывается параллельно с `sendPush`.

### 6.6 Ограничения
- Принятие/отклонение КП через Telegram — полное действие (меняет статус в БД, тригерит интеграции)
- Отправка КП с файлом — только ссылка на сайт (файлы через Telegram не поддерживаем)
- Бот работает в polling режиме (не webhook) для простоты деплоя

---

## Порядок реализации

1. Блок 1 (быстрые фиксы) — ~2 часа
2. Блок 2 (кэширование) — ~30 минут
3. Блок 3 (Web Push) — ~1 день
4. Блок 4 (риск поставщика) — ~4 часа
5. Блок 5 (SPA-роутер) — ~2 дня
6. Блок 6 (Telegram-бот) — ~3 дня
