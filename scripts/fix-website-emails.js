'use strict';
// Разовый фикс: у ~76 заглушек ГИСП положил email в поле «сайт».
// Спасаем email (если contact_email пуст) и чистим website.
// Запуск на VPS: node scripts/fix-website-emails.js
require('dotenv').config();
const { pool } = require('../db.js');

(async () => {
    const saved = await pool.query(`
        UPDATE companies SET contact_email = LOWER(TRIM(website))
        WHERE claimed = false AND source = 'gisp-pp719'
          AND website LIKE '%@%' AND contact_email = ''
          AND TRIM(website) ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$'
    `);
    const cleaned = await pool.query(`
        UPDATE companies SET website = ''
        WHERE claimed = false AND source = 'gisp-pp719' AND website LIKE '%@%'
    `);
    console.log(`email спасено: ${saved.rowCount}, поле сайт очищено: ${cleaned.rowCount}`);
    await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
