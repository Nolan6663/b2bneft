# Sequence Diagrams — B2B Нефтесервис

## 1. Регистрация и авторизация

```mermaid
sequenceDiagram
    autonumber
    actor U as Пользователь
    participant FE as Frontend
    participant BE as Express API
    participant DB as PostgreSQL
    participant Mail as Resend

    U->>FE: Заполняет форму регистрации
    FE->>BE: POST /api/auth/register {email, password, company, role}
    BE->>BE: Валидация роли (только customer|producer)
    BE->>BE: Проверка password.length ≥ 8
    BE->>DB: SELECT email FROM users WHERE email = ?
    DB-->>BE: (пусто)
    BE->>BE: scrypt(password, salt) → hash
    BE->>DB: INSERT INTO users + INSERT INTO companies
    DB-->>BE: {id, company, role}
    BE->>BE: jwt.sign({userId, company, role}, 15m)
    BE-->>FE: {token, refreshToken, role, company}
    FE->>FE: localStorage.setItem('token', ...)
    FE->>FE: Redirect → producer.html / index.html

    Note over U,Mail: Логин (уже есть аккаунт)
    U->>FE: email + password
    FE->>BE: POST /api/auth/login
    BE->>DB: SELECT * FROM users WHERE email = ?
    DB-->>BE: {id, password_hash, role, company}
    BE->>BE: scrypt(input) === stored_hash (timingSafeEqual)
    BE->>BE: jwt.sign() access 15m + refresh 7d
    BE->>DB: UPDATE users SET refresh_token = ?
    BE-->>FE: {token, refreshToken, ...}

    Note over FE,BE: Автообновление токена
    FE->>BE: POST /api/auth/refresh {refreshToken}
    BE->>DB: SELECT * FROM users WHERE refresh_token = ?
    DB-->>BE: user
    BE->>BE: jwt.sign() новый access токен
    BE-->>FE: {token}
```

---

## 2. Сброс пароля

```mermaid
sequenceDiagram
    autonumber
    actor U as Пользователь
    participant FE as Frontend
    participant BE as Express API
    participant DB as PostgreSQL
    participant Mail as Resend

    U->>FE: Вводит email на странице forgot-password
    FE->>BE: POST /api/auth/forgot-password {email}
    BE->>DB: SELECT * FROM users WHERE email = ?
    DB-->>BE: user (или null)
    BE->>BE: crypto.randomBytes(32) → resetToken
    BE->>BE: resetToken expires в 1 час
    BE->>DB: UPDATE users SET reset_token, reset_expires
    BE->>Mail: Resend.send({to: email, subject: "Сброс пароля", html: link})
    Mail-->>BE: {id}
    BE-->>FE: {ok: true} (всегда, не раскрывает наличие email)

    U->>FE: Переходит по ссылке из письма
    FE->>BE: POST /api/auth/reset-password {token, newPassword}
    BE->>DB: SELECT * FROM users WHERE reset_token = ? AND reset_expires > NOW()
    DB-->>BE: user
    BE->>BE: password.length ≥ 8
    BE->>BE: scrypt(newPassword)
    BE->>DB: UPDATE users SET password = ?, reset_token = NULL
    BE-->>FE: {ok: true}
    FE->>FE: Redirect → login.html
```

---

## 3. Основной бизнес-флоу: Заявка → КП → Сделка

```mermaid
sequenceDiagram
    autonumber
    actor C as Заказчик
    actor P as Производитель
    participant FE as Frontend
    participant BE as Express API
    participant DB as PostgreSQL
    participant WS as Socket.IO
    participant Mail as Resend

    Note over C,Mail: === Создание заявки ===
    C->>FE: Форма новой закупки + чертёж
    FE->>BE: POST /api/orders (multipart/form-data)
    BE->>BE: requireAuth + requireRole('customer')
    BE->>BE: Multer: validate ext + MIME, save to /uploads/
    BE->>DB: INSERT INTO orders {title, category, deadline, ...}
    DB-->>BE: order.id
    BE-->>FE: {id, title, status: 'Активна'}

    Note over C,Mail: === Smart Matching ===
    BE->>DB: SELECT * FROM companies WHERE role='producer'
    DB-->>BE: все производители
    BE->>BE: computeMatchScore(order, producer) × N
    Note right of BE: score = keyword_match×20 + title_words×15 + capacity_bonus×10

    Note over C,Mail: === Производитель подаёт КП ===
    P->>FE: Открывает producer.html, видит заявку
    P->>FE: Форма КП: цена, срок, КП-файл
    FE->>BE: POST /api/proposals (multipart/form-data)
    BE->>BE: requireRole('producer')
    BE->>DB: INSERT INTO proposals {order_id, price, days, company, ...}
    BE->>DB: UPDATE orders SET responses = responses + 1
    DB-->>BE: proposal
    BE->>DB: SELECT email FROM users WHERE company = order.company
    BE->>Mail: "Новое КП на вашу заявку «{title}»"
    BE-->>FE: proposal

    Note over C,Mail: === Заказчик принимает КП ===
    C->>FE: Список КП, кнопка «Принять»
    FE->>BE: POST /api/proposals/:id/accept
    BE->>BE: requireRole('customer') + проверка владельца заявки
    BE->>DB: BEGIN TRANSACTION
    BE->>DB: UPDATE proposals SET status='Выигран' WHERE id=?
    BE->>DB: UPDATE proposals SET status='Отклонен' WHERE order_id=? AND id!=?
    BE->>DB: UPDATE orders SET status='Закрыта'
    BE->>DB: INSERT delivery_stages (Согласование, Производство, Отгрузка, Доставлено)
    BE->>DB: COMMIT
    BE->>DB: addNotification(producer.company, "Ваше КП принято!")
    WS-->>P: emit('notification', {...})
    BE->>Mail: "Поздравляем! Ваше КП на «{title}» принято"
    BE->>Mail: "Закупка «{title}» закрыта (победитель выбран)"
    BE-->>FE: {ok: true}
    FE->>FE: Обновляет UI заявки

    Note over C,Mail: === Этапы сделки ===
    C->>FE: deals.html → кнопка «Следующий этап»
    FE->>BE: POST /api/deals/:proposalId/delivery/stage {stage}
    BE->>DB: UPDATE delivery_stages SET status='done' WHERE proposal_id=? AND stage=?
    DB-->>BE: ok
    BE->>DB: addNotification(другой стороне, "Этап обновлён")
    WS-->>P: emit('notification', {...})
    BE-->>FE: {ok: true}
```

---

## 4. Реальное время: Чат между заказчиком и производителем

```mermaid
sequenceDiagram
    autonumber
    actor C as Заказчик
    actor P as Производитель
    participant WS as Socket.IO

    Note over C,WS: Оба открывают чат по orderId
    C->>WS: connect()
    C->>WS: emit('join-company', 'ООО Заказчик')
    C->>WS: emit('join-chat', {orderId: 42, company: 'ООО Производитель'})

    P->>WS: connect()
    P->>WS: emit('join-company', 'ООО Производитель')
    P->>WS: emit('join-chat', {orderId: 42, company: 'ООО Производитель'})

    Note over C,WS: Производитель пишет сообщение
    P->>+BE: POST /api/messages {orderId: 42, company: 'ООО Производитель', text: '...'}
    BE->>BE: canAccessOrderThread() — проверка прав
    BE->>DB: INSERT INTO messages
    DB-->>BE: message
    BE->>WS: io.to('chat:42:ООО Производитель').emit('message', msg)
    WS-->>C: on('message', msg)  ← мгновенно
    BE-->>P: {ok: true}
    deactivate BE

    Note over C,WS: Отметка о прочтении
    C->>BE: POST /api/messages/42/ООО Производитель/read
    BE->>DB: UPDATE messages SET read=true WHERE order_id=? AND company=? AND sender != currentUser
    BE-->>C: {ok: true}
```

---

## 5. Верификация компании

```mermaid
sequenceDiagram
    autonumber
    actor P as Производитель
    actor A as Администратор
    participant BE as Express API
    participant DB as PostgreSQL
    participant Mail as Resend

    P->>BE: POST /api/verification/request {documents}
    BE->>BE: requireAuth
    BE->>DB: INSERT INTO verification_requests {company, role, documents, status:'pending'}
    BE-->>P: {ok: true}

    A->>BE: GET /api/verification/requests
    BE->>BE: requireRole('admin')
    DB-->>BE: [{company, role, documents, status}, ...]
    BE-->>A: список заявок

    alt Одобрение
        A->>BE: POST /api/verification/:id/approve
        BE->>DB: UPDATE verification_requests SET status='approved'
        BE->>DB: UPDATE companies SET verified_by_platform=true, status='Верифицирован'
        BE->>DB: SELECT email FROM users WHERE company=?
        BE->>Mail: "Ваша компания верифицирована"
        BE-->>A: {ok: true}
    else Отклонение
        A->>BE: POST /api/verification/:id/reject {reason}
        BE->>DB: UPDATE verification_requests SET status='rejected'
        BE->>DB: UPDATE companies SET status='Отклонён'
        BE->>Mail: "В верификации отказано: {reason}"
        BE-->>A: {ok: true}
    end

    P->>BE: GET /api/verification/status
    DB-->>BE: {status: 'approved', verifiedByPlatform: true}
    BE-->>P: статус верификации
```

---

## 6. Загрузка и доступ к файлам

```mermaid
sequenceDiagram
    autonumber
    actor U as Пользователь
    participant BE as Express API
    participant Multer as Multer middleware
    participant FS as Filesystem

    Note over U,FS: Загрузка чертежа
    U->>BE: POST /api/orders (multipart, drawing field)
    BE->>Multer: fileFilter callback
    Multer->>Multer: Проверка расширения (.pdf, .dxf, .dwg, .step, ...)
    Multer->>Multer: Проверка MIME (блокировка .exe, .sh, .bat)
    Multer->>FS: Сохранить как {uuid}.{ext} в /uploads/
    FS-->>Multer: ok
    Multer-->>BE: req.file = {filename, originalname, ...}
    BE->>DB: INSERT orders SET drawing = JSON({storedName, originalName})
    BE-->>U: {id, ...}

    Note over U,FS: Скачивание (защищённый доступ)
    U->>BE: GET /uploads/:filename (Authorization: Bearer token)
    BE->>BE: requireAuth — проверка JWT → user
    BE->>BE: path.basename(filename) — защита от path traversal
    BE->>FS: fs.existsSync(filepath)
    FS-->>BE: true
    BE->>FS: res.sendFile(filepath)
    FS-->>U: файл
```
