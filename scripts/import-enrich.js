'use strict';
// Импорт обогащения (контакты + продукция из каталога ГИСП) в заглушки реестра.
// Использование: node scripts/import-enrich.js [--dry-run]
// Трогает ТОЛЬКО claimed=false с source='gisp-pp719'; пустыми значениями ничего не затирает.
const fs = require('fs');
const path = require('path');

const REGISTRY = path.join(__dirname, 'data', 'registry-gisp.json');
const ENRICH = path.join(__dirname, 'data', 'registry-gisp-enrich.json');

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Zа-яА-Я]{2,}$/;

function buildRows() {
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const enrich = JSON.parse(fs.readFileSync(ENRICH, 'utf8'));
    const rows = [];
    for (const r of registry) {
        const c = enrich.contacts[r.inn] || {};
        const email = EMAIL_RE.test(c.email || '') ? c.email : '';
        const products = (enrich.products[r.ogrn] || '').slice(0, 2000);
        const site = (c.site || '').slice(0, 300);
        const phone = (c.phone || '').slice(0, 50);
        if (!email && !products && !site && !phone) continue;
        rows.push({ inn: r.inn, email, products, site, phone });
    }
    return rows;
}

async function run() {
    const dryRun = process.argv.includes('--dry-run');
    const rows = buildRows();
    const stat = {
        всего: rows.length,
        email: rows.filter(r => r.email).length,
        продукция: rows.filter(r => r.products).length,
        сайт: rows.filter(r => r.site).length,
        телефон: rows.filter(r => r.phone).length,
    };
    console.log('К обновлению:', JSON.stringify(stat));
    if (dryRun) {
        rows.filter(r => r.email).slice(0, 5).forEach(r => console.log(' ', r.inn, r.email, '·', r.products.slice(0, 60)));
        console.log('(dry-run: БД не тронута)');
        return;
    }
    require('dotenv').config();
    const { pool } = require('../db.js');
    let updated = 0;
    for (const r of rows) {
        const res = await pool.query(
            `UPDATE companies SET
                contact_email = CASE WHEN $2 <> '' THEN $2 ELSE contact_email END,
                products      = CASE WHEN $3 <> '' THEN $3 ELSE products END,
                website       = CASE WHEN $4 <> '' AND website = '' THEN $4 ELSE website END,
                phone         = CASE WHEN $5 <> '' AND phone = '' THEN $5 ELSE phone END
             WHERE inn = $1 AND role = 'producer' AND claimed = false AND source = 'gisp-pp719'`,
            [r.inn, r.email, r.products, r.site, r.phone]
        );
        updated += res.rowCount;
    }
    console.log(`Обновлено заглушек: ${updated}`);
    await pool.end();
}

module.exports = { buildRows };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
