'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const db = new DatabaseSync(path.join(__dirname, 'data.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    email    TEXT    UNIQUE NOT NULL,
    password TEXT    NOT NULL,
    role     TEXT    NOT NULL,
    company  TEXT    NOT NULL,
    inn      TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS companies (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    company          TEXT NOT NULL,
    inn              TEXT NOT NULL DEFAULT '',
    role             TEXT NOT NULL,
    specialization   TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'На проверке',
    city             TEXT NOT NULL DEFAULT '',
    years_experience INTEGER,
    about            TEXT NOT NULL DEFAULT '',
    equipment        TEXT NOT NULL DEFAULT '[]',
    phone            TEXT NOT NULL DEFAULT '',
    website          TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    category    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'Активный',
    responses   INTEGER NOT NULL DEFAULT 0,
    deadline    TEXT,
    quantity    INTEGER,
    description TEXT    NOT NULL DEFAULT '',
    company     TEXT    NOT NULL DEFAULT '',
    drawing     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS proposals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL,
    order_title TEXT,
    price       REAL    NOT NULL,
    days        INTEGER NOT NULL,
    company     TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'Ожидает ответа',
    kp_file     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL,
    company    TEXT    NOT NULL,
    sender     TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    company    TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS favorites (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_company TEXT    NOT NULL,
    company_id    INTEGER NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(owner_company, company_id)
);
`);

// Разовый импорт из JSON-файлов (запускается только если таблица users пуста)
(function migrate() {
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;

    function readJson(name) {
        const file = path.join(__dirname, name);
        try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; }
        catch { return []; }
    }

    const insertUser = db.prepare('INSERT OR IGNORE INTO users (id,email,password,role,company,inn) VALUES (?,?,?,?,?,?)');
    readJson('users.json').forEach(u =>
        insertUser.run(u.id, u.email, u.password || '', u.role, u.company, u.inn || ''));

    const insertCompany = db.prepare('INSERT OR IGNORE INTO companies (id,company,inn,role,specialization,status,city,years_experience,about,equipment,phone,website) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    readJson('companies.json').forEach(c =>
        insertCompany.run(c.id, c.company, c.inn || '', c.role, c.specialization || '',
            c.status || 'На проверке', c.city || '', c.yearsExperience ?? null,
            c.about || '', JSON.stringify(c.equipment || []), c.phone || '', c.website || ''));

    const insertOrder = db.prepare('INSERT OR IGNORE INTO orders (id,title,category,status,responses,deadline,quantity,description,company,drawing,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    readJson('orders.json').forEach(o =>
        insertOrder.run(o.id, o.title, o.category, o.status || 'Активный', o.responses || 0,
            o.deadline ?? null, o.quantity ?? null, o.description || '', o.company || '',
            o.drawing ? JSON.stringify(o.drawing) : null,
            o.createdAt || new Date().toISOString()));

    const insertProposal = db.prepare('INSERT OR IGNORE INTO proposals (id,order_id,order_title,price,days,company,status,kp_file,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    readJson('proposals.json').forEach(p =>
        insertProposal.run(p.id, p.orderId, p.orderTitle ?? null, p.price, p.days,
            p.company, p.status || 'Ожидает ответа',
            p.kpFile ? JSON.stringify(p.kpFile) : null,
            p.createdAt || new Date().toISOString()));

    const insertMsg = db.prepare('INSERT OR IGNORE INTO messages (id,order_id,company,sender,text,created_at) VALUES (?,?,?,?,?,?)');
    readJson('messages.json').forEach(m =>
        insertMsg.run(m.id, m.orderId, m.company, m.sender, m.text,
            m.createdAt || new Date().toISOString()));

    const insertNotif = db.prepare('INSERT OR IGNORE INTO notifications (id,company,text,read,created_at) VALUES (?,?,?,?,?)');
    readJson('notifications.json').forEach(n =>
        insertNotif.run(n.id, n.company, n.text, n.read ? 1 : 0,
            n.createdAt || new Date().toISOString()));

    const insertFav = db.prepare('INSERT OR IGNORE INTO favorites (id,owner_company,company_id,created_at) VALUES (?,?,?,?)');
    readJson('favorites.json').forEach(f =>
        insertFav.run(f.id, f.ownerCompany, f.companyId,
            f.createdAt || new Date().toISOString()));

    console.log('✓ Данные перенесены из JSON в SQLite');
})();

// Начальные закупки для пустой базы (только при первом запуске без JSON-данных)
if (db.prepare('SELECT COUNT(*) AS n FROM orders').get().n === 0) {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO orders (title,category,status,responses,deadline,created_at) VALUES (?,?,?,?,?,?)")
        .run('Манжета резиновая армированная', 'РТИ', 'Активный', 0, '25.05.2026', now);
    db.prepare("INSERT INTO orders (title,category,status,responses,deadline,created_at) VALUES (?,?,?,?,?,?)")
        .run('Фланец стальной ГОСТ', 'Металл', 'Активный', 0, '28.05.2026', now);
}

module.exports = db;
