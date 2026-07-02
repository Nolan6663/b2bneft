'use strict';
// Выгрузка перечня производителей из ГИСП (ПП-719, публичный раздел) в формат импорта.
// ЗАПУСКАТЬ НА VPS (gisp.gov.ru блокирует зарубежные IP; локальная машина может быть за VPN).
// Разведка: node scripts/fetch-gisp.js --probe   (печатает начало ответа — подстроить парсер)
// Выгрузка: node scripts/fetch-gisp.js --pages 50 --out scripts/data/registry-gisp.json
const fs = require('fs');
const path = require('path');

const BASE = 'https://gisp.gov.ru';
const UA = 'TechZakaz-catalog/1.0 (info.texzakaz@gmail.com)';

async function get(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json, text/html' }, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', text };
}

// Кандидаты API (подстроить по факту --probe):
const CANDIDATES = [
    p => `${BASE}/pp719v2/pub/api/org/?page=${p}&size=100`,
    p => `${BASE}/pp719v2/api/pub/org/?page=${p}&size=100`,
    p => `${BASE}/pp719v2/pub/org/?page=${p}`,
];

function extractFromJson(obj) {
    // Ищем массив записей в типовых обёртках (content/items/results/data)
    const arr = Array.isArray(obj) ? obj : obj.content || obj.items || obj.results || obj.data || [];
    return arr.map(o => ({
        company: o.name || o.orgName || o.shortName || o.title || '',
        inn: o.inn || o.INN || '',
        city: o.city || o.region || o.address || '',
        specialization: o.industry || o.okpd2Name || '',
        ogrn: o.ogrn || '',
    }));
}

function extractFromHtml(html) {
    // Грубый фолбэк: строки таблицы с ИНН (10/12 цифр) рядом с названием
    const out = [];
    const rowRe = /<tr[\s\S]*?<\/tr>/g;
    for (const row of html.match(rowRe) || []) {
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
        const innCell = cells.find(c => /^\d{10}(\d{2})?$/.test(c.replace(/\D/g, '')) && c.replace(/\D/g, '').length >= 10);
        const nameCell = cells.find(c => c.length > 5 && !/^\d[\d\s-]*$/.test(c));
        if (innCell && nameCell) out.push({ company: nameCell, inn: innCell, city: cells[2] || '', specialization: '', ogrn: '' });
    }
    return out;
}

async function run() {
    const probe = process.argv.includes('--probe');
    const pagesIdx = process.argv.indexOf('--pages');
    const pages = pagesIdx > -1 ? Number(process.argv[pagesIdx + 1]) : 5;
    const outIdx = process.argv.indexOf('--out');
    const outFile = outIdx > -1 ? process.argv[outIdx + 1] : path.join(__dirname, 'data', 'registry-gisp.json');

    if (probe) {
        for (const mk of CANDIDATES) {
            const url = mk(0);
            try {
                const r = await get(url);
                console.log('\n===', url, '→', r.status, r.type);
                console.log(r.text.slice(0, 1500));
            } catch (e) { console.log('\n===', url, '→ ERROR', e.message); }
        }
        return;
    }

    let all = [];
    let working = null;
    for (const mk of CANDIDATES) {
        try {
            const r = await get(mk(0));
            if (r.status === 200) { working = mk; break; }
        } catch { /* следующий кандидат */ }
    }
    if (!working) { console.error('Ни один эндпоинт не ответил 200 — запусти с --probe и подстрой CANDIDATES'); process.exit(1); }

    for (let p = 0; p < pages; p++) {
        const r = await get(working(p));
        if (r.status !== 200) break;
        const batch = r.type.includes('json') ? extractFromJson(JSON.parse(r.text)) : extractFromHtml(r.text);
        if (!batch.length) break;
        all = all.concat(batch);
        console.log(`страница ${p}: +${batch.length} (всего ${all.length})`);
        await new Promise(res => setTimeout(res, 1500)); // вежливый rate limit к госресурсу
    }
    fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
    console.log(`Сохранено ${all.length} записей → ${outFile}. Дальше: node scripts/import-registry.js ${outFile} --dry-run`);
}

run().catch(e => { console.error(e); process.exit(1); });
