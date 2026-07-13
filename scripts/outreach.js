'use strict';
// Маркетинговая рассылка заводам-стабам (одно письмо на компанию, повторов нет).
// Запуск из корня проекта:
//   node scripts/outreach.js --dry-run --limit 3     показать письма, ничего не слать
//   node scripts/outreach.js --test mail@example.com  одно письмо на свою почту
//   node scripts/outreach.js --send --limit 20        реальная отправка с логом в outreach_log
// На VPS обязателен префикс NODE_EXTRA_CA_CERTS=certs/russian_trusted_root_ca.pem —
// иначе GigaChat падает с "fetch failed" (сертификат Сбера; PM2 берёт его из
// ecosystem.config.js, но отдельный скрипт запускается вне PM2).
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { pool } = require('../db');
const { JWT_SECRET } = require('../lib/auth-tokens');
const { createOutreach } = require('../lib/outreach');

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function opt(name, def) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const DRY_RUN = flag('--dry-run');
const SEND = flag('--send');
const TEST_TO = opt('--test', '');
const LIMIT = Math.max(1, Math.min(100, parseInt(opt('--limit', TEST_TO ? '1' : '20'), 10) || 20));
const APP_URL = (process.env.APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@texzakaz.ru';
const REPLY_TO = process.env.OUTREACH_REPLY_TO || '';
const PREVIEW_DIR = path.join(__dirname, '..', 'outreach-preview');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    if (!DRY_RUN && !SEND && !TEST_TO) {
        console.log('Укажи режим: --dry-run | --test почта | --send. Ничего не делаю.');
        process.exit(1);
    }
    const transport = (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
        ? nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 465,
            secure: true,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        })
        : null;
    if ((SEND || TEST_TO) && !transport) {
        console.error('SMTP не настроен (SMTP_HOST/USER/PASS в .env) — отправка невозможна.');
        process.exit(1);
    }
    if (SEND && !REPLY_TO) {
        console.error('OUTREACH_REPLY_TO не задан в .env — заводам некуда отвечать. Добавь и повтори.');
        process.exit(1);
    }

    const outreach = createOutreach({
        pool, transport, appUrl: APP_URL, jwtSecret: JWT_SECRET,
        emailFrom: EMAIL_FROM, replyTo: REPLY_TO,
    });

    // Таблица создаётся в db.js при старте сервера, но скрипт может запуститься раньше деплоя
    await pool.query(`
        CREATE TABLE IF NOT EXISTS outreach_log (
            id            SERIAL      PRIMARY KEY,
            company_id    INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            email         TEXT        NOT NULL,
            subject       TEXT        NOT NULL DEFAULT '',
            status        TEXT        NOT NULL DEFAULT 'sent',
            error         TEXT        NOT NULL DEFAULT '',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

    const stubs = await outreach.pickCandidates(LIMIT);
    console.log(`Кандидатов: ${stubs.length} (лимит ${LIMIT})`);
    if (!stubs.length) { await pool.end(); return; }

    if (DRY_RUN && !fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR);

    let sent = 0, failed = 0;
    for (const stub of stubs) {
        const letter = await outreach.generateLetter(stub);
        const tag = letter.ai ? 'AI' : 'шаблон';
        console.log(`\n--- ${stub.company} (${stub.city || 'город не указан'}) [${tag}]`);
        console.log(`Тема: ${letter.subject}`);
        for (const p of letter.paragraphs) console.log(`  ${p}`);

        if (DRY_RUN) {
            const file = path.join(PREVIEW_DIR, `${stub.inn}.html`);
            fs.writeFileSync(file, `<h3>${letter.subject}</h3>` + outreach.renderHtml(stub, letter));
            console.log(`Превью: ${file}`);
            continue;
        }
        if (TEST_TO) {
            const id = await outreach.sendLetter(stub, letter, TEST_TO);
            console.log(`Тестовое письмо ушло на ${TEST_TO} | id: ${id}`);
            break;
        }
        try {
            const id = await outreach.sendLetter(stub, letter);
            await outreach.markSent(stub, letter);
            sent++;
            console.log(`Отправлено на ${stub.contact_email} | id: ${id}`);
        } catch (e) {
            failed++;
            console.error(`ОШИБКА отправки на ${stub.contact_email}: ${e.message}`);
            await outreach.markFailed(stub, letter, e);
        }
        // пауза 15–30 сек — почтовые сервера банят за очереди без пауз
        if (stub !== stubs[stubs.length - 1]) await sleep(15000 + Math.random() * 15000);
    }

    if (SEND) console.log(`\nИтог: отправлено ${sent}, ошибок ${failed}.`);
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
