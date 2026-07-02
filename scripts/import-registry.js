'use strict';
// Импорт производителей из реестра в каталог (стабы: claimed=false, source='gisp-pp719').
// Использование: node scripts/import-registry.js <file.json|file.csv> [--dry-run]
// Idempotent: upsert по ИНН; claimed=true компании НЕ трогаются никогда.
const fs = require('fs');
const path = require('path');

const SOURCE = 'gisp-pp719';

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
    const file = process.argv[2];
    const dryRun = process.argv.includes('--dry-run');
    if (!file) { console.error('usage: node scripts/import-registry.js <file.json|csv> [--dry-run]'); process.exit(1); }
    const rows = parseRegistryFile(path.resolve(file));
    console.log(`Распознано записей: ${rows.length}`);
    if (dryRun) {
        rows.slice(0, 5).forEach(r => console.log(' ', r.inn, r.company, '·', r.city));
        console.log('(dry-run: БД не тронута)');
        return;
    }
    require('dotenv').config();
    const { pool } = require('../db.js');
    let inserted = 0, updated = 0, skippedClaimed = 0;
    for (const r of rows) {
        const { rows: [existing] } = await pool.query(
            "SELECT id, claimed FROM companies WHERE inn = $1 AND role = 'producer' LIMIT 1", [r.inn]
        );
        if (existing && existing.claimed) { skippedClaimed++; continue; }
        if (existing) {
            await pool.query(
                "UPDATE companies SET company=$1, city=$2, specialization=$3, ogrn=$4, source=$5 WHERE id=$6",
                [r.company, r.city, r.specialization, r.ogrn, SOURCE, existing.id]
            );
            updated++;
        } else {
            await pool.query(
                "INSERT INTO companies (company, inn, role, specialization, status, city, ogrn, source, claimed) VALUES ($1,$2,'producer',$3,'Действующая',$4,$5,$6,false)",
                [r.company, r.inn, r.specialization, r.city, r.ogrn, SOURCE]
            );
            inserted++;
        }
    }
    console.log(`Вставлено: ${inserted}, обновлено стабов: ${updated}, пропущено claimed: ${skippedClaimed}`);
    await pool.end();
}

module.exports = { parseRegistryFile, normalizeInn };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
