# SPA-роутер (сайдбар без дёрганья) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить дёрганье сайдбара при переходах между страницами: сайдбар рендерится один раз, только `<main>` меняется при навигации.

**Architecture:** SPA-роутер в `assets/app.js` (~150 строк). Каждая страница оборачивает свой контент в `<main id="spa-content">`, page-specific скрипты объявляют `window.__pageInit`. Роутер перехватывает клики по ссылкам в сайдбаре, загружает контент через fetch, подменяет `#spa-content`, запускает `__pageInit`.

**Tech Stack:** Vanilla JS, History API (pushState/popstate), DOMParser, fetch

## Global Constraints

- Рабочая директория: `C:\Users\Админ\source\repos`
- `npm test` должен проходить после каждой задачи (включая checkInlineScripts)
- Прямые URL, F5, открытие в новой вкладке — работают как раньше
- `login.html` — исключить из SPA-навигации (всегда полная перезагрузка)
- Не использовать eval() — использовать new Function(code)()
- Socket.io соединение переиспользуется между страницами (не пересоздавать)

---

### Task 1: Добавить SPA-роутер в assets/app.js

**Files:**
- Modify: `assets/app.js`

**Interfaces:**
- Produces:
  - `initSpaRouter()` — инициализирует роутер, вызывается в DOMContentLoaded
  - `window.__spaNavigate(url)` — публичный API для программной навигации
  - Ожидает что страницы имеют `<main id="spa-content">` и `window.__pageInit`

- [ ] **Step 1: Добавить SPA-роутер в конец assets/app.js**

  ```javascript
  /* ---------------------------------------------------------
     SPA-роутер: подменяет только #spa-content при навигации,
     сайдбар остаётся нетронутым.
  --------------------------------------------------------- */
  const SPA_EXCLUDE = ['/login', '/login.html'];

  function isSpaUrl(url) {
      try {
          const u = new URL(url, location.origin);
          if (u.origin !== location.origin) return false;
          if (SPA_EXCLUDE.some(p => u.pathname === p || u.pathname === p.replace('.html', ''))) return false;
          // Только HTML-страницы (без /api/, /uploads/, /assets/)
          if (/\/(api|uploads|assets)\//.test(u.pathname)) return false;
          return true;
      } catch { return false; }
  }

  async function spaNavigate(url) {
      const target = new URL(url, location.origin);

      // Cleanup текущей страницы
      if (typeof window.__pageCleanup === 'function') {
          try { window.__pageCleanup(); } catch {}
          window.__pageCleanup = null;
      }
      window.__pageInit = null;

      let html;
      try {
          const res = await fetch(target.href, { credentials: 'include' });
          if (!res.ok) { location.href = url; return; }
          html = await res.text();
      } catch {
          location.href = url;
          return;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const newContent = doc.getElementById('spa-content');
      const currentContent = document.getElementById('spa-content');
      if (!newContent || !currentContent) {
          // Страница не поддерживает SPA — полная загрузка
          location.href = url;
          return;
      }

      currentContent.innerHTML = newContent.innerHTML;
      document.title = doc.title || document.title;
      history.pushState({ spaUrl: url }, '', target.pathname + target.search);

      // Обновить активный пункт сайдбара
      document.querySelectorAll('.sidebar a, .nav a, aside a').forEach(a => {
          a.classList.toggle('active', a.pathname === target.pathname);
      });

      // Выполнить page-specific скрипты из нового документа
      const scripts = doc.querySelectorAll('script:not([src])');
      for (const script of scripts) {
          const code = script.textContent || '';
          if (!code.includes('__pageInit') && !code.includes('__pageCleanup')) continue;
          try { new Function(code)(); } catch (e) { console.error('[spa] script error:', e); }
      }

      if (typeof window.__pageInit === 'function') {
          try { window.__pageInit(); } catch (e) { console.error('[spa] pageInit error:', e); }
      }
  }

  window.__spaNavigate = spaNavigate;

  function initSpaRouter() {
      // Перехват кликов
      document.addEventListener('click', (e) => {
          const a = e.target.closest('a[href]');
          if (!a) return;
          const href = a.getAttribute('href');
          if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
          if (e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank') return;
          if (!isSpaUrl(href)) return;
          // Только если клик внутри сайдбара/навигации
          const inNav = a.closest('aside, .sidebar, nav, .nav');
          if (!inNav) return;
          e.preventDefault();
          spaNavigate(href);
      });

      // Кнопка "Назад"
      window.addEventListener('popstate', (e) => {
          if (e.state?.spaUrl || document.getElementById('spa-content')) {
              spaNavigate(location.pathname + location.search);
          }
      });
  }

  // Инициализация (добавить вызов в существующий DOMContentLoaded)
  // initSpaRouter() вызывается внизу этого файла
  ```

- [ ] **Step 2: Добавить вызов initSpaRouter() в DOMContentLoaded**

  Найди в `app.js` существующий блок:
  ```javascript
  document.addEventListener('DOMContentLoaded', () => {
    applyStoredTheme();
    initSidebarRole();
    // ...
  });
  ```
  Добавь `initSpaRouter();` в конец этого блока.

- [ ] **Step 3: Проверить синтаксис**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 4: Commit**

  ```bash
  git add assets/app.js
  git commit -m "feat: добавить SPA-роутер в app.js (перехват навигации, подмена #spa-content)"
  ```

---

### Task 2: Обновить HTML-страницы — обернуть контент в #spa-content

**Files:**
- Modify: все HTML файлы в корне (кроме `login.html`)

Список файлов для обновления:
`index.html`, `producer.html`, `messages.html`, `deals.html`, `analytics.html`,
`catalog.html`, `company-profile.html`, `delivery.html`, `deliveries.html`,
`zakupki.html`, `map.html`, `favorites.html`, `proposals.html`, `partners.html`,
`landing.html`, `dlya-postavshchikov.html`, `admin.html`, `tariff.html`,
`settings.html`, `404.html`

**Interfaces:**
- Consumes: роутер из Task 1 ищет `#spa-content`
- Produces: каждая страница имеет `<main id="spa-content">...</main>` и `window.__pageInit`

- [ ] **Step 1: Понять текущую структуру**

  Открой `index.html`. Найди тег `<main>` — он может выглядеть как `<main class="main-content">` или просто `<main>`. Именно его нужно превратить в `<main id="spa-content" class="main-content">`.

- [ ] **Step 2: Обновить index.html**

  1. Найди тег `<main` и добавь `id="spa-content"` если его нет.
  2. Найди последний `<script>` без `src` в `<body>`. Оберни весь его код в функцию:

  ```javascript
  // БЫЛО:
  <script>
  // ... весь page-specific код
  loadOrders();
  initChat();
  // ...
  </script>

  // СТАЛО:
  <script>
  window.__pageInit = function() {
    // ... весь page-specific код (без изменений внутри)
    loadOrders();
    initChat();
    // ...
  };
  window.__pageInit(); // запустить при прямом открытии страницы
  </script>
  ```

- [ ] **Step 3: Повторить для всех остальных страниц**

  Применить ту же трансформацию к каждому файлу из списка выше:
  - `producer.html` → `<main id="spa-content">`, `window.__pageInit`
  - `messages.html` → то же
  - `deals.html` → то же
  - `analytics.html` → то же
  - `catalog.html` → то же
  - `company-profile.html` → то же
  - `delivery.html` → то же
  - `deliveries.html` → то же
  - `zakupki.html` → то же
  - `map.html` → то же
  - `favorites.html` → то же
  - `proposals.html` → то же
  - `partners.html` → то же
  - `landing.html` → то же
  - `dlya-postavshchikov.html` → то же
  - `admin.html` → то же
  - `tariff.html` → то же
  - `settings.html` → то же
  - `404.html` → то же

  > Примечание: если у страницы нет `<main>` — оберни весь контент `<body>` (кроме `<aside>` и `<script src=...>`) в `<main id="spa-content">`.

- [ ] **Step 4: Проверить все страницы**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: X HTML files, Y inline scripts`

  > Если падает `checkInlineScripts` — ошибка синтаксиса в каком-то inline скрипте. npm test покажет файл.

- [ ] **Step 5: Commit**

  ```bash
  git add *.html
  git commit -m "feat: обернуть контент всех страниц в #spa-content, page-specific код в __pageInit"
  ```

---

### Task 3: Обработка страниц с Socket.io соединением

**Files:**
- Modify: `messages.html`, `index.html`, `producer.html` — страницы где инициализируется Socket.io

**Interfaces:**
- Consumes: SPA-роутер из Task 1, `window.__pageCleanup`
- Produces: Socket.io корректно отписывается при уходе со страницы

- [ ] **Step 1: Для каждой страницы с Socket.io — добавить __pageCleanup**

  На страницах где есть `socket.on(...)` или `io(...)`, добавь в `__pageInit`:
  ```javascript
  window.__pageInit = function() {
      // ... существующий код

      // Cleanup при уходе со страницы (SPA)
      window.__pageCleanup = function() {
          if (socket) {
              socket.off(); // снять все обработчики
              socket.emit('leave-company'); // если такой event есть
          }
      };
  };
  ```

  > Если `socket` создаётся внутри `__pageInit`, он создастся заново при SPA-навигации — это правильно. Глобальный socket (из app.js) трогать не нужно.

- [ ] **Step 2: Проверить**

  ```bash
  npm test
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add messages.html index.html producer.html
  git commit -m "feat: добавить __pageCleanup для Socket.io страниц при SPA-навигации"
  ```

---

### Task 4: Тестирование навигации

- [ ] **Step 1: Запустить сервер**

  ```bash
  node server.js
  ```
  (Нужна настроенная БД или mock-режим)

- [ ] **Step 2: Проверить переходы**

  Открой `http://localhost:5000` в браузере. Проверь:
  - Клик по каждому пункту сайдбара → сайдбар НЕ мигает
  - URL меняется в адресной строке
  - Кнопка «Назад» браузера работает
  - F5 на любой странице — страница загружается корректно
  - Открытие любого URL напрямую — работает

- [ ] **Step 3: Проверить консоль на ошибки**

  В DevTools → Console не должно быть красных ошибок при переходах.

- [ ] **Step 4: Commit финального состояния и push**

  ```bash
  npm test
  git push origin main
  ```
