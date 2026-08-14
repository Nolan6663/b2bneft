'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

// Return bigint columns as JS numbers, not strings
require('pg').types.setTypeParser(20, parseInt);

const isRender = (process.env.DATABASE_URL || '').includes('render.com');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isRender ? { rejectUnauthorized: false } : false,
});

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id       SERIAL  PRIMARY KEY,
            email    TEXT    UNIQUE NOT NULL,
            password TEXT    NOT NULL,
            role     TEXT    NOT NULL,
            company  TEXT    NOT NULL,
            inn      TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS companies (
            id                   SERIAL  PRIMARY KEY,
            company              TEXT    NOT NULL,
            inn                  TEXT    NOT NULL DEFAULT '',
            role                 TEXT    NOT NULL,
            specialization       TEXT    NOT NULL DEFAULT '',
            status               TEXT    NOT NULL DEFAULT 'На проверке',
            city                 TEXT    NOT NULL DEFAULT '',
            years_experience     INTEGER,
            about                TEXT    NOT NULL DEFAULT '',
            equipment            TEXT    NOT NULL DEFAULT '[]',
            phone                TEXT    NOT NULL DEFAULT '',
            website              TEXT    NOT NULL DEFAULT '',
            ogrn                 TEXT    NOT NULL DEFAULT '',
            director             TEXT    NOT NULL DEFAULT '',
            founding_year        INTEGER,
            authorized_capital   TEXT    NOT NULL DEFAULT '',
            employees            INTEGER,
            revenue              TEXT    NOT NULL DEFAULT '',
            machines_count       INTEGER,
            production_area      INTEGER,
            video_url            TEXT    NOT NULL DEFAULT '',
            iso_certificates     TEXT    NOT NULL DEFAULT '[]',
            quality_certificates TEXT    NOT NULL DEFAULT '[]',
            capabilities         TEXT    NOT NULL DEFAULT '[]',
            production_load      INTEGER,
            verified_by_platform BOOLEAN NOT NULL DEFAULT false
        );
        CREATE TABLE IF NOT EXISTS orders (
            id          SERIAL      PRIMARY KEY,
            title       TEXT        NOT NULL,
            category    TEXT        NOT NULL,
            status      TEXT        NOT NULL DEFAULT 'Активный',
            responses   INTEGER     NOT NULL DEFAULT 0,
            deadline    TEXT,
            quantity    INTEGER,
            description TEXT        NOT NULL DEFAULT '',
            company     TEXT        NOT NULL DEFAULT '',
            drawing     TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS proposals (
            id                SERIAL      PRIMARY KEY,
            order_id          INTEGER     NOT NULL,
            order_title       TEXT,
            price             REAL        NOT NULL,
            days              INTEGER     NOT NULL,
            company           TEXT        NOT NULL,
            status            TEXT        NOT NULL DEFAULT 'Ожидает ответа',
            kp_file           TEXT,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completion_status TEXT        NOT NULL DEFAULT 'active'
        );
        -- Запрос доступа к чертежу.
        --
        -- До этой таблицы чертёж открывался заводу только после подачи КП, а КП
        -- требует цену. Получался замкнутый круг: назови цену, не видя чертежа.
        -- Первый же живой завод в него упёрся.
        --
        -- Теперь доступ даёт отдельный шаг без обязательств. Защита от того,
        -- чтобы чертежи разошлись по всему каталогу, при этом не исчезает, а
        -- меняет природу: раньше «почти никто не мог посмотреть», теперь
        -- «смотреть может завод, который назвался». Заказчик видит поимённо,
        -- кто открывал, — на это и опирается доверие.
        CREATE TABLE IF NOT EXISTS order_drawing_requests (
            id         SERIAL      PRIMARY KEY,
            order_id   INTEGER     NOT NULL,
            company    TEXT        NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (order_id, company)
        );
        CREATE INDEX IF NOT EXISTS order_drawing_requests_order ON order_drawing_requests (order_id);
        CREATE TABLE IF NOT EXISTS messages (
            id         SERIAL      PRIMARY KEY,
            order_id   INTEGER     NOT NULL,
            company    TEXT        NOT NULL,
            sender     TEXT        NOT NULL,
            text       TEXT        NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            read       BOOLEAN     NOT NULL DEFAULT false
        );
        CREATE TABLE IF NOT EXISTS notifications (
            id         SERIAL      PRIMARY KEY,
            company    TEXT        NOT NULL,
            text       TEXT        NOT NULL,
            read       BOOLEAN     NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS favorites (
            id            SERIAL      PRIMARY KEY,
            owner_company TEXT        NOT NULL,
            company_id    INTEGER     NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(owner_company, company_id)
        );
        CREATE TABLE IF NOT EXISTS favorite_orders (
            id            SERIAL      PRIMARY KEY,
            owner_company TEXT        NOT NULL,
            order_id      INTEGER     NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(owner_company, order_id)
        );
        CREATE TABLE IF NOT EXISTS saved_searches (
            id            SERIAL      PRIMARY KEY,
            owner_company TEXT        NOT NULL,
            name          TEXT        NOT NULL,
            params        TEXT        NOT NULL DEFAULT '{}',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS saved_searches_owner_idx ON saved_searches (owner_company);
        CREATE TABLE IF NOT EXISTS company_photos (
            id            SERIAL      PRIMARY KEY,
            company_id    INTEGER     NOT NULL,
            stored_name   TEXT        NOT NULL,
            original_name TEXT        NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS verification_requests (
            id            SERIAL      PRIMARY KEY,
            company_id    INTEGER     NOT NULL,
            status        TEXT        NOT NULL DEFAULT 'pending',
            admin_comment TEXT        NOT NULL DEFAULT '',
            requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at   TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id         SERIAL      PRIMARY KEY,
            user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token      TEXT        NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS refresh_tokens (
            id         SERIAL      PRIMARY KEY,
            user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token      TEXT        NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS delivery_events (
            id          SERIAL      PRIMARY KEY,
            proposal_id INTEGER     NOT NULL,
            stage       TEXT        NOT NULL,
            notes       TEXT        NOT NULL DEFAULT '',
            updated_by  TEXT        NOT NULL DEFAULT 'system',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS seo_audits (
            id         SERIAL      PRIMARY KEY,
            page       TEXT        NOT NULL,
            score      INTEGER     NOT NULL,
            issues     JSONB       NOT NULL,
            audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS seo_snapshots (
            id          SERIAL      PRIMARY KEY,
            source      TEXT        NOT NULL DEFAULT 'google',
            date        DATE        NOT NULL,
            query       TEXT        NOT NULL,
            page        TEXT        NOT NULL,
            impressions INTEGER     NOT NULL DEFAULT 0,
            clicks      INTEGER     NOT NULL DEFAULT 0,
            ctr         REAL        NOT NULL DEFAULT 0,
            position    REAL        NOT NULL DEFAULT 0,
            UNIQUE(source, date, query, page)
        );
        CREATE TABLE IF NOT EXISTS seo_intents (
            query         TEXT        PRIMARY KEY,
            intent        TEXT        NOT NULL,
            intent_ru     TEXT        NOT NULL,
            classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS email_verification_tokens (
            id         SERIAL      PRIMARY KEY,
            user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token      TEXT        NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS integrations (
            id         SERIAL      PRIMARY KEY,
            company    TEXT        NOT NULL,
            provider   TEXT        NOT NULL,
            config     JSONB       NOT NULL DEFAULT '{}',
            enabled    BOOLEAN     NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(company, provider)
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id         SERIAL      PRIMARY KEY,
            order_id   INTEGER     NOT NULL,
            company    TEXT        NOT NULL,
            title      TEXT        NOT NULL,
            due_date   DATE,
            status     TEXT        NOT NULL DEFAULT 'open',
            created_by TEXT        NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS invitations (
            id         SERIAL      PRIMARY KEY,
            token      TEXT        NOT NULL UNIQUE,
            email      TEXT        NOT NULL,
            company    TEXT        NOT NULL,
            role       TEXT        NOT NULL,
            team_role  TEXT        NOT NULL DEFAULT 'member',
            invited_by TEXT        NOT NULL,
            accepted   BOOLEAN     NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
        );
        CREATE TABLE IF NOT EXISTS reviews (
            id           SERIAL      PRIMARY KEY,
            order_id     INTEGER     NOT NULL,
            from_company TEXT        NOT NULL,
            to_company   TEXT        NOT NULL,
            score        INTEGER     NOT NULL CHECK (score BETWEEN 1 AND 5),
            text         TEXT        NOT NULL DEFAULT '',
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(order_id, from_company, to_company)
        );
        CREATE TABLE IF NOT EXISTS order_templates (
            id            SERIAL      PRIMARY KEY,
            company       TEXT        NOT NULL,
            title         TEXT        NOT NULL,
            category      TEXT        NOT NULL DEFAULT '',
            description   TEXT        NOT NULL DEFAULT '',
            quantity      INTEGER,
            deadline_days INTEGER,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS auctions (
            id            SERIAL      PRIMARY KEY,
            order_id      INTEGER     NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            start_price   NUMERIC     NOT NULL,
            current_best  NUMERIC,
            end_time      TIMESTAMPTZ NOT NULL,
            status        TEXT        NOT NULL DEFAULT 'active',
            winner_company TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS auction_bids (
            id            SERIAL      PRIMARY KEY,
            auction_id    INTEGER     NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
            company       TEXT        NOT NULL,
            price         NUMERIC     NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id            SERIAL      PRIMARY KEY,
            user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            subscription  JSONB       NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS order_events (
            id            SERIAL      PRIMARY KEY,
            order_id      INTEGER     NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            event_type    TEXT        NOT NULL,
            title         TEXT        NOT NULL,
            detail        TEXT        NOT NULL DEFAULT '',
            actor         TEXT        NOT NULL DEFAULT '',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS outreach_log (
            id            SERIAL      PRIMARY KEY,
            company_id    INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            email         TEXT        NOT NULL,
            subject       TEXT        NOT NULL DEFAULT '',
            status        TEXT        NOT NULL DEFAULT 'sent',
            error         TEXT        NOT NULL DEFAULT '',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        -- Сопоставление городов с кодами перевозчиков. Справочники у всех свои и
        -- несовместимые: у ПЭК собственные числовые id, у Деловых Линий КЛАДР.
        -- search_key — нормализованное имя (см. lib/logistics/geo.js), по нему
        -- ищется город, введённый человеком: «СПб» и «г. Санкт-Петербург»
        -- должны попадать в одну строку.
        --
        -- search_key НЕ уникален, и это важно: в справочнике ПЭК 307 названий
        -- встречаются больше одного раза. «Белый Яр» есть под Абаканом и под
        -- Сургутом — между ними 2500 км. Уникальность здесь означала бы молчаливый
        -- выбор одного из двух, поэтому неоднозначность хранится и разрешается
        -- человеком. Уникален pecom_id — он и держит повторную загрузку.
        CREATE TABLE IF NOT EXISTS logistics_cities (
            id          SERIAL      PRIMARY KEY,
            name        TEXT        NOT NULL,
            qualifier   TEXT        NOT NULL DEFAULT '',
            search_key  TEXT        NOT NULL,
            pecom_id    TEXT        UNIQUE,
            pecom_hub   TEXT        NOT NULL DEFAULT '',
            dellin_code TEXT,
            is_hub      BOOLEAN     NOT NULL DEFAULT false,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS logistics_cities_key ON logistics_cities (search_key);
        -- Коды перевозчиков, добываемые лениво их же поиском (см. fillCarrierCode
        -- в lib/logistics/geo.js). Отдельной колонкой на каждого: справочники
        -- несовместимы, у Возовоза это guid их внутреннего реестра.
        ALTER TABLE logistics_cities ADD COLUMN IF NOT EXISTS vozovoz_guid TEXT;
        -- Кэш расчётов. Тарифы меняются редко, а маршрут в карточке КП
        -- открывают многократно — незачем дёргать чужой публичный API на каждый
        -- показ. Ключ считается от нормализованного запроса (lib/logistics/index.js),
        -- срок жизни проверяется по created_at при чтении.
        CREATE TABLE IF NOT EXISTS logistics_quotes_cache (
            cache_key  TEXT        PRIMARY KEY,
            carrier    TEXT        NOT NULL,
            payload    TEXT        NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS logistics_cache_created ON logistics_quotes_cache (created_at);
        -- Габариты груза указывает завод при подаче КП: он знает вес готового
        -- изделия, заказчик обычно нет. Все поля необязательные — КП без
        -- габаритов полноценно, просто без расчёта доставки.
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cargo_weight REAL;
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cargo_length REAL;
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cargo_width  REAL;
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cargo_height REAL;
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cargo_places INTEGER;
    `);

    await pool.query(`
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS free_capacity TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS lat FLOAT;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS lng FLOAT;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS claimed BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_email TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS invite_optout BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_invited_at TIMESTAMPTZ;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS products TEXT NOT NULL DEFAULT '';
        -- Закупка размещена до подтверждения email: письма и инвайты ждут, пока
        -- заказчик подтвердит адрес (flushPendingOutbound в routes/auth.js).
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS outbound_pending BOOLEAN NOT NULL DEFAULT false;
        -- К закупке можно приложить несколько файлов. Старая колонка drawing
        -- остаётся ради уже размещённых заявок: при чтении она подмешивается
        -- первым вложением, при следующем сохранении переезжает в attachments.
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS attachments TEXT;
        -- Очередь публикаций в сообщество ВКонтакте. UNIQUE по order_id —
        -- дедупликация на уровне схемы: повторный пост той же закупки
        -- невозможен, даже если воркер запустится дважды.
        CREATE TABLE IF NOT EXISTS vk_posts (
            id          SERIAL      PRIMARY KEY,
            order_id    INTEGER     NOT NULL UNIQUE,
            status      TEXT        NOT NULL DEFAULT 'pending',
            attempts    INTEGER     NOT NULL DEFAULT 0,
            vk_post_id  BIGINT,
            last_error  TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            posted_at   TIMESTAMPTZ
        );
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS invites_sent INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS kpp TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS legal_address TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_account TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_bik TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_corr TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_system TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '';
        -- persistent=false — вход без «запомнить меня»: куки живут до закрытия
        -- браузера. Флаг нужен именно в базе: продление сессии (lib/session-renew)
        -- выставляет куки заново и без него молча сделало бы вход постоянным.
        ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS persistent BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip TEXT NOT NULL DEFAULT '';
        ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS delivery_stage TEXT NOT NULL DEFAULT 'КП принят';
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS tracking_number TEXT NOT NULL DEFAULT '';
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT '';
        ALTER TABLE auctions ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE auctions ADD COLUMN IF NOT EXISTS winner_proposal_id INTEGER REFERENCES proposals(id);
        ALTER TABLE auction_bids ADD COLUMN IF NOT EXISTS days INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS responses INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS team_role TEXT NOT NULL DEFAULT 'admin';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_frequency TEXT NOT NULL DEFAULT 'daily';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS verified_egrul BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS egrul_verified_at TIMESTAMPTZ;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_version TEXT NOT NULL DEFAULT '';
    `);
    // Telegram columns in a separate query so they don't break the batch above
    try {
        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_token VARCHAR(64);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_expires TIMESTAMPTZ;
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;
        `);
    } catch (e) {
        console.warn('[db] telegram columns already exist or skipped:', e.message);
    }

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
        CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);
    `);

    await pool.query(`
        UPDATE users u SET email_verified = true
        WHERE email_verified = false
          AND NOT EXISTS (SELECT 1 FROM email_verification_tokens t WHERE t.user_id = u.id)
    `);

    const isProduction = process.env.NODE_ENV === 'production';
    const shouldSeedAdmin = process.env.SEED_ADMIN === 'true' || !isProduction;
    const shouldSeedDemoData = process.env.SEED_DEMO_DATA === 'true' || !isProduction;

    const { rows: [adminRow] } = await pool.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
    if (!adminRow && shouldSeedAdmin) {
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@platform.ru';
        const adminPassword = process.env.ADMIN_PASSWORD || (isProduction ? '' : 'Admin2025');
        if (!adminPassword) {
            console.warn('Администратор не создан: задайте ADMIN_PASSWORD или отключите SEED_ADMIN');
        } else {
            const salt = crypto.randomBytes(16).toString('hex');
            const hash = crypto.scryptSync(adminPassword, salt, 64).toString('hex');
            await pool.query(
                'INSERT INTO users (email,password,role,company,inn,email_verified) VALUES ($1,$2,$3,$4,$5,true)',
                [adminEmail, `${salt}:${hash}`, 'admin', '', '']
            );
            console.log(`✓ Создан аккаунт администратора: ${adminEmail}`);
        }
    }

    const { rows: [{ n: orderCount }] } = await pool.query('SELECT COUNT(*) AS n FROM orders');
    if (orderCount === 0 && shouldSeedDemoData) {
        await pool.query(
            "INSERT INTO orders (title,category,status,responses,deadline) VALUES ($1,$2,$3,$4,$5)",
            ['Манжета резиновая армированная', 'РТИ', 'Активный', 0, '25.05.2026']
        );
        await pool.query(
            "INSERT INTO orders (title,category,status,responses,deadline) VALUES ($1,$2,$3,$4,$5)",
            ['Фланец стальной ГОСТ', 'Металл', 'Активный', 0, '28.05.2026']
        );
    }

    console.log('✓ База данных готова');
}

async function logOrderEvent(orderId, eventType, title, detail = '', actor = '') {
    if (!orderId || !eventType || !title) return;
    await pool.query(
        'INSERT INTO order_events (order_id, event_type, title, detail, actor) VALUES ($1,$2,$3,$4,$5)',
        [orderId, eventType, title, String(detail || '').slice(0, 500), String(actor || '').slice(0, 200)]
    );
}

module.exports = { pool, initDb, logOrderEvent };
