# ТехЗаказ — texzakaz.ru

B2B-платформа прямых закупок для нефтесервиса и промышленности: заказчик размещает
заявку с чертежом/ТЗ → заводы отвечают КП → сравнение, выбор, чат, договор,
трекинг поставки, отзыв. Без тендерной бюрократии и ЭЦП.

**Прод:** https://texzakaz.ru · **Стек:** Node.js/Express 5, PostgreSQL, Socket.io,
vanilla JS MPA (без сборщика).

## Быстрый старт (локально)

```bash
git clone https://github.com/Nolan6663/b2bneft.git
cd b2bneft
npm install
cp .env.example .env      # заполнить минимум: DATABASE_URL, JWT_SECRET
node server.js            # http://localhost:5000
```

Нужен PostgreSQL (локальный или облачный). Схема создаётся сама при старте
(`db.js` — `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
отдельных миграций нет). Прод-база на Render доступна **только с VPS** — локально
поднимай свою.

## Структура

```
server.js          — ядро: middleware, auth, socket.io, cron'ы, inline-роуты (см. ниже)
db.js              — схема БД (24 таблицы) + «миграции» ALTER TABLE
storage.js         — файлы: S3/R2 или локальный uploads/
export-pdf.js      — все PDF (заявки, КП, сравнение, договор+спецификация)
telegram-bot.js    — TG-бот (telegraf); с VPS нужен split-tunnel VPN, см. ARCHITECTURE
routes/            — auth, orders, proposals, companies, messages, deals
lib/               — ai-client (ТЗ/КП генерация), auth-tokens, proposal-accept,
                     registry-invites (авто-инвайты заводам), egrul-verify, company-enrich
scripts/           — pdf-smoke, static-checks, импорт реестра ГИСП (fetch-gisp-*, import-*)
assets/            — css (tokens.css — все переменные), js, шрифты (в т.ч. для PDF)
partials/          — общие куски HTML
*.html             — страницы (MPA): index=кабинет заказчика, producer=поставщика,
                     zakupki=публичные закупки, deals, delivery, messages, settings,
                     admin, map, catalog, login…
docs/              — ARCHITECTURE.md, спеки и планы фич (superpowers/), дизайн
tests/ + playwright.config.js — e2e (Playwright)
```

## Команды

```bash
npm start                  # запуск сервера
npm run check              # статические проверки (scripts/static-checks.js)
node scripts/pdf-smoke.js  # smoke PDF-генерации (шрифты/страницы/сумма прописью)
npm run smoke:api          # API-smoke (частично устарел: не учитывает email-верификацию)
npm run test:e2e           # Playwright e2e
```

## Деплой

**Пуш в `main` = автодеплой на прод.** GitHub Actions (`.github/workflows/deploy.yml`)
по SSH: `git reset --hard origin/main && npm install --production && pm2 restart neft`.

Правила:
- Фичи — в ветках, мерж в `main` только когда готово к проду.
- Изменил `.env` на VPS → `pm2 restart neft` (dotenv перечитается).
- Изменил `ecosystem.config.js` → **обязательно** `pm2 delete neft && pm2 start ecosystem.config.js`
  на VPS — plain restart кэшированный конфиг не перечитывает.
- `NODE_ENV=production` и `NODE_EXTRA_CA_CERTS` живут в `ecosystem.config.js`, не в `.env`.
- Перед ручными тестами на проде: `REGISTRY_INVITES_ENABLED=0` в `.env` VPS —
  иначе каждая тестовая закупка шлёт письма до 20 реальным заводам.

Проверка после деплоя: `curl https://texzakaz.ru/api/health` → `{"ok":true,"db":true,...}`.

## Документация

- `docs/ARCHITECTURE.md` — карта модулей, схема данных, потоки, инфраструктура, ловушки.
- `readme.txt` — подробный журнал разработки (API, схема, история изменений). Исторически
  главный документ; актуален, но длинный. Новичку начинать с README + ARCHITECTURE.
- `docs/superpowers/specs/` и `plans/` — спеки и планы реализованных фич.
