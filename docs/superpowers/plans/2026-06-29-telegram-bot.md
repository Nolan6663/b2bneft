# Telegram-бот (полноценный кабинет) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полноценный Telegram-кабинет: привязка аккаунта, меню с закупками/КП/чатом/сделками/уведомлениями, принятие/отклонение КП и ответы в чат прямо из Telegram.

**Architecture:** Модуль `telegram-bot.js` на базе `telegraf`. Привязка через deep link с токеном. Бот работает в polling режиме. Запускается из `start()` в `server.js`. Notifications дублируются через `sendTelegramNotification(userId, text)` параллельно с `sendPush`.

**Tech Stack:** telegraf (npm), node-telegram-bot-api (нет — используем telegraf), PostgreSQL

## Global Constraints

- Рабочая директория: `C:\Users\Админ\source\repos`
- `npm test` должен проходить после каждой задачи
- Переменные окружения: `TELEGRAM_BOT_TOKEN` (обязательный), `TELEGRAM_BOT_NAME` (для deep link)
- Бот gracefully пропускает ошибки — не падать если Telegram API недоступен
- Polling режим (не webhook) — проще деплой
- Принятие КП через Telegram — полное действие с тригером интеграций (как через web)

---

### Task 1: Установить telegraf, настроить env

**Files:**
- Modify: `package.json`
- Modify: `env.example`

- [ ] **Step 1: Установить telegraf**

  ```bash
  npm install telegraf
  ```
  Ожидаемый результат: `telegraf` в `node_modules` и `package.json`.

- [ ] **Step 2: Добавить переменные в env.example**

  Добавь в конец `env.example`:
  ```
  # Telegram Bot
  TELEGRAM_BOT_TOKEN=
  TELEGRAM_BOT_NAME=TexZakazBot
  ```

- [ ] **Step 3: Добавить в .env**

  Открой `.env`, добавь:
  ```
  TELEGRAM_BOT_TOKEN=<токен от @BotFather>
  TELEGRAM_BOT_NAME=<имя бота без @>
  ```
  Токен получается у @BotFather в Telegram командой /newbot.

- [ ] **Step 4: Commit**

  ```bash
  git add package.json package-lock.json env.example
  git commit -m "feat: добавить telegraf, env placeholder для Telegram бота"
  ```

---

### Task 2: Схема БД — telegram_id в users

**Files:**
- Modify: `db.js`

**Interfaces:**
- Produces:
  - `users.telegram_id BIGINT UNIQUE` — Telegram user ID
  - `users.telegram_link_token VARCHAR(64)` — токен привязки (TTL 15 мин)
  - `users.telegram_link_expires TIMESTAMPTZ`

- [ ] **Step 1: Добавить ALTER TABLE в db.js**

  Найди в `db.js` место где применяются ALTER TABLE (или initDb функцию). Добавь:
  ```javascript
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT UNIQUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_token VARCHAR(64)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_expires TIMESTAMPTZ`);
  ```

- [ ] **Step 2: Проверить**

  ```bash
  npm test
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add db.js
  git commit -m "feat: добавить telegram_id и telegram_link_token поля в users"
  ```

---

### Task 3: API эндпоинты привязки в server.js

**Files:**
- Modify: `server.js`

**Interfaces:**
- Produces:
  - `POST /api/telegram/link-token` (requireAuth) → `{ token, deepLink }`
  - `DELETE /api/telegram/unlink` (requireAuth) → `{ ok: true }`
  - `GET /api/telegram/status` (requireAuth) → `{ linked: bool, telegramId: bigint|null }`
  - `async function sendTelegramNotification(userId, text)` — публичный хелпер

- [ ] **Step 1: Добавить эндпоинты в server.js**

  Добавь в server.js (рядом с другими /api/ роутами):
  ```javascript
  // ===================== TELEGRAM =====================

  app.post('/api/telegram/link-token', requireAuth, async (req, res, next) => {
      try {
          const token = crypto.randomBytes(32).toString('hex');
          const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 минут
          await pool.query(
              'UPDATE users SET telegram_link_token=$1, telegram_link_expires=$2 WHERE id=$3',
              [token, expires, req.user.id]
          );
          const botName = process.env.TELEGRAM_BOT_NAME || 'TexZakazBot';
          res.json({ token, deepLink: `https://t.me/${botName}?start=${token}` });
      } catch (e) { next(e); }
  });

  app.delete('/api/telegram/unlink', requireAuth, async (req, res, next) => {
      try {
          await pool.query(
              'UPDATE users SET telegram_id=NULL, telegram_link_token=NULL, telegram_link_expires=NULL WHERE id=$1',
              [req.user.id]
          );
          res.json({ ok: true });
      } catch (e) { next(e); }
  });

  app.get('/api/telegram/status', requireAuth, async (req, res, next) => {
      try {
          const { rows: [user] } = await pool.query(
              'SELECT telegram_id FROM users WHERE id=$1', [req.user.id]
          );
          res.json({ linked: Boolean(user?.telegram_id), telegramId: user?.telegram_id || null });
      } catch (e) { next(e); }
  });
  ```

- [ ] **Step 2: Добавить хелпер sendTelegramNotification**

  Добавь рядом с sendPush (он будет использовать `tgBot` из telegram-bot.js — импортируем позже):
  ```javascript
  async function sendTelegramNotification(userId, text) {
      if (!global.__tgBot) return;
      try {
          const { rows: [user] } = await pool.query(
              'SELECT telegram_id FROM users WHERE id=$1 AND telegram_id IS NOT NULL', [userId]
          );
          if (!user?.telegram_id) return;
          await global.__tgBot.telegram.sendMessage(user.telegram_id, text, { parse_mode: 'HTML' });
      } catch (e) {
          console.error('[tg:notify]', e.message);
      }
  }
  ```

- [ ] **Step 3: Добавить вызовы sendTelegramNotification рядом с sendPush**

  В тех же 7 местах где вызывается `sendPush` (из плана web-push Task 5), добавь параллельный вызов:
  ```javascript
  // Пример для нового КП:
  getUserIdsByCompany(orderRow.company).then(ids =>
      ids.forEach(id => {
          sendPush(id, 'Новое коммерческое предложение', `«${orderRow.title}»`, `${APP_URL}/index`);
          sendTelegramNotification(id, `📨 <b>Новое КП</b> по закупке «${orderRow.title}»\n\nПоставщик: ${proposalRow.company}\nЦена: ${proposalRow.price} руб.`);
      })
  ).catch(() => {});
  ```

  Повтори для всех точек из web-push плана (КП принято/отклонено, сообщение, дедлайн, верификация, команда).

- [ ] **Step 4: Проверить**

  ```bash
  npm test
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add server.js
  git commit -m "feat: API эндпоинты привязки Telegram и хелпер sendTelegramNotification"
  ```

---

### Task 4: Основной модуль telegram-bot.js

**Files:**
- Create: `telegram-bot.js`

**Interfaces:**
- Consumes: `pool` из `./db`, все бизнес-данные через прямые SQL-запросы
- Produces:
  - `function startTelegramBot()` — запускает polling, устанавливает `global.__tgBot`
  - Команды: `/start`, меню 📋/📨/💬/📦/🔔/⚙️

- [ ] **Step 1: Создать telegram-bot.js — скелет и привязка аккаунта**

  ```javascript
  'use strict';
  const { Telegraf, Markup } = require('telegraf');
  const { pool } = require('./db');

  const MAIN_MENU = Markup.keyboard([
      ['📋 Закупки', '📨 КП'],
      ['💬 Чат', '📦 Сделки'],
      ['🔔 Уведомления', '⚙️ Профиль'],
  ]).resize();

  function escapeHtml(str) {
      return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function getUserByTgId(telegramId) {
      const { rows: [user] } = await pool.query(
          'SELECT * FROM users WHERE telegram_id=$1', [telegramId]
      );
      return user || null;
  }

  function startTelegramBot() {
      if (!process.env.TELEGRAM_BOT_TOKEN) {
          console.log('[tg] TELEGRAM_BOT_TOKEN не задан — бот не запущен');
          return null;
      }

      const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
      global.__tgBot = bot;

      // /start — привязка или приветствие
      bot.start(async (ctx) => {
          const token = ctx.startPayload;
          const tgId = ctx.from.id;

          if (token) {
              // Привязка аккаунта по токену
              const { rows: [user] } = await pool.query(
                  `SELECT * FROM users
                   WHERE telegram_link_token=$1 AND telegram_link_expires > NOW()`,
                  [token]
              );
              if (!user) {
                  return ctx.reply('Ссылка недействительна или истекла. Получите новую в настройках сайта.');
              }
              await pool.query(
                  'UPDATE users SET telegram_id=$1, telegram_link_token=NULL, telegram_link_expires=NULL WHERE id=$2',
                  [tgId, user.id]
              );
              return ctx.reply(
                  `✅ Аккаунт привязан!\n\nДобро пожаловать, ${escapeHtml(user.company || user.email)}!`,
                  MAIN_MENU
              );
          }

          const user = await getUserByTgId(tgId);
          if (!user) {
              return ctx.reply(
                  '👋 Добро пожаловать в ТехЗаказ!\n\nЧтобы начать, привяжите аккаунт:\n1. Войдите на texzakaz.ru\n2. Откройте Настройки → Telegram\n3. Нажмите «Подключить Telegram»'
              );
          }
          return ctx.reply(`С возвращением, ${escapeHtml(user.company || user.email)}! 👋`, MAIN_MENU);
      });

      // Middleware: проверить что аккаунт привязан
      bot.use(async (ctx, next) => {
          if (!ctx.from) return;
          ctx.tgUser = await getUserByTgId(ctx.from.id);
          if (!ctx.tgUser) {
              await ctx.reply('Аккаунт не привязан. Отправьте /start для начала.');
              return;
          }
          return next();
      });

      return bot;
  }

  module.exports = { startTelegramBot };
  ```

- [ ] **Step 2: Проверить синтаксис**

  ```bash
  node --check telegram-bot.js
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add telegram-bot.js
  git commit -m "feat: скелет telegram-bot.js — привязка аккаунта и middleware авторизации"
  ```

---

### Task 5: Меню 📋 Закупки и 📨 КП

**Files:**
- Modify: `telegram-bot.js`

- [ ] **Step 1: Добавить хэндлер 📋 Закупки**

  В `startTelegramBot()` после middleware, добавь:
  ```javascript
  bot.hears('📋 Закупки', async (ctx) => {
      const { role, company } = ctx.tgUser;
      try {
          if (role === 'customer') {
              const { rows } = await pool.query(
                  `SELECT o.id, o.title, o.status, o.deadline,
                          COUNT(p.id) AS proposal_count
                   FROM orders o
                   LEFT JOIN proposals p ON p.order_id=o.id AND p.status='Ожидает ответа'
                   WHERE o.company=$1 AND o.status='Активный'
                   GROUP BY o.id ORDER BY o.created_at DESC LIMIT 10`,
                  [company]
              );
              if (!rows.length) return ctx.reply('У вас нет активных закупок.');
              const text = rows.map((o, i) =>
                  `${i+1}. <b>${escapeHtml(o.title)}</b>\n   КП: ${o.proposal_count} | Дедлайн: ${o.deadline || '—'}`
              ).join('\n\n');
              await ctx.reply(`📋 <b>Ваши закупки:</b>\n\n${text}`, {
                  parse_mode: 'HTML',
                  ...Markup.inlineKeyboard(
                      rows.map(o => [Markup.button.callback(`📄 ${o.title.slice(0,30)}`, `order:${o.id}`)])
                  )
              });
          } else {
              // Поставщик: подходящие закупки
              const { rows } = await pool.query(
                  `SELECT id, title, category, deadline FROM orders
                   WHERE status='Активный' ORDER BY created_at DESC LIMIT 10`
              );
              if (!rows.length) return ctx.reply('Активных закупок нет.');
              const text = rows.map((o, i) =>
                  `${i+1}. <b>${escapeHtml(o.title)}</b>\n   Категория: ${escapeHtml(o.category)} | Дедлайн: ${o.deadline || '—'}`
              ).join('\n\n');
              await ctx.reply(`📋 <b>Активные закупки:</b>\n\n${text}`, { parse_mode: 'HTML' });
          }
      } catch (e) {
          console.error('[tg:orders]', e.message);
          ctx.reply('Произошла ошибка. Попробуйте позже.');
      }
  });
  ```

- [ ] **Step 2: Добавить хэндлер 📨 КП**

  ```javascript
  bot.hears('📨 КП', async (ctx) => {
      const { role, company } = ctx.tgUser;
      try {
          if (role === 'customer') {
              const { rows } = await pool.query(
                  `SELECT p.id, p.price, p.days, p.company AS supplier, o.title AS order_title
                   FROM proposals p JOIN orders o ON o.id=p.order_id
                   WHERE o.company=$1 AND p.status='Ожидает ответа'
                   ORDER BY p.created_at DESC LIMIT 10`,
                  [company]
              );
              if (!rows.length) return ctx.reply('Нет КП, ожидающих решения.');
              const text = rows.map((p, i) =>
                  `${i+1}. <b>${escapeHtml(p.order_title)}</b>\n   Поставщик: ${escapeHtml(p.supplier)}\n   Цена: ${p.price} руб. | Срок: ${p.days} дн.`
              ).join('\n\n');
              await ctx.reply(`📨 <b>КП, ожидающие решения:</b>\n\n${text}`, {
                  parse_mode: 'HTML',
                  ...Markup.inlineKeyboard(
                      rows.map(p => [
                          Markup.button.callback(`✅ Принять #${p.id}`, `accept:${p.id}`),
                          Markup.button.callback(`❌ Отклонить #${p.id}`, `reject:${p.id}`),
                      ])
                  )
              });
          } else {
              const { rows } = await pool.query(
                  `SELECT p.id, p.price, p.days, p.status, o.title AS order_title
                   FROM proposals p JOIN orders o ON o.id=p.order_id
                   WHERE p.company=$1
                   ORDER BY p.created_at DESC LIMIT 10`,
                  [company]
              );
              if (!rows.length) return ctx.reply('У вас нет поданных КП.');
              const text = rows.map((p, i) =>
                  `${i+1}. <b>${escapeHtml(p.order_title)}</b>\n   ${p.price} руб. | ${p.days} дн. | <i>${escapeHtml(p.status)}</i>`
              ).join('\n\n');
              await ctx.reply(`📨 <b>Ваши КП:</b>\n\n${text}`, { parse_mode: 'HTML' });
          }
      } catch (e) {
          console.error('[tg:proposals]', e.message);
          ctx.reply('Произошла ошибка. Попробуйте позже.');
      }
  });
  ```

- [ ] **Step 3: Добавить inline callback — принять/отклонить КП**

  ```javascript
  bot.action(/^accept:(\d+)$/, async (ctx) => {
      const proposalId = parseInt(ctx.match[1]);
      try {
          const { rows: [proposal] } = await pool.query(
              `SELECT p.*, o.company AS customer_company, o.title AS order_title
               FROM proposals p JOIN orders o ON o.id=p.order_id
               WHERE p.id=$1`, [proposalId]
          );
          if (!proposal) return ctx.answerCbQuery('КП не найдено');
          if (proposal.status !== 'Ожидает ответа') return ctx.answerCbQuery('КП уже обработано');

          await pool.query(
              `UPDATE proposals SET status='Выигран' WHERE id=$1`, [proposalId]
          );
          await pool.query(
              `UPDATE proposals SET status='Проигран'
               WHERE order_id=$1 AND id!=$2 AND status='Ожидает ответа'`,
              [proposal.order_id, proposalId]
          );

          await ctx.editMessageText(
              `✅ КП #${proposalId} принято!\n\nЗакупка: <b>${escapeHtml(proposal.order_title)}</b>\nПоставщик: ${escapeHtml(proposal.company)}`,
              { parse_mode: 'HTML' }
          );
          await ctx.answerCbQuery('КП принято!');
      } catch (e) {
          console.error('[tg:accept]', e.message);
          ctx.answerCbQuery('Ошибка при принятии КП');
      }
  });

  bot.action(/^reject:(\d+)$/, async (ctx) => {
      const proposalId = parseInt(ctx.match[1]);
      try {
          const { rows: [proposal] } = await pool.query(
              'SELECT * FROM proposals WHERE id=$1', [proposalId]
          );
          if (!proposal) return ctx.answerCbQuery('КП не найдено');
          if (proposal.status !== 'Ожидает ответа') return ctx.answerCbQuery('КП уже обработано');

          await pool.query(
              `UPDATE proposals SET status='Отклонён' WHERE id=$1`, [proposalId]
          );
          await ctx.editMessageText(`❌ КП #${proposalId} отклонено.`);
          await ctx.answerCbQuery('КП отклонено');
      } catch (e) {
          console.error('[tg:reject]', e.message);
          ctx.answerCbQuery('Ошибка');
      }
  });
  ```

- [ ] **Step 4: Проверить**

  ```bash
  node --check telegram-bot.js && npm test
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add telegram-bot.js
  git commit -m "feat: Telegram меню 'Закупки' и 'КП' с принятием/отклонением"
  ```

---

### Task 6: Меню 💬 Чат с FSM-ответом

**Files:**
- Modify: `telegram-bot.js`

- [ ] **Step 1: Добавить хэндлер 💬 Чат**

  ```javascript
  // Хранилище состояния ответа в чате (in-memory, достаточно для polling)
  const chatReplyState = new Map(); // tgId → { orderId, company }

  bot.hears('💬 Чат', async (ctx) => {
      const { role, company } = ctx.tgUser;
      try {
          let rows;
          if (role === 'customer') {
              const { rows: r } = await pool.query(
                  `SELECT m.order_id, m.company, o.title, MAX(m.created_at) AS last_msg,
                          COUNT(CASE WHEN m.read=false AND m.sender='producer' THEN 1 END) AS unread
                   FROM messages m JOIN orders o ON o.id=m.order_id
                   WHERE o.company=$1
                   GROUP BY m.order_id, m.company, o.title
                   ORDER BY last_msg DESC LIMIT 10`,
                  [company]
              );
              rows = r;
          } else {
              const { rows: r } = await pool.query(
                  `SELECT m.order_id, m.company, o.title, MAX(m.created_at) AS last_msg,
                          COUNT(CASE WHEN m.read=false AND m.sender='customer' THEN 1 END) AS unread
                   FROM messages m JOIN orders o ON o.id=m.order_id
                   WHERE m.company=$1
                   GROUP BY m.order_id, m.company, o.title
                   ORDER BY last_msg DESC LIMIT 10`,
                  [company]
              );
              rows = r;
          }

          if (!rows.length) return ctx.reply('Нет активных переписок.');
          const text = rows.map((r, i) =>
              `${i+1}. <b>${escapeHtml(r.title)}</b>${r.unread > 0 ? ` 🔴${r.unread}` : ''}`
          ).join('\n');
          await ctx.reply(`💬 <b>Переписки:</b>\n\n${text}`, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard(
                  rows.map(r => [
                      Markup.button.callback(
                          `💬 ${r.title.slice(0,25)}${r.unread > 0 ? ` (${r.unread} новых)` : ''}`,
                          `chat:${r.order_id}:${r.company}`
                      )
                  ])
              )
          });
      } catch (e) {
          console.error('[tg:chat]', e.message);
          ctx.reply('Произошла ошибка.');
      }
  });

  bot.action(/^chat:(\d+):(.+)$/, async (ctx) => {
      const orderId = parseInt(ctx.match[1]);
      const company = ctx.match[2];
      try {
          const { rows } = await pool.query(
              `SELECT sender, text, created_at FROM messages
               WHERE order_id=$1 AND company=$2
               ORDER BY created_at DESC LIMIT 5`,
              [orderId, company]
          );
          const preview = rows.reverse().map(m =>
              `<b>${m.sender === 'customer' ? '🏢' : '🏭'}</b> ${escapeHtml(m.text.slice(0, 100))}`
          ).join('\n');

          chatReplyState.set(ctx.from.id, { orderId, company });
          await ctx.editMessageText(
              `${preview || 'Нет сообщений'}\n\n<i>Напишите ответ или нажмите Отмена:</i>`,
              {
                  parse_mode: 'HTML',
                  ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'chat:cancel')]])
              }
          );
          await ctx.answerCbQuery();
      } catch (e) {
          console.error('[tg:chat:open]', e.message);
          ctx.answerCbQuery('Ошибка');
      }
  });

  bot.action('chat:cancel', async (ctx) => {
      chatReplyState.delete(ctx.from.id);
      await ctx.editMessageText('Отмена.');
      await ctx.answerCbQuery();
  });

  // Обработать текстовое сообщение как ответ в чат (если активен FSM)
  bot.on('text', async (ctx, next) => {
      const state = chatReplyState.get(ctx.from.id);
      if (!state) return next();

      const { orderId, company } = state;
      chatReplyState.delete(ctx.from.id);

      try {
          const text = ctx.message.text.slice(0, 2000);
          const role = ctx.tgUser.role;
          await pool.query(
              'INSERT INTO messages (order_id,company,sender,text) VALUES ($1,$2,$3,$4)',
              [orderId, company, role, text]
          );
          await ctx.reply('✅ Сообщение отправлено!', MAIN_MENU);
      } catch (e) {
          console.error('[tg:chat:send]', e.message);
          ctx.reply('Не удалось отправить сообщение.');
      }
  });
  ```

- [ ] **Step 2: Проверить**

  ```bash
  node --check telegram-bot.js && npm test
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add telegram-bot.js
  git commit -m "feat: Telegram меню 'Чат' с просмотром переписок и FSM-ответом"
  ```

---

### Task 7: Меню 📦 Сделки, 🔔 Уведомления, ⚙️ Профиль

**Files:**
- Modify: `telegram-bot.js`

- [ ] **Step 1: Добавить хэндлер 📦 Сделки**

  ```javascript
  bot.hears('📦 Сделки', async (ctx) => {
      const { role, company } = ctx.tgUser;
      try {
          let rows;
          if (role === 'customer') {
              const { rows: r } = await pool.query(
                  `SELECT o.title, p.company AS supplier, p.price, p.days, p.delivery_stage, p.completion_status
                   FROM proposals p JOIN orders o ON o.id=p.order_id
                   WHERE o.company=$1 AND p.status='Выигран'
                   ORDER BY p.created_at DESC LIMIT 10`,
                  [company]
              );
              rows = r;
          } else {
              const { rows: r } = await pool.query(
                  `SELECT o.title, o.company AS customer, p.price, p.days, p.delivery_stage, p.completion_status
                   FROM proposals p JOIN orders o ON o.id=p.order_id
                   WHERE p.company=$1 AND p.status='Выигран'
                   ORDER BY p.created_at DESC LIMIT 10`,
                  [company]
              );
              rows = r;
          }

          if (!rows.length) return ctx.reply('Нет активных сделок.');
          const text = rows.map((d, i) =>
              `${i+1}. <b>${escapeHtml(d.title)}</b>\n   ${d.price} руб. | Этап: ${escapeHtml(d.delivery_stage || 'не указан')}`
          ).join('\n\n');
          await ctx.reply(`📦 <b>Сделки:</b>\n\n${text}`, { parse_mode: 'HTML' });
      } catch (e) {
          console.error('[tg:deals]', e.message);
          ctx.reply('Произошла ошибка.');
      }
  });
  ```

- [ ] **Step 2: Добавить хэндлер 🔔 Уведомления**

  ```javascript
  bot.hears('🔔 Уведомления', async (ctx) => {
      const { company } = ctx.tgUser;
      try {
          const { rows } = await pool.query(
              `SELECT text, read, created_at FROM notifications
               WHERE company=$1 ORDER BY created_at DESC LIMIT 10`,
              [company]
          );
          if (!rows.length) return ctx.reply('Нет уведомлений.');
          const text = rows.map((n, i) =>
              `${n.read ? '○' : '🔴'} ${escapeHtml(n.text)}`
          ).join('\n');
          await ctx.reply(`🔔 <b>Уведомления:</b>\n\n${text}`, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[
                  Markup.button.callback('✓ Отметить все прочитанными', 'notif:read_all')
              ]])
          });
      } catch (e) {
          console.error('[tg:notifications]', e.message);
          ctx.reply('Произошла ошибка.');
      }
  });

  bot.action('notif:read_all', async (ctx) => {
      try {
          await pool.query(
              'UPDATE notifications SET read=true WHERE company=$1',
              [ctx.tgUser.company]
          );
          await ctx.editMessageText('✅ Все уведомления отмечены прочитанными.');
          await ctx.answerCbQuery();
      } catch (e) {
          ctx.answerCbQuery('Ошибка');
      }
  });
  ```

- [ ] **Step 3: Добавить хэндлер ⚙️ Профиль**

  ```javascript
  bot.hears('⚙️ Профиль', async (ctx) => {
      const { email, role, company } = ctx.tgUser;
      const roleLabel = role === 'customer' ? 'Заказчик' : role === 'producer' ? 'Поставщик' : 'Администратор';
      const appUrl = process.env.APP_URL || 'https://texzakaz.ru';
      await ctx.reply(
          `⚙️ <b>Профиль</b>\n\n` +
          `Email: ${escapeHtml(email)}\n` +
          `Компания: ${escapeHtml(company)}\n` +
          `Роль: ${roleLabel}\n\n` +
          `<a href="${appUrl}">Открыть ТехЗаказ →</a>`,
          {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[
                  Markup.button.callback('🔗 Отвязать Telegram', 'profile:unlink')
              ]])
          }
      );
  });

  bot.action('profile:unlink', async (ctx) => {
      try {
          await pool.query(
              'UPDATE users SET telegram_id=NULL WHERE id=$1',
              [ctx.tgUser.id]
          );
          await ctx.editMessageText('Telegram отвязан. Для повторной привязки используйте настройки сайта.');
          await ctx.answerCbQuery();
      } catch (e) {
          ctx.answerCbQuery('Ошибка');
      }
  });
  ```

- [ ] **Step 4: Запустить polling в конце startTelegramBot**

  В конце функции `startTelegramBot()`, перед `return bot`, добавь:
  ```javascript
  bot.launch({ dropPendingUpdates: true });
  console.log('[tg] Telegram бот запущен (polling)');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
  ```

- [ ] **Step 5: Проверить синтаксис**

  ```bash
  node --check telegram-bot.js && npm test
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add telegram-bot.js
  git commit -m "feat: Telegram меню 'Сделки', 'Уведомления', 'Профиль' + запуск polling"
  ```

---

### Task 8: Подключить бота к server.js и UI в settings.html

**Files:**
- Modify: `server.js` — импорт и вызов startTelegramBot в start()
- Modify: `settings.html` — секция Telegram

- [ ] **Step 1: Добавить импорт в server.js**

  В начало `server.js` (после других require):
  ```javascript
  const { startTelegramBot } = require('./telegram-bot');
  ```

- [ ] **Step 2: Вызвать startTelegramBot в функции start()**

  Найди функцию `async function start()`. После `startDigestCron(); startAuctionCron(); startOrderMaintenanceCron();` добавь:
  ```javascript
  startTelegramBot();
  ```

- [ ] **Step 3: Добавить секцию Telegram в settings.html**

  Найди подходящее место в `settings.html` (рядом с секцией Push или интеграций). Добавь:
  ```html
  <div class="settings-section">
    <h3>Telegram</h3>
    <p style="color:var(--text-secondary);font-size:14px;margin-bottom:16px;">
      Управляйте закупками, отвечайте на КП и общайтесь с партнёрами прямо в Telegram.
    </p>
    <div id="tgStatus" style="margin-bottom:12px;font-size:14px;color:var(--text-secondary);">Проверка...</div>
    <button id="tgLinkBtn" class="btn btn-primary" onclick="handleTgLink()" style="display:none;">
      Подключить Telegram
    </button>
    <button id="tgUnlinkBtn" class="btn btn-secondary" onclick="handleTgUnlink()" style="display:none;">
      Отвязать Telegram
    </button>
  </div>
  ```

- [ ] **Step 4: Добавить скрипт Telegram в settings.html**

  В page-specific `<script>` settings.html добавь:
  ```javascript
  async function initTgUI() {
      const status = document.getElementById('tgStatus');
      const linkBtn = document.getElementById('tgLinkBtn');
      const unlinkBtn = document.getElementById('tgUnlinkBtn');
      if (!status) return;
      try {
          const res = await apiFetch('/telegram/status');
          const data = await res.json();
          if (data.linked) {
              status.textContent = '✅ Telegram подключён';
              if (unlinkBtn) unlinkBtn.style.display = '';
          } else {
              status.textContent = 'Telegram не подключён';
              if (linkBtn) linkBtn.style.display = '';
          }
      } catch { status.textContent = ''; }
  }

  async function handleTgLink() {
      try {
          const res = await apiFetch('/telegram/link-token', { method: 'POST' });
          const data = await res.json();
          if (data.deepLink) {
              window.open(data.deepLink, '_blank');
              showToast('Откройте ссылку в Telegram и следуйте инструкциям', 'info');
          }
      } catch (e) { showToast('Ошибка: ' + e.message, 'error'); }
  }

  async function handleTgUnlink() {
      if (!confirm('Отвязать Telegram аккаунт?')) return;
      try {
          await apiFetch('/telegram/unlink', { method: 'DELETE' });
          showToast('Telegram отвязан', 'success');
          initTgUI();
      } catch (e) { showToast('Ошибка: ' + e.message, 'error'); }
  }

  initTgUI();
  ```

- [ ] **Step 5: Проверить**

  ```bash
  npm test
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add server.js settings.html
  git commit -m "feat: подключить Telegram бота к server.js и добавить UI привязки в settings.html"
  ```

---

### Task 9: Push to main

- [ ] **Step 1: Финальная проверка**

  ```bash
  npm test
  ```

- [ ] **Step 2: Push**

  ```bash
  git push origin main
  ```

- [ ] **Step 3: На VPS — обновить .env и перезапустить**

  ```bash
  # На VPS:
  nano /var/www/neft/.env
  # Добавить TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_NAME
  pm2 restart neft
  # Проверить логи:
  pm2 logs neft --lines 30
  # Ожидаемый вывод: "[tg] Telegram бот запущен (polling)"
  ```
