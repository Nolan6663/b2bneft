# Аукцион: авто-конвертация в сделку + уведомления о закрытии

Дата: 2026-07-01

## Контекст

Реверсивный аукцион (`auctions`, `auction_bids`) в основном реализован: создание
(customer), список активных + ставки (producer), реал-тайм ставки через Socket.io,
таймер, cron-закрытие по дедлайну, Telegram-напоминание за 10 мин до конца.

Две дыры мешают ему быть полноценной фичей:

1. **Итог аукциона нигде не всплывает.** `closeExpiredAuctions()` шлёт только
   socket-событие `auction:closed` в комнату `auction:{id}` — ни один фронт
   (`index.html`, `producer.html`) его не слушает. Email/Telegram/колокольчик
   не отправляются никому.
2. **Нет связки с остальным пайплайном.** Победившая ставка не превращается
   в `proposals`-строку — значит выигранный аукцион не попадает в «Сделки»,
   трекинг поставки, экспорт, отзывы.

## Решение

### 1. Срок поставки в ставке

`auction_bids` — новая колонка `days INTEGER NOT NULL DEFAULT 0`.
`POST /api/auctions/:id/bid` принимает `{ price, days }`, оба обязательны
(валидация как у price — `!days || isNaN(days) || days <= 0`).

`producer.html` bidModal (`#bidModal`) — добавить поле «Срок поставки (дн.)»
рядом с `#bidPriceInput`; `submitBid()` шлёт `days` вместе с `price`.

### 2. Авто-конвертация при закрытии

`auctions` — новая колонка `winner_proposal_id INTEGER REFERENCES proposals(id)`.

Логика accept (создание proposal со статусом `'Выигран'`, `orders.status =
'Закрыта'`, `delivery_events` INSERT, `order_events` лог, `triggerIntegrations`)
уже существует в `routes/proposals.js` (`POST /:proposalId/accept`, строки
~122-190) для ручного принятия обычного КП. Выносим общую часть (всё, что
идёт **после** того, как известны `orderRow` + победивший `{company, price,
days}`) в переиспользуемую функцию — вызывается и из ручного `/accept`, и из
`closeExpiredAuctions()`.

Новый `closeExpiredAuctions()`:

```
UPDATE auctions SET status='closed' WHERE status='active' AND end_time<=NOW()
  RETURNING id, order_id, winner_company, current_best;
```

Для каждой закрывшейся записи:

- **Есть победитель** (`winner_company` не null):
  1. `SELECT days FROM auction_bids WHERE auction_id=$1 AND company=$2 AND price=$3`
     (текущая лучшая ставка) → получить `days`.
  2. `INSERT INTO proposals (order_id, order_title, price, days, company, status,
     kp_file) VALUES (..., 'Выигран', NULL) RETURNING id`.
  3. Прогнать общую accept-логику (order → 'Закрыта', delivery_events,
     order_events, triggerIntegrations) с этим proposal и заявкой.
  4. `UPDATE auctions SET winner_proposal_id=$1 WHERE id=$2`.
  5. Уведомления победителю (колокольчик + email + Telegram) — «Вы выиграли
     аукцион «{title}», цена {price} ₽».
  6. Уведомление заказчику (колокольчик + email + Telegram) — «Аукцион «{title}»
     завершён. Победитель: {company}, {price} ₽».
  7. Проигравшие (`SELECT DISTINCT company FROM auction_bids WHERE auction_id=$1
     AND company != winner_company`) — только колокольчик, без email/Telegram:
     «Аукцион «{title}» завершён. Ваша ставка не победила.» Proposal-строка для
     них не создаётся.
  8. `emitRealtime` в комнаты победителя и заказчика (`dashboard:refresh`) +
     `io.to('auction:{id}').emit('auction:closed', {...})` как сейчас.

- **Нет ставок** (`winner_company` null): заказчику колокольчик + email —
  «Аукцион «{title}» завершён без ставок». Без Telegram. Proposal не создаётся,
  `orders.status` не меняется (заявка остаётся активной, заказчик может создать
  новый аукцион или ждать обычных КП).

### 3. Фронт слушает `auction:closed`

`index.html` и `producer.html` уже делают `socket.emit('join-auction', id)` при
открытии карточки/списка, но не подписаны на `auction:closed`. Добавить
обработчик: показать toast с итогом (выиграл/проиграл/без ставок — по данным
события) и перезагрузить список (`loadAuctionForOrder` / `loadActiveAuctions`),
чтобы UI не завис на «Завершён» без объяснения исхода.

## Не входит в эту итерацию

- Ручное досрочное принятие ставки заказчиком (аукцион всегда идёт до
  `end_time`).
- Proposal-записи для проигравших (история ставок остаётся только в
  `auction_bids`).
- Изменения в `docs/design/texzakaz-visual-identity.md` — новых UI-компонентов,
  кроме поля срока в bidModal и toast, не добавляется.

## Тестирование

Нет e2e-покрытия аукционов сейчас — проверка вручную:

1. Заказчик создаёт аукцион на заявку.
2. 2+ поставщика делают ставки с разным `price`/`days`.
3. Дождаться `end_time` (или временно сократить для теста) →
   `closeExpiredAuctions()` срабатывает по cron (раз в минуту).
4. Проверить: proposal создан со статусом `'Выигран'`, виден в deals.html у
   обеих сторон; email/Telegram/колокольчик пришли победителю и заказчику;
   колокольчик — проигравшим; `orders.status = 'Закрыта'`.
5. Отдельно проверить сценарий «без ставок».
6. `npm run check` перед деплоем.
