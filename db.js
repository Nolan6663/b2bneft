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
    `);

    await pool.query(`
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS free_capacity TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS lat FLOAT;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS lng FLOAT;
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS delivery_stage TEXT NOT NULL DEFAULT 'КП принят';
        ALTER TABLE proposals ADD COLUMN IF NOT EXISTS tracking_number TEXT NOT NULL DEFAULT '';
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
                'INSERT INTO users (email,password,role,company,inn) VALUES ($1,$2,$3,$4,$5)',
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

module.exports = { pool, initDb };
