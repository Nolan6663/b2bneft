# Аукцион: авто-конвертация в сделку + уведомления о закрытии — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** При закрытии реверсивного аукциона (по таймеру) победившая ставка автоматически становится сделкой (`proposals` со статусом `'Выигран'`), а победитель, заказчик и проигравшие участники получают уведомления. Сейчас закрытие аукциона проходит незаметно — только тихое socket-событие, которое никто не слушает.

**Architecture:** Общая логика «принять предложение → закрыть заявку → уведомить» уже существует в ручном accept-эндпоинте (`routes/proposals.js`). Выносим её переиспользуемую часть в `lib/proposal-accept.js`, вызываем из обоих мест: ручного accept и `closeExpiredAuctions()` (cron в `server.js`). Ставка (`auction_bids`) получает новое поле `days`, чтобы было что положить в обязательное `proposals.days`.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), Socket.io — без новых зависимостей.

## Global Constraints

- Рабочая директория: `C:\Users\Админ\source\repos`
- `npm run check` (== `npm test`) должен проходить после каждой задачи (static-checks.js: синтаксис, guardrails, CSS-баланс)
- Спека: `docs/superpowers/specs/2026-07-01-auction-completion-design.md` — при расхождении сверяться с ней
- Ничего не менять в `docs/design/texzakaz-visual-identity.md` / визуальных токенах — новых UI-компонентов, кроме поля срока и toast, не добавляется
- Не создавать `proposals`-строки для проигравших участников аукциона — им только колокольчик
- Деплой не входит в эту работу (только код + миграция схемы, которая накатится сама через `db.js` при следующем `pm2 restart`)

---

### Task 1: Миграция схемы — срок ставки и ссылка на выигранную сделку

**Files:**
- Modify: `db.js` — блок `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (строки 256-269)

**Interfaces:**
- Produces: колонка `auction_bids.days INTEGER NOT NULL DEFAULT 0`, колонка `auctions.winner_proposal_id INTEGER REFERENCES proposals(id)`

- [ ] **Step 1: Найти блок ALTER TABLE в db.js**

  Открой `db.js`, найди строку:
  ```javascript
          ALTER TABLE auctions ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;
  ```

- [ ] **Step 2: Добавить две новые строки сразу после неё**

  ```javascript
          ALTER TABLE auctions ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;
          ALTER TABLE auctions ADD COLUMN IF NOT EXISTS winner_proposal_id INTEGER REFERENCES proposals(id);
          ALTER TABLE auction_bids ADD COLUMN IF NOT EXISTS days INTEGER NOT NULL DEFAULT 0;
  ```

- [ ] **Step 3: Проверить синтаксис**

  ```bash
  node --check db.js
  ```
  Ожидаемый результат: без вывода (exit code 0)

- [ ] **Step 4: Применить миграцию локально**

  ```bash
  npm start
  ```
  В логах должно быть штатное завершение инициализации БД (без ошибок SQL), затем останови сервер (Ctrl+C).

- [ ] **Step 5: Commit**

  ```bash
  git add db.js
  git commit -m "feat: добавить auction_bids.days и auctions.winner_proposal_id"
  ```

---

### Task 2: Вынести логику принятия предложения в переиспользуемую функцию

**Files:**
- Create: `lib/proposal-accept.js`
- Modify: `routes/proposals.js:1-34` (добавить require), `routes/proposals.js:122-190` (заменить тело на вызов общей функции)

**Interfaces:**
- Produces: `acceptWonProposal(deps, { proposalId, actorCompany })` → `Promise<{ ok: true, orderTitle: string, orderRow: object, winner: { id, company, price, days } } | { ok: false, reason: 'proposal_not_found' | 'order_not_found' | 'order_already_closed' }>`
  - `deps` — объект с полями: `pool, withTransaction, addNotification, getCompanyEmail, sendEmail, getUserIdsByCompany, sendPush, sendTelegramNotification, triggerIntegrations, logOrderEvent, plainTitle, htmlEscape, APP_URL` (все уже существуют в `server.js` и в `deps` роутера `routes/proposals.js`)
- Consumes (Task 4 будет вызывать эту же функцию из `server.js`)

- [ ] **Step 1: Создать lib/proposal-accept.js**

  ```javascript
  'use strict';

  async function acceptWonProposal(deps, { proposalId, actorCompany }) {
      const {
          pool, withTransaction, addNotification, getCompanyEmail, sendEmail,
          getUserIdsByCompany, sendPush, sendTelegramNotification,
          triggerIntegrations, logOrderEvent, plainTitle, htmlEscape, APP_URL,
      } = deps;

      const { rows: [proposalRow] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
      if (!proposalRow) return { ok: false, reason: 'proposal_not_found' };

      const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [proposalRow.order_id]);
      if (!orderRow) return { ok: false, reason: 'order_not_found' };
      if (orderRow.status === 'Закрыта' || orderRow.status === 'Отменена') {
          return { ok: false, reason: 'order_already_closed' };
      }

      const title = plainTitle(orderRow.title);
      const notifs = [];

      await withTransaction(async (client) => {
          await client.query("UPDATE orders SET status = 'Закрыта' WHERE id = $1", [orderRow.id]);
          const { rows: allProposals } = await client.query('SELECT * FROM proposals WHERE order_id = $1', [orderRow.id]);
          for (const p of allProposals) {
              if (p.id === proposalId) {
                  await client.query("UPDATE proposals SET status = 'Выигран' WHERE id = $1", [p.id]);
                  await client.query(
                      "INSERT INTO delivery_events (proposal_id, stage, notes, updated_by) VALUES ($1, 'КП принят', $2, 'system')",
                      [p.id, `КП принят заказчиком. Сумма: ${p.price ? p.price.toLocaleString('ru-RU') + ' ₽' : '—'}, срок: ${p.days} дн.`]
                  );
                  notifs.push({ company: p.company, text: `Ваше предложение по «${title}» принято! Заказ выигран.` });
              } else {
                  await client.query("UPDATE proposals SET status = 'Отклонен' WHERE id = $1", [p.id]);
                  notifs.push({ company: p.company, text: `Ваше предложение по «${title}» отклонено.` });
              }
          }
      });

      await logOrderEvent(
          orderRow.id,
          'closed',
          'Закупка закрыта — КП принято',
          `${proposalRow.company} · ${Number(proposalRow.price).toLocaleString('ru-RU')} ₽`,
          actorCompany
      );

      const wonProposal = { id: proposalId, company: proposalRow.company, price: proposalRow.price, days: proposalRow.days };
      // triggerIntegrations looks up integrations by the ORDER OWNER's company, not the actor — must stay orderRow.company even when actorCompany is 'Система (аукцион)'
      triggerIntegrations(orderRow.company, wonProposal, orderRow).catch(() => {});

      await Promise.all(notifs.map(n => addNotification(n.company, n.text)));
      await Promise.all(notifs.map(async n => {
          const email = await getCompanyEmail(n.company);
          const won = n.text.includes('принято');
          if (email) await sendEmail(email, won ? `Предложение принято — «${title}»` : `Предложение отклонено — «${title}»`,
              `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                <h3 style="color:${won ? '#41bd97' : '#e07070'}">${won ? 'Ваше предложение принято!' : 'Предложение отклонено'}</h3>
                <p>${won
                  ? `Поздравляем! Заказчик выбрал ваше предложение по закупке <strong>«${htmlEscape(title)}»</strong>.`
                  : `К сожалению, заказчик выбрал другого поставщика по закупке <strong>«${htmlEscape(title)}»</strong>.`
                }</p>
                <a href="${APP_URL}/producer.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
              </div>`
          );
      }));
      getUserIdsByCompany(proposalRow.company).then(ids =>
          ids.forEach(id => {
              sendPush(id, 'КП принято!', `Ваше предложение по заявке «${title}» принято`, `${APP_URL}/deals`);
              sendTelegramNotification(id, `✅ <b>КП принято!</b>\nЗакупка: «${title}»\nЗаказчик выбрал ваше предложение.`);
          })
      ).catch(() => {});

      return { ok: true, orderTitle: title, orderRow, winner: wonProposal };
  }

  module.exports = { acceptWonProposal };
  ```

- [ ] **Step 2: Проверить синтаксис**

  ```bash
  node --check lib/proposal-accept.js
  ```
  Ожидаемый результат: без вывода

- [ ] **Step 3: Подключить в routes/proposals.js**

  Найди в `routes/proposals.js` строку 1-3:
  ```javascript
  'use strict';

  const express = require('express');
  ```

  Замени на:
  ```javascript
  'use strict';

  const express = require('express');
  const { acceptWonProposal } = require('../lib/proposal-accept');
  ```

- [ ] **Step 4: Заменить тело accept-эндпоинта**

  Найди в `routes/proposals.js` блок (строки 122-190):
  ```javascript
      router.post('/:proposalId/accept', requireAuth, requireRole('customer'), async (req, res, next) => {
          try {
              const proposalId = Number(req.params.proposalId);
              const { rows: [proposalRow] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
              if (!proposalRow) return res.status(404).json({ error: 'Предложение не найдено' });

              const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [proposalRow.order_id]);
              if (!orderRow) return res.status(404).json({ error: 'Связанная заявка не найдена' });
              if (orderRow.company && orderRow.company !== req.user.company) return res.status(403).json({ error: 'Принимать предложения может только владелец закупки' });
              if (orderRow.status === 'Закрыта' || orderRow.status === 'Отменена') {
                  return res.status(400).json({ error: 'Эта прямая закупка уже завершена' });
              }

              const title = plainTitle(orderRow.title);
              const notifs = [];

              await withTransaction(async (client) => {
                  await client.query("UPDATE orders SET status = 'Закрыта' WHERE id = $1", [orderRow.id]);
                  const { rows: allProposals } = await client.query('SELECT * FROM proposals WHERE order_id = $1', [orderRow.id]);
                  for (const p of allProposals) {
                      if (p.id === proposalId) {
                          await client.query("UPDATE proposals SET status = 'Выигран' WHERE id = $1", [p.id]);
                          await client.query(
                              "INSERT INTO delivery_events (proposal_id, stage, notes, updated_by) VALUES ($1, 'КП принят', $2, 'system')",
                              [p.id, `КП принят заказчиком. Сумма: ${p.price ? p.price.toLocaleString('ru-RU') + ' ₽' : '—'}, срок: ${p.days} дн.`]
                          );
                          notifs.push({ company: p.company, text: `Ваше предложение по «${title}» принято! Заказ выигран.` });
                      } else {
                          await client.query("UPDATE proposals SET status = 'Отклонен' WHERE id = $1", [p.id]);
                          notifs.push({ company: p.company, text: `Ваше предложение по «${title}» отклонено.` });
                      }
                  }
              });

              await logOrderEvent(
                  orderRow.id,
                  'closed',
                  'Закупка закрыта — КП принято',
                  `${proposalRow.company} · ${Number(proposalRow.price).toLocaleString('ru-RU')} ₽`,
                  req.user.company
              );

              const wonProposal = { id: proposalId, company: proposalRow.company, price: proposalRow.price, days: proposalRow.days };
              triggerIntegrations(req.user.company, wonProposal, orderRow).catch(() => {});

              await Promise.all(notifs.map(n => addNotification(n.company, n.text)));
              await Promise.all(notifs.map(async n => {
                  const email = await getCompanyEmail(n.company);
                  const won = n.text.includes('принято');
                  if (email) await sendEmail(email, won ? `Предложение принято — «${title}»` : `Предложение отклонено — «${title}»`,
                      `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                        <h3 style="color:${won ? '#41bd97' : '#e07070'}">${won ? 'Ваше предложение принято!' : 'Предложение отклонено'}</h3>
                        <p>${won
                          ? `Поздравляем! Заказчик выбрал ваше предложение по закупке <strong>«${htmlEscape(title)}»</strong>.`
                          : `К сожалению, заказчик выбрал другого поставщика по закупке <strong>«${htmlEscape(title)}»</strong>.`
                        }</p>
                        <a href="${APP_URL}/producer.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                      </div>`
                  );
              }));
              getUserIdsByCompany(proposalRow.company).then(ids =>
                  ids.forEach(id => {
                      sendPush(id, 'КП принято!', `Ваше предложение по заявке «${title}» принято`, `${APP_URL}/deals`);
                      sendTelegramNotification(id, `✅ <b>КП принято!</b>\nЗакупка: «${title}»\nЗаказчик выбрал ваше предложение.`);
                  })
              ).catch(() => {});
              res.json({ message: 'Победитель успешно определен, прямая закупка закрыта' });
          } catch (e) { next(e); }
      });
  ```

  Замени на:
  ```javascript
      router.post('/:proposalId/accept', requireAuth, requireRole('customer'), async (req, res, next) => {
          try {
              const proposalId = Number(req.params.proposalId);
              const { rows: [proposalRow] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
              if (!proposalRow) return res.status(404).json({ error: 'Предложение не найдено' });

              const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [proposalRow.order_id]);
              if (!orderRow) return res.status(404).json({ error: 'Связанная заявка не найдена' });
              if (orderRow.company && orderRow.company !== req.user.company) return res.status(403).json({ error: 'Принимать предложения может только владелец закупки' });
              if (orderRow.status === 'Закрыта' || orderRow.status === 'Отменена') {
                  return res.status(400).json({ error: 'Эта прямая закупка уже завершена' });
              }

              const result = await acceptWonProposal(
                  { pool, withTransaction, addNotification, getCompanyEmail, sendEmail, getUserIdsByCompany, sendPush, sendTelegramNotification, triggerIntegrations, logOrderEvent, plainTitle, htmlEscape, APP_URL },
                  { proposalId, actorCompany: req.user.company }
              );
              if (!result.ok) return res.status(400).json({ error: 'Эта прямая закупка уже завершена' });

              res.json({ message: 'Победитель успешно определен, прямая закупка закрыта' });
          } catch (e) { next(e); }
      });
  ```

  (Проверка владельца заявки и статуса заявки остаётся в роуте — она специфична для ручного действия пользователя; `acceptWonProposal` дублирует проверку статуса на всякий случай для защиты от гонки с cron-закрытием аукциона.)

- [ ] **Step 5: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...` (0 ошибок)

- [ ] **Step 6: Ручная проверка, что ручной accept не сломался**

  ```bash
  npm start
  ```
  В другом терминале — залогинься заказчиком и поставщиком (или используй существующие сид-данные), создай заявку, подай КП, прими его через UI (`index.html` → карточка закупки → «Принять»). Проверь:
  - заявка получила статус «Закрыта»
  - КП получило статус «Выигран», сделка видна в `deals.html`
  - поставщику пришло email/push/Telegram уведомление о принятии

  Останови сервер (Ctrl+C).

- [ ] **Step 7: Commit**

  ```bash
  git add lib/proposal-accept.js routes/proposals.js
  git commit -m "refactor: вынести логику принятия КП в lib/proposal-accept.js"
  ```

---

### Task 3: Ставка получает срок поставки

**Files:**
- Modify: `server.js:1785-1810` (эндпоинт `POST /api/auctions/:id/bid`)
- Modify: `producer.html:313-316` (форма ставки), `producer.html:893-922` (`openBidModal`, `submitBid`)

**Interfaces:**
- Produces: `auction_bids.days`, `POST /api/auctions/:id/bid` body теперь `{ price, days }`

- [ ] **Step 1: Обновить бэкенд — принять и сохранить days**

  Найди в `server.js` (строки 1785-1810):
  ```javascript
  // Submit bid (producer only)
  app.post('/api/auctions/:id/bid', requireAuth, async (req, res, next) => {
      try {
          if (req.user.role !== 'producer') return res.status(403).json({ error: 'Только поставщики могут делать ставки' });
          const { price } = req.body;
          if (!price || isNaN(price)) return res.status(400).json({ error: 'Укажите цену' });

          const { rows: [auction] } = await pool.query(
              "SELECT * FROM auctions WHERE id = $1 AND status = 'active' AND end_time > NOW()", [req.params.id]
          );
          if (!auction) return res.status(404).json({ error: 'Аукцион не найден или завершён' });
          if (Number(price) >= Number(auction.current_best)) {
              return res.status(400).json({ error: `Ставка должна быть ниже текущей лучшей: ${auction.current_best} ₽` });
          }

          const { rows: [bid] } = await pool.query(
              'INSERT INTO auction_bids (auction_id, company, price) VALUES ($1,$2,$3) RETURNING *',
              [req.params.id, req.user.company, price]
          );
          await pool.query('UPDATE auctions SET current_best = $1, winner_company = $2 WHERE id = $3', [price, req.user.company, req.params.id]);

          if (io) io.to(`auction:${req.params.id}`).emit('auction:bid', {
              auctionId: Number(req.params.id), company: req.user.company, price: Number(price), bidId: bid.id, createdAt: bid.created_at
          });
          res.json(bid);
      } catch (e) { next(e); }
  });
  ```

  Замени на:
  ```javascript
  // Submit bid (producer only)
  app.post('/api/auctions/:id/bid', requireAuth, async (req, res, next) => {
      try {
          if (req.user.role !== 'producer') return res.status(403).json({ error: 'Только поставщики могут делать ставки' });
          const { price, days } = req.body;
          if (!price || isNaN(price)) return res.status(400).json({ error: 'Укажите цену' });
          if (!days || isNaN(days) || Number(days) <= 0) return res.status(400).json({ error: 'Укажите срок поставки' });

          const { rows: [auction] } = await pool.query(
              "SELECT * FROM auctions WHERE id = $1 AND status = 'active' AND end_time > NOW()", [req.params.id]
          );
          if (!auction) return res.status(404).json({ error: 'Аукцион не найден или завершён' });
          if (Number(price) >= Number(auction.current_best)) {
              return res.status(400).json({ error: `Ставка должна быть ниже текущей лучшей: ${auction.current_best} ₽` });
          }

          const { rows: [bid] } = await pool.query(
              'INSERT INTO auction_bids (auction_id, company, price, days) VALUES ($1,$2,$3,$4) RETURNING *',
              [req.params.id, req.user.company, price, days]
          );
          await pool.query('UPDATE auctions SET current_best = $1, winner_company = $2 WHERE id = $3', [price, req.user.company, req.params.id]);

          if (io) io.to(`auction:${req.params.id}`).emit('auction:bid', {
              auctionId: Number(req.params.id), company: req.user.company, price: Number(price), bidId: bid.id, createdAt: bid.created_at
          });
          res.json(bid);
      } catch (e) { next(e); }
  });
  ```

- [ ] **Step 2: Добавить поле срока в форму ставки**

  Найди в `producer.html` (строка 313-315):
  ```html
              <label style="font-size:13px;font-weight:600;">Ваша ставка (₽)
                  <input id="bidPriceInput" type="number" min="1" style="width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--card-border);border-radius:8px;font-size:14px;background:var(--inner-bg);color:var(--text-primary);font-family:inherit;box-sizing:border-box;" placeholder="Введите сумму ниже текущей">
              </label>
  ```

  Замени на:
  ```html
              <label style="font-size:13px;font-weight:600;">Ваша ставка (₽)
                  <input id="bidPriceInput" type="number" min="1" style="width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--card-border);border-radius:8px;font-size:14px;background:var(--inner-bg);color:var(--text-primary);font-family:inherit;box-sizing:border-box;" placeholder="Введите сумму ниже текущей">
              </label>
              <label style="font-size:13px;font-weight:600;margin-top:12px;display:block;">Срок поставки (дн.)
                  <input id="bidDaysInput" type="number" min="1" style="width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--card-border);border-radius:8px;font-size:14px;background:var(--inner-bg);color:var(--text-primary);font-family:inherit;box-sizing:border-box;" placeholder="Например, 14">
              </label>
  ```

- [ ] **Step 3: Сбрасывать поле срока при открытии модалки**

  Найди в `producer.html` (`openBidModal`, строки 893-900):
  ```javascript
          function openBidModal(auctionId, currentBest, title, desc, endTime) {
              _bidAuctionId = auctionId;
              document.getElementById('bidModal').style.display = 'flex';
              document.getElementById('bidModalDesc').textContent = title + (desc ? ` — ${desc}` : '');
              document.getElementById('bidModalCurrent').textContent = new Intl.NumberFormat('ru-RU').format(currentBest) + ' ₽';
              document.getElementById('bidPriceInput').value = '';
              document.getElementById('bidPriceInput').max = currentBest - 1;
          }
  ```

  Замени на:
  ```javascript
          function openBidModal(auctionId, currentBest, title, desc, endTime) {
              _bidAuctionId = auctionId;
              document.getElementById('bidModal').style.display = 'flex';
              document.getElementById('bidModalDesc').textContent = title + (desc ? ` — ${desc}` : '');
              document.getElementById('bidModalCurrent').textContent = new Intl.NumberFormat('ru-RU').format(currentBest) + ' ₽';
              document.getElementById('bidPriceInput').value = '';
              document.getElementById('bidPriceInput').max = currentBest - 1;
              document.getElementById('bidDaysInput').value = '';
          }
  ```

- [ ] **Step 4: Отправлять days вместе с price**

  Найди в `producer.html` (`submitBid`, строки 907-922):
  ```javascript
          async function submitBid() {
              if (!_bidAuctionId) return;
              const price = Number(document.getElementById('bidPriceInput').value);
              if (!price || price <= 0) { showToast('Введите цену', 'error'); return; }
              try {
                  const r = await apiFetch(`${SERVER_URL}/auctions/${_bidAuctionId}/bid`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ price })
                  });
                  if (!r.ok) { const e = await r.json(); showToast(e.error || 'Ошибка', 'error'); return; }
                  showToast('Ставка принята!', 'success');
                  closeBidModal();
                  loadActiveAuctions();
              } catch { showToast('Ошибка при отправке ставки', 'error'); }
          }
  ```

  Замени на:
  ```javascript
          async function submitBid() {
              if (!_bidAuctionId) return;
              const price = Number(document.getElementById('bidPriceInput').value);
              const days = Number(document.getElementById('bidDaysInput').value);
              if (!price || price <= 0) { showToast('Введите цену', 'error'); return; }
              if (!days || days <= 0) { showToast('Введите срок поставки', 'error'); return; }
              try {
                  const r = await apiFetch(`${SERVER_URL}/auctions/${_bidAuctionId}/bid`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ price, days })
                  });
                  if (!r.ok) { const e = await r.json(); showToast(e.error || 'Ошибка', 'error'); return; }
                  showToast('Ставка принята!', 'success');
                  closeBidModal();
                  loadActiveAuctions();
              } catch { showToast('Ошибка при отправке ставки', 'error'); }
          }
  ```

- [ ] **Step 5: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 6: Ручная проверка**

  ```bash
  npm start
  ```
  Заказчиком создай аукцион, поставщиком открой «Аукционы» → «Сделать ставку» → укажи цену и срок → отправь.
  Проверь в БД:
  ```bash
  node -e "require('./db').pool.query('SELECT price, days, company FROM auction_bids ORDER BY id DESC LIMIT 1').then(r => { console.log(r.rows[0]); process.exit(0); })"
  ```
  Ожидаемый результат: строка со введёнными `price` и `days`. Останови сервер (Ctrl+C).

- [ ] **Step 7: Commit**

  ```bash
  git add server.js producer.html
  git commit -m "feat: ставка в аукционе теперь включает срок поставки"
  ```

---

### Task 4: Авто-конвертация выигранной ставки в сделку + уведомления

**Files:**
- Modify: `server.js:1825-1834` (`closeExpiredAuctions`)

**Interfaces:**
- Consumes: `acceptWonProposal(deps, { proposalId, actorCompany })` из Task 2
- Produces: `io.to('auction:{id}').emit('auction:closed', { auctionId, winnerCompany, price, orderId })` — `winnerCompany` может быть `null` (аукцион без ставок)

- [ ] **Step 1: Подключить acceptWonProposal в server.js**

  Найди в `server.js` строку:
  ```javascript
  const { fetchEgrulData, evaluateAutoVerification } = require('./lib/egrul-verify');
  ```

  Добавь сразу после неё:
  ```javascript
  const { acceptWonProposal } = require('./lib/proposal-accept');
  ```

- [ ] **Step 2: Заменить closeExpiredAuctions**

  Найди в `server.js` (строки 1825-1835):
  ```javascript
  // Auto-close expired auctions (called by cron)
  async function closeExpiredAuctions() {
      try {
          const { rows } = await pool.query(
              "UPDATE auctions SET status = 'closed' WHERE status = 'active' AND end_time <= NOW() RETURNING id, winner_company, order_id"
          );
          for (const a of rows) {
              if (io) io.to(`auction:${a.id}`).emit('auction:closed', { auctionId: a.id, winnerCompany: a.winner_company });
          }
      } catch (e) { console.error('[cron:auctions]', e.message); }
  }
  ```

  Замени на:
  ```javascript
  // Auto-close expired auctions (called by cron)
  async function closeExpiredAuctions() {
      let rows;
      try {
          ({ rows } = await pool.query(
              "UPDATE auctions SET status = 'closed' WHERE status = 'active' AND end_time <= NOW() RETURNING id, order_id, winner_company, current_best"
          ));
      } catch (e) { console.error('[cron:auctions]', e.message); return; }

      for (const a of rows) {
          try {
              await handleClosedAuction(a);
          } catch (e) {
              console.error('[cron:auctions] failed for auction', a.id, e.message);
          }
      }
  }

  async function handleClosedAuction(a) {
      const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1', [a.order_id]);
      if (!order) return;
      const title = plainTitle(order.title);

      if (!a.winner_company) {
          await addNotification(order.company, `Аукцион «${title}» завершён без ставок.`);
          const email = await getCompanyEmail(order.company);
          if (email) {
              await sendEmail(email, `Аукцион завершён без ставок — «${title}»`,
                  `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                    <h3 style="color:#e07070">Аукцион завершён без ставок</h3>
                    <p>По закупке <strong>«${htmlEscape(title)}»</strong> никто не сделал ставку в течение отведённого времени.</p>
                    <a href="${APP_URL}/index.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                  </div>`
              );
          }
          if (io) io.to(`auction:${a.id}`).emit('auction:closed', { auctionId: a.id, winnerCompany: null, orderId: a.order_id });
          return;
      }

      const { rows: [winningBid] } = await pool.query(
          'SELECT days FROM auction_bids WHERE auction_id = $1 AND company = $2 AND price = $3 ORDER BY created_at ASC LIMIT 1',
          [a.id, a.winner_company, a.current_best]
      );
      const days = winningBid ? winningBid.days : 0;

      const { rows: [newProposal] } = await pool.query(
          "INSERT INTO proposals (order_id, order_title, price, days, company, status, kp_file) VALUES ($1,$2,$3,$4,$5,'Ожидает ответа',NULL) RETURNING id",
          [a.order_id, order.title, a.current_best, days, a.winner_company]
      );

      const result = await acceptWonProposal(
          { pool, withTransaction, addNotification, getCompanyEmail, sendEmail, getUserIdsByCompany, sendPush, sendTelegramNotification, triggerIntegrations, logOrderEvent, plainTitle, htmlEscape, APP_URL },
          { proposalId: newProposal.id, actorCompany: 'Система (аукцион)' }
      );
      if (!result.ok) {
          console.error('[cron:auctions] accept failed for auction', a.id, result.reason);
          return;
      }

      await pool.query('UPDATE auctions SET winner_proposal_id = $1 WHERE id = $2', [newProposal.id, a.id]);
      await addNotification(a.winner_company, `Вы выиграли аукцион «${title}»! Цена: ${Number(a.current_best).toLocaleString('ru-RU')} ₽.`);

      await addNotification(order.company, `Аукцион «${title}» завершён. Победитель: ${a.winner_company}, ${Number(a.current_best).toLocaleString('ru-RU')} ₽.`);
      const customerEmail = await getCompanyEmail(order.company);
      if (customerEmail) {
          await sendEmail(customerEmail, `Аукцион завершён — «${title}»`,
              `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                <h3 style="color:#41bd97">Аукцион завершён</h3>
                <p>По закупке <strong>«${htmlEscape(title)}»</strong> определён победитель.</p>
                <p>Поставщик: <strong>${htmlEscape(a.winner_company)}</strong> · Цена: <strong>${Number(a.current_best).toLocaleString('ru-RU')} ₽</strong></p>
                <a href="${APP_URL}/deals.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть сделку</a>
              </div>`
          );
      }
      const customerIds = await getUserIdsByCompany(order.company);
      for (const id of customerIds) {
          sendTelegramNotification(id, `🏁 <b>Аукцион завершён</b>\n«${title}»\nПобедитель: ${a.winner_company}\nЦена: ${Number(a.current_best).toLocaleString('ru-RU')} ₽`);
      }

      const { rows: losers } = await pool.query(
          'SELECT DISTINCT company FROM auction_bids WHERE auction_id = $1 AND company != $2',
          [a.id, a.winner_company]
      );
      for (const l of losers) {
          await addNotification(l.company, `Аукцион «${title}» завершён. Ваша ставка не победила.`);
      }

      if (io) io.to(`auction:${a.id}`).emit('auction:closed', { auctionId: a.id, winnerCompany: a.winner_company, price: a.current_best, orderId: a.order_id });
      emitDashboardRefresh(a.winner_company);
      emitDashboardRefresh(order.company);
  }
  ```

  Примечание: `acceptWonProposal` уже отправляет победителю email + push + Telegram + колокольчик («КП принято!») через свой обычный accept-флоу — отдельно добавлен только уточняющий колокольчик с явной формулировкой «выиграли аукцион», чтобы не дублировать email/Telegram спамом.

- [ ] **Step 3: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 4: Ручная проверка полного цикла**

  ```bash
  npm start
  ```
  1. Заказчиком создай заявку → запусти аукцион с коротким сроком (в БД можно временно поставить `end_time` в прошлое вместо ожидания):
     ```bash
     node -e "require('./db').pool.query(\"UPDATE auctions SET end_time = NOW() - INTERVAL '1 minute' WHERE status='active' ORDER BY id DESC LIMIT 1\").then(() => process.exit(0))"
     ```
  2. Двумя поставщиками сделай по ставке (цена + срок).
  3. Повтори UPDATE end_time в прошлое (шаг 1) после ставок.
  4. Подожди до 60 секунд (cron `* * * * *`).
  5. Проверь:
     ```bash
     node -e "require('./db').pool.query(\"SELECT a.status, a.winner_company, a.winner_proposal_id, p.status AS proposal_status, o.status AS order_status FROM auctions a JOIN proposals p ON p.id = a.winner_proposal_id JOIN orders o ON o.id = a.order_id ORDER BY a.id DESC LIMIT 1\").then(r => { console.log(r.rows[0]); process.exit(0); })"
     ```
     Ожидаемый результат: `status: 'closed'`, `proposal_status: 'Выигран'`, `order_status: 'Закрыта'`, `winner_proposal_id` не null.
  6. Проверь, что сделка видна в `deals.html` у обеих сторон.
  7. Проверь колокольчик у победителя, заказчика и проигравшего поставщика.

  Останови сервер (Ctrl+C).

- [ ] **Step 5: Commit**

  ```bash
  git add server.js
  git commit -m "feat: авто-конвертация выигранного аукциона в сделку + уведомления"
  ```

---

### Task 5: Фронт реагирует на закрытие аукциона

**Files:**
- Modify: `index.html:1756-1773` (`joinAuctionSocket`)
- Modify: `producer.html:431-455` (`DOMContentLoaded`, `window.__pageInit`)

**Interfaces:**
- Consumes: socket-событие `auction:closed` из Task 4 — `{ auctionId, winnerCompany, price, orderId }`

- [ ] **Step 1: index.html — слушать auction:closed внутри joinAuctionSocket**

  Найди в `index.html` (строки 1756-1773):
  ```javascript
          function joinAuctionSocket(auctionId) {
              if (typeof socket !== 'undefined' && socket) {
                  socket.emit('join-auction', auctionId);
                  socket.off('auction:bid').on('auction:bid', data => {
                      if (data.auctionId !== auctionId) return;
                      document.getElementById('auctionBestPrice').textContent =
                          new Intl.NumberFormat('ru-RU').format(data.price) + ' ₽';
                      document.getElementById('auctionLeader').textContent = data.company;
                      const bidsEl = document.getElementById('auctionBidsList');
                      const row = `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--inner-border);">
                          <span>${escapeHtml(data.company)}</span>
                          <span style="font-family:'JetBrains Mono',monospace;font-weight:700;">${new Intl.NumberFormat('ru-RU').format(data.price)} ₽</span>
                      </div>`;
                      bidsEl.innerHTML = row + bidsEl.innerHTML;
                      showToast(`Новая ставка: ${new Intl.NumberFormat('ru-RU').format(data.price)} ₽ от ${data.company}`, 'info');
                  });
              }
          }
  ```

  Замени на:
  ```javascript
          function joinAuctionSocket(auctionId) {
              if (typeof socket !== 'undefined' && socket) {
                  socket.emit('join-auction', auctionId);
                  socket.off('auction:bid').on('auction:bid', data => {
                      if (data.auctionId !== auctionId) return;
                      document.getElementById('auctionBestPrice').textContent =
                          new Intl.NumberFormat('ru-RU').format(data.price) + ' ₽';
                      document.getElementById('auctionLeader').textContent = data.company;
                      const bidsEl = document.getElementById('auctionBidsList');
                      const row = `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--inner-border);">
                          <span>${escapeHtml(data.company)}</span>
                          <span style="font-family:'JetBrains Mono',monospace;font-weight:700;">${new Intl.NumberFormat('ru-RU').format(data.price)} ₽</span>
                      </div>`;
                      bidsEl.innerHTML = row + bidsEl.innerHTML;
                      showToast(`Новая ставка: ${new Intl.NumberFormat('ru-RU').format(data.price)} ₽ от ${data.company}`, 'info');
                  });
                  socket.off('auction:closed').on('auction:closed', data => {
                      if (data.auctionId !== auctionId) return;
                      if (data.winnerCompany) {
                          showToast(`Аукцион завершён! Победитель: ${data.winnerCompany}, ${new Intl.NumberFormat('ru-RU').format(data.price)} ₽`, 'success');
                      } else {
                          showToast('Аукцион завершён без ставок', 'warn');
                      }
                      if (_detailPanelOrderId) loadAuctionForOrder(_detailPanelOrderId);
                  });
              }
          }
  ```

- [ ] **Step 2: producer.html — глобальный слушатель auction:closed при инициализации страницы**

  Найди в `producer.html` (строки 431-455):
  ```javascript
          window.addEventListener('DOMContentLoaded', () => {
              loadCompanyInfo();
              loadOrdersForProducers();
              initNotifications();
              initSidebarBadges();
              if (!isGuest) { loadMyProposals(); loadCrmStats(); loadActiveAuctions(); }
              document.getElementById('orderSearchInput').addEventListener('input', applyOrderFilters);
              document.addEventListener('tz:order:new', onTzOrderNew);
          });

          window.__pageInit = function() {
              loadCompanyInfo();
              loadOrdersForProducers();
              initNotifications();
              initSidebarBadges();
              if (!isGuest) { loadMyProposals(); loadCrmStats(); loadActiveAuctions(); }
              const si = document.getElementById('orderSearchInput');
              if (si) si.addEventListener('input', applyOrderFilters);
              document.addEventListener('tz:order:new', onTzOrderNew);

              window.__pageCleanup = function() {
                  document.removeEventListener('tz:order:new', onTzOrderNew);
                  if (typeof socket !== 'undefined' && socket) socket.off('auction:bid');
              };
          };
  ```

  Замени на:
  ```javascript
          function onAuctionClosed(data) {
              if (data.winnerCompany) {
                  showToast(`Аукцион завершён. Победитель: ${data.winnerCompany}`, 'info');
              } else {
                  showToast('Аукцион завершён без ставок', 'warn');
              }
              loadActiveAuctions();
          }

          window.addEventListener('DOMContentLoaded', () => {
              loadCompanyInfo();
              loadOrdersForProducers();
              initNotifications();
              initSidebarBadges();
              if (!isGuest) { loadMyProposals(); loadCrmStats(); loadActiveAuctions(); }
              document.getElementById('orderSearchInput').addEventListener('input', applyOrderFilters);
              document.addEventListener('tz:order:new', onTzOrderNew);
              if (typeof socket !== 'undefined' && socket) socket.off('auction:closed').on('auction:closed', onAuctionClosed);
          });

          window.__pageInit = function() {
              loadCompanyInfo();
              loadOrdersForProducers();
              initNotifications();
              initSidebarBadges();
              if (!isGuest) { loadMyProposals(); loadCrmStats(); loadActiveAuctions(); }
              const si = document.getElementById('orderSearchInput');
              if (si) si.addEventListener('input', applyOrderFilters);
              document.addEventListener('tz:order:new', onTzOrderNew);
              if (typeof socket !== 'undefined' && socket) socket.off('auction:closed').on('auction:closed', onAuctionClosed);

              window.__pageCleanup = function() {
                  document.removeEventListener('tz:order:new', onTzOrderNew);
                  if (typeof socket !== 'undefined' && socket) { socket.off('auction:bid'); socket.off('auction:closed'); }
              };
          };
  ```

  (Слушатель регистрируется один раз на уровне страницы, а не на каждый аукцион в списке — иначе `socket.off('auction:closed').on(...)` внутри цикла по списку аукционов оставлял бы рабочим только последний.)

- [ ] **Step 3: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 4: Ручная проверка**

  Повтори сценарий из Task 4 Step 4 с открытыми вкладками `index.html` (заказчик, панель заявки открыта) и `producer.html` (поставщик, вкладка «Аукционы») — оба должны получить toast при закрытии аукциона без перезагрузки страницы вручную.

- [ ] **Step 5: Commit**

  ```bash
  git add index.html producer.html
  git commit -m "feat: фронт реагирует на закрытие аукциона (toast + обновление списка)"
  ```

---

### Task 6: Итоговая проверка и обновление readme.txt

**Files:**
- Modify: `readme.txt` — разделы «ЧТО РЕАЛИЗОВАНО» (строка 565) и «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ»

**Interfaces:** —

- [ ] **Step 1: Полный прогон статических проверок**

  ```bash
  npm run check
  ```
  Ожидаемый результат: `Static checks passed: N HTML files, M inline scripts`

- [ ] **Step 2: Отметить пункт в readme.txt**

  Найди строку:
  ```
    [ ] Обратный аукцион для прямых закупок (reverse auction)
  ```
  Замени на:
  ```
    [x] Обратный аукцион для прямых закупок — авто-конвертация победившей ставки
        в сделку + уведомления (email/Telegram/колокольчик) при закрытии
  ```

- [ ] **Step 3: Добавить запись в «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ»**

  Вставь новый блок сразу после строки `================================================================================`
  перед первым существующим блоком «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ»:
  ```
    ПОСЛЕДНИЕ ОБНОВЛЕНИЯ (<дата запуска в прод> — завершение аукциона)
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
  ```

- [ ] **Step 4: Проверить**

  ```bash
  node --check db.js
  ```
  (readme.txt не проверяется линтером — просто визуально свериться, что блок не сломал форматирование остального файла)

- [ ] **Step 5: Commit**

  ```bash
  git add readme.txt
  git commit -m "docs: отметить аукцион завершённым в readme.txt"
  ```
