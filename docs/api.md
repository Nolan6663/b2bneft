# API Reference — B2B Нефтесервис

Base URL: `https://<render-host>/api`  
Auth: `Authorization: Bearer <JWT>`

## Легенда

| Иконка | Значение |
|--------|---------|
| 🔓 | Публичный (без токена) |
| 🔐 | Требует авторизации |
| 👤 | Только `customer` |
| 🏭 | Только `producer` |
| 🛡️ | Только `admin` |
| 〰️ | Токен опциональный (guest-режим) |

---

## Auth

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| POST | `/auth/register` | 🔓 | Регистрация. Body: `{email, password≥8, company, role}` |
| POST | `/auth/login` | 🔓 | Логин → `{token, refreshToken, role, company}` |
| POST | `/auth/refresh` | 🔓 | Обновление access-токена через refreshToken |
| POST | `/auth/logout` | 🔐 | Инвалидация refreshToken |
| GET  | `/auth/me` | 🔐 | Текущий пользователь |
| PUT  | `/auth/password` | 🔐 | Смена пароля `{current, newPassword≥8}` |
| PUT  | `/auth/email` | 🔐 | Смена email `{email, password}` |
| POST | `/auth/forgot-password` | 🔓 | Письмо со ссылкой сброса |
| POST | `/auth/reset-password` | 🔓 | Сброс пароля `{token, newPassword}` |

Rate-limit на login/register/forgot-password: **15 запросов / 15 минут**.

---

## Orders

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/orders` | 🔐 | Список заявок. Для customer — свои; для producer — все активные |
| POST | `/orders` | 👤 | Создать заявку. Multipart: `{title, category, deadline, quantity, description}` + файл `drawing` |
| PUT | `/orders/:id` | 👤 | Обновить заявку (только свою) |
| POST | `/orders/:id/cancel` | 👤 | Отменить заявку |
| GET | `/orders/:id/drawing` | 🔐 | Скачать чертёж |
| GET | `/orders/match-scores` | 🏭 | Баллы совпадения текущего производителя со всеми активными заявками |

---

## Proposals (КП)

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/proposals` | 🏭 | Свои КП производителя |
| POST | `/proposals` | 🏭 | Подать КП. Multipart: `{orderId, price, days}` + файл `kpFile` |
| PUT | `/proposals/:id` | 🏭 | Обновить КП (только в статусе «Ожидает») |
| DELETE | `/proposals/:id` | 🏭 | Отозвать КП |
| GET | `/proposals/:id/file` | 🔐 | Скачать файл КП |
| GET | `/order-proposals/:orderId` | 👤 | Все КП на заявку заказчика |
| POST | `/proposals/:id/accept` | 👤 | Принять КП → закрывает заявку, создаёт этапы доставки |
| POST | `/proposals/:id/reject` | 👤 | Отклонить КП `{reason?}` |

---

## Deals & Delivery

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/deals` | 🔐 | Активные сделки (принятые КП). Обе стороны видят свои |
| PUT | `/deals/:proposalId/complete` | 👤 | Завершить сделку |
| GET | `/deals/:proposalId/delivery` | 🔐 | Этапы доставки |
| POST | `/deals/:proposalId/delivery/stage` | 🔐 | Перевести этап `{stage}` в следующий статус |

Этапы: `Согласование → Производство → Отгрузка → Доставлено`

---

## Companies

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/companies` | 〰️ | Все компании. С токеном — добавляет `isFavorite`, enriched-данные |
| GET | `/companies/:id` | 〰️ | Профиль одной компании |
| PUT | `/companies/:id` | 🔐 | Редактировать профиль (только своей компании) |
| POST | `/companies/:id/photos` | 🔐 | Загрузить фото (multipart, `photo` field) |
| DELETE | `/companies/:id/photos/:photoId` | 🔐 | Удалить фото |

---

## Catalog

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/catalog` | 🔐 | Каталог производителей с фильтрами `?category=&city=&search=&minRating=` |
| GET | `/capacity` | 〰️ | Свободные производственные мощности |

---

## Map

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/map` | 〰️ | Точки производителей для карты `?category=&minCapacity=` |
| GET | `/config/maps` | 🔓 | API-ключ для карт (если используется платный провайдер) |

---

## Messages

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/messages/conversations` | 🔐 | Все чаты текущего пользователя |
| GET | `/messages/:orderId/:company` | 🔐 | История переписки по сделке |
| POST | `/messages` | 🔐 | Отправить сообщение `{orderId, company, text}` |
| POST | `/messages/:orderId/:company/read` | 🔐 | Отметить прочитанными |

---

## Notifications

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/notifications/:company` | 🔐 | Список уведомлений компании |
| POST | `/notifications/:company/read` | 🔐 | Прочитать все |
| DELETE | `/notifications/:company` | 🔐 | Удалить все |

---

## Favorites

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/favorites` | 🔐 | Избранные компании |
| POST | `/favorites` | 🔐 | Добавить `{companyId}` |
| DELETE | `/favorites/:companyId` | 🔐 | Удалить |

---

## Analytics & Dashboard

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/dashboard/counts` | 🔐 | Счётчики для сайдбара (заявки, КП, сообщения) |
| GET | `/customer/analytics` | 👤 | Аналитика заказчика: воронка, топ категорий, динамика |
| GET | `/producer/crm-stats` | 🏭 | CRM-воронка производителя: заявки, КП, победы |
| GET | `/public/stats` | 🔓 | Публичная статистика для лендинга |

---

## Verification

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| POST | `/verification/request` | 🔐 | Подать заявку на верификацию |
| GET | `/verification/status` | 🔐 | Статус своей заявки |
| GET | `/verification/requests` | 🛡️ | Все заявки (для админа) |
| POST | `/verification/:id/approve` | 🛡️ | Одобрить |
| POST | `/verification/:id/reject` | 🛡️ | Отклонить `{reason}` |

---

## System

| Метод | Путь | Доступ | Описание |
|-------|------|--------|---------|
| GET | `/health` | 🔓 | `{ok, db, uptime, env}` |

---

## WebSocket Events

Подключение: `wss://<host>` (Socket.IO)

### Клиент → Сервер

| Событие | Payload | Описание |
|---------|---------|---------|
| `join-company` | `companyName: string` | Подписаться на уведомления компании |
| `join-chat` | `{orderId, company}` | Войти в комнату чата |

### Сервер → Клиент

| Событие | Payload | Комната | Описание |
|---------|---------|---------|---------|
| `notification` | `{id, company, text, read, createdAt}` | `companyName` | Push-уведомление |
| `message` | `{id, orderId, company, sender, text, read, createdAt}` | `chat:orderId:company` | Новое сообщение в чате |

---

## Коды ошибок

| HTTP | Описание |
|------|---------|
| 400 | Невалидные данные (роль, длина пароля, тип файла) |
| 401 | Отсутствует или истёк токен |
| 403 | Недостаточно прав (чужой ресурс или неверная роль) |
| 404 | Ресурс не найден |
| 409 | Конфликт (дублирующийся email) |
| 429 | Rate limit exceeded |
| 500 | Внутренняя ошибка сервера |
| 503 | База данных недоступна |
