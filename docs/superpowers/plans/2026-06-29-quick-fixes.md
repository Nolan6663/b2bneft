# Quick Fixes + Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить 6 мелких проблем в server.js и README — пароль, rate limiting, email-логирование, кэш ассетов, join-auction, README.

**Architecture:** Все изменения в `server.js` и `README.txt`. Один PR, последовательные задачи.

**Tech Stack:** Node.js, Express, express-rate-limit (уже в зависимостях)

## Global Constraints

- Минимальная версия Node — та что на prod (см. ecosystem.config.js)
- `npm test` должен проходить после каждой задачи
- Не трогать authLimiter (уже настроен на /api/auth/login, register, forgot-password)
- Рабочая директория: `C:\Users\Админ\source\repos`

---

### Task 1: Унифицировать минимальную длину пароля

**Files:**
- Modify: `server.js` — эндпоинт `PUT /api/auth/password` (строка ~3516)

**Interfaces:**
- Produces: валидация `newPassword.length < 8` вместо `< 6`

- [ ] **Step 1: Найти текущую валидацию**

  Открой `server.js`, найди строку:
  ```javascript
  if (newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль — минимум 6 символов' });
  ```
  Она находится в `app.put('/api/auth/password', ...)`.

- [ ] **Step 2: Заменить валидацию**

  ```javascript
  if (newPassword.length < 8) return res.status(400).json({ error: 'Пароль — минимум 8 символов' });
  ```

- [ ] **Step 3: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 4: Commit**

  ```bash
  git add server.js
  git commit -m "fix: унифицировать минимальную длину пароля до 8 символов"
  ```

---

### Task 2: Rate limiting на /api/ роуты

**Files:**
- Modify: `server.js` — блок после authLimiter (~строка 232)

**Interfaces:**
- Produces: `generalLimiter` применён на `/api/`, `aiLimiter` на `POST /api/ai-search`

- [ ] **Step 1: Добавить generalLimiter после существующего authLimiter**

  Найди блок:
  ```javascript
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/forgot-password', authLimiter);
  ```

  Добавь сразу после него:
  ```javascript
  const generalLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Слишком много запросов. Подождите минуту.' }
  });
  app.use('/api/', generalLimiter);

  const aiLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Слишком много AI-запросов. Подождите минуту.' }
  });
  app.use('/api/ai-search', aiLimiter);
  ```

- [ ] **Step 2: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 3: Commit**

  ```bash
  git add server.js
  git commit -m "feat: добавить rate limiting на все /api/ роуты (60/мин) и /api/ai-search (5/мин)"
  ```

---

### Task 3: Логирование ошибок email

**Files:**
- Modify: `server.js` — 4 места с `.catch(() => {})`

**Interfaces:**
- Produces: все email-ошибки логируются в stderr через `console.error`

- [ ] **Step 1: Найти и заменить все fire-and-forget email catch**

  Найди и замени каждую из следующих строк:

  **Место 1** — `notifyCompanyEmail` вызов (строка ~769):
  ```javascript
  // было:
  await sendEmail(email, emailSubject, emailWrap(emailSubject, emailBodyHtml)).catch(() => {});
  // стало:
  await sendEmail(email, emailSubject, emailWrap(emailSubject, emailBodyHtml)).catch(e => console.error('[email:notify]', e.message));
  ```

  **Место 2** — дайджест daily (~строка 3958):
  ```javascript
  // было:
  buildDigestHtml(orders, p.company)).catch(() => {});
  // стало:
  buildDigestHtml(orders, p.company)).catch(e => console.error('[email:digest:daily]', e.message));
  ```

  **Место 3** — дайджест weekly (~строка 3979):
  ```javascript
  // было:
  buildDigestHtml(orders, p.company)).catch(() => {});
  // стало:
  buildDigestHtml(orders, p.company)).catch(e => console.error('[email:digest:weekly]', e.message));
  ```

  **Место 4** — сообщения в чате, блок `catch {}` (~строка 3366):
  ```javascript
  // было:
  } catch {}
  // стало:
  } catch (e) { console.error('[email:chat]', e.message); }
  ```
  *(Это внутри fire-and-forget async IIFE в `POST /api/messages`)*

- [ ] **Step 2: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 3: Commit**

  ```bash
  git add server.js
  git commit -m "fix: логировать ошибки отправки email вместо молчаливого игнорирования"
  ```

---

### Task 4: Исправить README.txt

**Files:**
- Modify: `README.txt` — раздел «ЧТО НЕ РЕАЛИЗОВАНО / В ПЛАНАХ»

- [ ] **Step 1: Удалить строку про landing-hero.png**

  Найди в `README.txt`:
  ```
    [ ] .env.example, landing-hero.png (og:image), чистка legacy SVG/docs
  ```
  Замени на:
  ```
    [ ] .env.example, чистка legacy SVG/docs
  ```

- [ ] **Step 2: Обновить дату внизу файла**

  Найди строку вида:
  ```
  Обновлено: 23.06.2026 — ...
  ```
  Замени на:
  ```
  Обновлено: 29.06.2026 — quick fixes: rate limit, password, email logging, cache headers
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add README.txt
  git commit -m "docs: убрать landing-hero.png из списка незавершённого (файл есть), обновить дату"
  ```

---

### Task 5: Socket.io join-auction — явный no-op

**Files:**
- Modify: `server.js` — хэндлер `join-auction` (~строка 269)

- [ ] **Step 1: Заменить хэндлер**

  Найди:
  ```javascript
  socket.on('join-auction', (auctionId) => {
      if (auctionId) socket.join(`auction:${auctionId}`);
  });
  socket.on('leave-auction', (auctionId) => {
      if (auctionId) socket.leave(`auction:${auctionId}`);
  });
  ```

  Замени на:
  ```javascript
  // TODO: проверить доступ к аукциону когда auctions будут реализованы
  socket.on('join-auction', () => {});
  socket.on('leave-auction', () => {});
  ```

- [ ] **Step 2: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 3: Commit**

  ```bash
  git add server.js
  git commit -m "fix: join-auction сделать no-op до реализации функции аукционов"
  ```

---

### Task 6: Кэш-заголовки CSS/JS — no-cache

**Files:**
- Modify: `server.js` — middleware `app.use('/assets', express.static(...))` (~строка 364)

- [ ] **Step 1: Найти текущий setHeaders**

  Найди блок:
  ```javascript
  app.use('/assets', express.static(path.join(__dirname, 'assets'), {
      setHeaders(res, filePath) {
          if (/\.(woff2|woff|ttf|otf)$/.test(filePath)) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (/\.(png|jpg|jpeg|webp|gif|svg|ico)$/.test(filePath)) {
              res.setHeader('Cache-Control', 'public, max-age=604800');
          } else if (/\.(css|js)$/.test(filePath)) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
      }
  }));
  ```

- [ ] **Step 2: Поменять кэш для CSS/JS**

  ```javascript
  app.use('/assets', express.static(path.join(__dirname, 'assets'), {
      setHeaders(res, filePath) {
          if (/\.(woff2|woff|ttf|otf)$/.test(filePath)) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (/\.(png|jpg|jpeg|webp|gif|svg|ico)$/.test(filePath)) {
              res.setHeader('Cache-Control', 'public, max-age=604800');
          } else if (/\.(css|js)$/.test(filePath)) {
              res.setHeader('Cache-Control', 'no-cache');
          }
      }
  }));
  ```

- [ ] **Step 3: Проверить**

  ```bash
  npm test
  ```
  Ожидаемый результат: `Static checks passed: ...`

- [ ] **Step 4: Ручная проверка (если сервер запущен)**

  ```bash
  curl -I http://localhost:5000/assets/app.js
  ```
  Ожидаемый результат: заголовок `Cache-Control: no-cache`

- [ ] **Step 5: Commit**

  ```bash
  git add server.js
  git commit -m "fix: заменить immutable кэш CSS/JS на no-cache для корректного обновления после деплоя"
  ```

---

### Task 7: Push to main

- [ ] **Step 1: Финальная проверка**

  ```bash
  npm test
  ```

- [ ] **Step 2: Push**

  ```bash
  git push origin main
  ```
