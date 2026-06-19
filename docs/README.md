# Документация B2B Нефтесервис

## Навигация

| Документ | Описание |
|---------|---------|
| [architecture.md](./architecture.md) | C4 диаграммы (Context → Container → Component), стек, trade-offs |
| [data-model.md](./data-model.md) | ER-диаграмма, таблицы БД, бизнес-правила, жизненные циклы |
| [sequences.md](./sequences.md) | Sequence-диаграммы: auth, заявка→КП→сделка, чат, файлы, верификация |
| [api.md](./api.md) | Полный REST API reference + WebSocket events |
| [roadmap.md](./roadmap.md) | Технический долг, приоритеты, архитектура при масштабировании |

## Быстрый старт для разработчика

```bash
# 1. Установить зависимости
npm install

# 2. Настроить переменные окружения (.env)
DATABASE_URL=postgresql://...
JWT_SECRET=...
RESEND_API_KEY=...
ALLOWED_ORIGINS=http://localhost:5000

# 3. Запустить
node server.js
# → http://localhost:5000
```

## Структура проекта

```
/
├── server.js              # Express API + Socket.IO (единственный backend-файл)
├── package.json
├── uploads/               # Загружаемые файлы (чертежи, КП, фото)
│   └── photos/
├── assets/
│   ├── theme-v2.css       # Дизайн-система (CSS-переменные, компоненты)
│   ├── app.js             # Общий JS (auth, sidebar, toast, theme)
│   ├── ui-animations.js   # Анимации: custom select, ripple, skeleton, stagger
│   └── icons_svg/
├── docs/                  # ← вы здесь
│   ├── architecture.md
│   ├── data-model.md
│   ├── sequences.md
│   ├── api.md
│   └── roadmap.md
└── *.html                 # 18 страниц фронтенда
    ├── landing.html
    ├── index.html          # Кабинет заказчика
    ├── producer.html       # Кабинет производителя
    ├── catalog.html        # Каталог производителей
    ├── map.html            # Карта производств
    ├── deals.html          # Сделки
    ├── deliveries.html     # Доставки
    ├── proposals.html      # Мои отклики (производитель)
    ├── partners.html       # Контрагенты
    ├── analytics.html      # Аналитика
    ├── messages.html       # Сообщения
    ├── favorites.html      # Избранное
    ├── company-profile.html
    ├── settings.html
    ├── tariff.html
    ├── admin.html
    ├── login.html
    └── delivery.html       # Детали доставки
```

## Роли пользователей

| Роль | Может | Не может |
|------|-------|---------|
| `customer` | Создавать заявки, принимать/отклонять КП, видеть каталог | Подавать КП |
| `producer` | Подавать КП, видеть все активные заявки, вести профиль | Создавать заявки |
| `admin` | Верифицировать компании | (нет ограничений на просмотр) |

> Диаграммы используют синтаксис [Mermaid](https://mermaid.js.org/) — рендерятся нативно на GitHub и в VS Code с расширением Markdown Preview Mermaid Support.
