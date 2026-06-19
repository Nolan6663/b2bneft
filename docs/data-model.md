# Data Model — B2B Нефтесервис

## ER Diagram

```mermaid
erDiagram

    users {
        serial      id              PK
        text        email           UK
        text        password
        text        company
        text        role            "customer | producer | admin"
        text        refresh_token
        timestamp   created_at
    }

    companies {
        serial      id              PK
        text        company         UK
        text        inn
        text        role            "customer | producer"
        text        specialization
        text        status          "На проверке | Верифицирован | Отклонён"
        text        city
        int         years_experience
        text        about
        jsonb       equipment       "string[]"
        text        phone
        text        website
        text        ogrn
        text        director
        int         founding_year
        text        authorized_capital
        int         employees
        text        revenue
        int         machines_count
        int         production_area
        text        video_url
        jsonb       iso_certificates    "string[]"
        jsonb       quality_certificates "string[]"
        jsonb       capabilities        "string[]"
        int         production_load     "0–100 %"
        boolean     verified_by_platform
        jsonb       free_capacity       "FreeCapacity[]"
        float       lat
        float       lng
    }

    orders {
        serial      id              PK
        text        title
        text        category        "РТИ | Металл | Трубопроводная арматура | Электрооборудование | Прочее"
        text        status          "Активна | Отменена | Закрыта"
        int         responses       "счётчик КП"
        date        deadline
        text        quantity
        text        description
        text        company         FK "→ companies.company"
        jsonb       drawing         "DrawingMeta | null"
        timestamp   created_at
    }

    proposals {
        serial      id              PK
        int         order_id        FK
        text        price
        int         days
        text        company         FK "→ companies.company"
        text        status          "Ожидает | Выигран | Отклонен"
        jsonb       kp_file         "FileMeta | null"
        timestamp   created_at
    }

    messages {
        serial      id              PK
        int         order_id        FK
        text        company         "производитель"
        text        sender
        text        text
        boolean     read
        timestamp   created_at
    }

    notifications {
        serial      id              PK
        text        company
        text        text
        boolean     read
        timestamp   created_at
    }

    favorites {
        serial      id              PK
        text        owner_company
        int         company_id      FK
    }

    company_photos {
        serial      id              PK
        int         company_id      FK
        text        stored_name
        text        original_name
        timestamp   created_at
    }

    delivery_stages {
        serial      id              PK
        int         proposal_id     FK
        text        stage           "Согласование | Производство | Отгрузка | Доставлено"
        text        status          "pending | active | done"
        timestamp   created_at
    }

    verification_requests {
        serial      id              PK
        text        company
        text        role
        text        documents
        text        status          "pending | approved | rejected"
        timestamp   created_at
    }

    users         ||--o{ orders         : "размещает (company)"
    users         ||--o{ proposals      : "подаёт (company)"
    companies     ||--o{ company_photos : "имеет"
    companies     ||--o{ favorites      : "в избранном у"
    orders        ||--o{ proposals      : "получает"
    orders        ||--o{ messages       : "содержит переписку"
    proposals     ||--o{ delivery_stages: "проходит этапы"
```

---

## Ключевые бизнес-правила в данных

### Жизненный цикл заявки (Order)

```
Активна  ──(cancel)──▶  Отменена
Активна  ──(accept proposal)──▶  Закрыта
```

### Жизненный цикл КП (Proposal)

```
Ожидает  ──(accept)──▶  Выигран   ──▶  delivery_stages создаются
Ожидает  ──(reject)──▶  Отклонен
```
При победе КП: все остальные КП по той же заявке → `Отклонен`, заявка → `Закрыта`, `responses` на заявке инкрементируется при создании КП.

### Рейтинг производителя (вычисляемый, не хранится)

| Условие | Рейтинг | Метка |
|---------|---------|-------|
| win/total ≥ 0.7 и won ≥ 3 | A+ | Высокий |
| win/total ≥ 0.5 | A | Высокий |
| win/total ≥ 0.3 | B+ | Средний |
| win/total ≥ 0.15 или won > 0 | B | Средний |
| иначе | C | Низкий |

### Smart Matching Score (0–100)

```
Балл = min(совпадений_ключевых_слов_категории, 3) × 20   // макс 60
     + min(совпадений_слов_заголовка/описания, 2) × 15     // макс 30
     + (средняя_свободная_загрузка ≥ 30% ? 10 : 0)         // бонус
```

### Типы файлов

| Поле | Разрешённые расширения | Хранится как |
|------|----------------------|-------------|
| `orders.drawing` | `.pdf .png .jpg .jpeg .dxf .dwg .step .stp` | `DrawingMeta { storedName, originalName }` |
| `proposals.kp_file` | `.pdf .doc .docx .xls .xlsx .png .jpg .jpeg` | `FileMeta { storedName, originalName }` |
| `company_photos` | `.jpg .jpeg .png .webp` | `stored_name` в `uploads/photos/` |
