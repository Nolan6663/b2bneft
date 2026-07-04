'use strict';
// Импорт производителей из реестров в каталог (стабы: claimed=false).
// Использование: node scripts/import-registry.js <file.json|file.csv> [--dry-run] [--source fabricators]
// Idempotent: upsert по ИНН; claimed=true компании НЕ трогаются никогда.
// Если стаб с таким ИНН уже есть из ДРУГОГО источника — только дозаполняем пустые
// поля, source и название не трогаем (ГИСП-обогащение не затирается).
const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE = 'gisp-pp719';

function normalizeInn(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    return (digits.length === 10 || digits.length === 12) ? digits : null;
}

function normalizeRow(r) {
    const inn = normalizeInn(r.inn);
    const company = String(r.company || '').trim();
    if (!inn || !company) return null;
    return {
        company,
        inn,
        city: String(r.city || '').trim(),
        specialization: String(r.specialization || '').trim(),
        ogrn: String(r.ogrn || '').replace(/\D/g, ''),
        website: String(r.website || r.site || '').trim(),
        email: String(r.email || '').trim(),
        phone: String(r.phone || '').trim(),
    };
}

function parseRegistryFile(file) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    let raw;
    if (file.toLowerCase().endsWith('.csv')) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        const head = lines.shift().split(';').map(s => s.trim().toLowerCase());
        raw = lines.map(l => {
            const cells = l.split(';');
            const o = {};
            head.forEach((h, i) => { o[h] = cells[i] || ''; });
            return o;
        });
    } else {
        raw = JSON.parse(text);
    }
    const seen = new Set();
    const out = [];
    for (const r of raw) {
        const n = normalizeRow(r);
        if (!n || seen.has(n.inn)) continue;
        seen.add(n.inn);
        out.push(n);
    }
    return out;
}

async function run() {
    const args = process.argv.slice(2);
    const file = args.find(a => !a.startsWith('--'));
    const dryRun = args.includes('--dry-run');
    const srcIdx = args.indexOf('--source');
    const source = srcIdx >= 0 ? String(args[srcIdx + 1] || '').trim() : DEFAULT_SOURCE;
    if (!file || !source) { console.error('usage: node scripts/import-registry.js <file.json|csv> [--dry-run] [--source name]'); process.exit(1); }
    const rows = parseRegistryFile(path.resolve(file));
    console.log(`Распознано записей: ${rows.length} (source='${source}')`);
    if (dryRun) {
        rows.slice(0, 5).forEach(r => console.log(' ', r.inn, r.company, '·', r.city, r.email ? '· ' + r.email : ''));
        console.log('(dry-run: БД не тронута)');
        return;
    }
    require('dotenv').config();
    const { pool } = require('../db.js');
    let inserted = 0, updated = 0, filled = 0, skippedClaimed = 0;
    for (const r of rows) {
        const { rows: [existing] } = await pool.query(
            "SELECT id, claimed, source FROM companies WHERE inn = $1 AND role = 'producer' LIMIT 1", [r.inn]
        );
        if (existing && existing.claimed) { skippedClaimed++; continue; }
        if (existing && existing.source && existing.source !== source) {
            // стаб из другого реестра: дозаполняем только пустое, source не меняем
            await pool.query(
                `UPDATE companies SET
                    city           = CASE WHEN city = ''           THEN $1 ELSE city END,
                    specialization = CASE WHEN specialization = '' THEN $2 ELSE specialization END,
                    ogrn           = CASE WHEN ogrn = ''           THEN $3 ELSE ogrn END,
                    website        = CASE WHEN website = ''        THEN $4 ELSE website END,
                    contact_email  = CASE WHEN contact_email = ''  THEN $5 ELSE contact_email END,
                    phone          = CASE WHEN phone = ''          THEN $6 ELSE phone END
                 WHERE id = $7`,
                [r.city, r.specialization, r.ogrn, r.website, r.email, r.phone, existing.id]
            );
            filled++;
        } else if (existing) {
            await pool.query(
                `UPDATE companies SET company=$1, city=$2, specialization=$3, ogrn=$4, source=$5,
                    website       = CASE WHEN $6 <> '' THEN $6 ELSE website END,
                    contact_email = CASE WHEN $7 <> '' THEN $7 ELSE contact_email END,
                    phone         = CASE WHEN $8 <> '' THEN $8 ELSE phone END
                 WHERE id = $9`,
                [r.company, r.city, r.specialization, r.ogrn, source, r.website, r.email, r.phone, existing.id]
            );
            updated++;
        } else {
            await pool.query(
                `INSERT INTO companies (company, inn, role, specialization, status, city, ogrn, source, claimed, website, contact_email, phone)
                 VALUES ($1,$2,'producer',$3,'Действующая',$4,$5,$6,false,$7,$8,$9)`,
                [r.company, r.inn, r.specialization, r.city, r.ogrn, source, r.website, r.email, r.phone]
            );
            inserted++;
        }
    }
    console.log(`Вставлено: ${inserted}, обновлено стабов: ${updated}, дозаполнено чужих: ${filled}, пропущено claimed: ${skippedClaimed}`);
    await pool.end();
}

module.exports = { parseRegistryFile, normalizeInn };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
