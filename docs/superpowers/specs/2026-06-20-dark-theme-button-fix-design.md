# Dark Theme Fix + Button Alignment — Design Spec
Date: 2026-06-20

## Problem
1. `deals.html`: кнопки «Экспорт» и «Создать заказ» вертикально не выровнены — у `.orders-actions` нет `align-items: center`.
2. Тёмная тема: несколько страниц используют `background:#fff` / `background:white` в page-level CSS и inline стилях, игнорируя CSS-переменную `--card-bg`. Особенно видно на `messages.html` — белый чат поверх тёмного фона.

## Scope
- Все 16 HTML-страниц проекта
- Файл `assets/theme-v2.css` (если найдены общие проблемы)

## What We Change

### 1. Button alignment (deals.html)
`.orders-actions` → добавить `align-items: center`

### 2. Dark theme — hardcoded backgrounds
Grep по `#fff`, `#ffffff`, `white` внутри `<style>` блоков и `style=` атрибутов.
Заменяем:
- Фон панелей/карточек → `var(--card-bg)`
- Основной фон страницы → `var(--bg-primary)`
- Вложенные блоки → `var(--inner-bg)`

### 3. What we keep
- `color: #fff` на кнопках/аватарах с цветным фоном — корректно в обеих темах
- Градиентные акценты — не трогаем
- Цвета в SVG/графиках — не трогаем

## Success Criteria
- В тёмной теме все панели, карточки, чат-область имеют тёмный фон
- Кнопки «Экспорт» и «Создать заказ» выровнены по вертикальной оси
- Светлая тема не сломана
