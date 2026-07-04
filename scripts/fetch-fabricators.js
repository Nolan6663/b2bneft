'use strict';
// Сбор производителей с fabricators.ru по категории продукции.
// Карточки открытые: JSON-LD (название, город, описание, телефон, сайт, email)
// + блок реквизитов (ИНН/ОГРН/юрлицо). VPN не мешает — обычный сайт.
//   node scripts/fetch-fabricators.js rezinotehnicheskie-izdeliya
//   node scripts/fetch-fabricators.js <category-slug> [--out file.json] [--limit N]
// Чекпойнт после каждых 20 карточек, повторный запуск продолжает с места обрыва.
// Результат совместим со scripts/import-registry.js (гонять на VPS с --source fabricators).
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://fabricators.ru';
const DELAY_MS = 700;
const TIMEOUT_MS = 20000;
const CHECKPOINT_EVERY = 20;

function fetchPage(url, redirects) {
    redirects = redirects == null ? 4 : redirects;
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch { return resolve(null); }
        const req = https.get(u, {
            timeout: TIMEOUT_MS,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9',
            },
        }, res => {
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
                res.resume();
                let next;
                try { next = new URL(res.headers.location, u).href; } catch { return resolve(null); }
                return resolve(fetchPage(next, redirects - 1));
            }
            if (code !== 200) { res.resume(); return resolve(null); }
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', () => resolve(null));
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function extractSlugs(html) {
    const out = new Set();
    const re = /href="\/proizvoditel\/([a-z0-9-]+)"/g;
    let m;
    while ((m = re.exec(html))) out.add(m[1]);
    return [...out];
}

function hasNextPage(html) {
    // Drupal-пейджер показывает только окно страниц без ссылки «последняя» —
    // единственный надёжный признак продолжения: ссылка «на следующую страницу»
    return /title="На следующую страницу"/.test(html);
}

function extractRequisite(html, field) {
    const re = new RegExp(`field_${field}[\\s\\S]{0,300}?line-1">\\s*([^<]+)<`);
    const m = html.match(re);
    return m ? m[1].trim() : '';
}

function extractJsonLd(html) {
    const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) {
        try {
            const data = JSON.parse(m[1]);
            const nodes = data['@graph'] || [data];
            const org = nodes.find(n => n['@type'] === 'Organization');
            if (org) return org;
        } catch { /* битый блок — смотрим следующий */ }
    }
    return null;
}

function parseCard(html, slug) {
    const org = extractJsonLd(html) || {};
    const inn = (extractRequisite(html, 'inn').match(/\d{10,12}/) || [''])[0];
    if (!inn) return null; // без ИНН импорт всё равно отбросит
    const contact = org.contactPoint || {};
    let website = String(contact.url || '').trim();
    if (/fabricators\.ru/i.test(website)) website = '';
    return {
        company: String(org.name || '').trim() || extractRequisite(html, 'jur_lico'),
        inn,
        ogrn: extractRequisite(html, 'ogrn').replace(/\D/g, ''),
        city: String((org.address || {}).addressLocality || '').trim(),
        specialization: String(org.description || '').trim(),
        website,
        email: String(contact.email || '').trim(),
        phone: String(contact.telephone || '').trim(),
        slug,
    };
}

async function run() {
    const args = process.argv.slice(2);
    const category = args.find(a => !a.startsWith('--'));
    if (!category) {
        console.error('usage: node scripts/fetch-fabricators.js <category-slug> [--out file.json] [--limit N]');
        process.exit(1);
    }
    const outIdx = args.indexOf('--out');
    const outFile = outIdx >= 0 ? path.resolve(args[outIdx + 1])
        : path.join(__dirname, 'data', `fabricators-${category}.json`);
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

    // 1. Листинг: идём по страницам, пока пейджер даёт «следующую» (окно без «последней»)
    const first = await fetchPage(`${BASE}/produkt/${category}`);
    if (!first) { console.error('Не удалось открыть категорию:', category); process.exit(1); }
    const slugs = new Set(extractSlugs(first));
    let more = hasNextPage(first);
    for (let p = 1; more && p <= 100; p++) {
        await sleep(DELAY_MS);
        const html = await fetchPage(`${BASE}/produkt/${category}?page=${p}`);
        if (!html) break;
        extractSlugs(html).forEach(s => slugs.add(s));
        more = hasNextPage(html);
        console.log(`страница ${p + 1}: всего компаний ${slugs.size}`);
    }

    // 2. Карточки (resume: уже собранные пропускаем)
    let rows = [];
    if (fs.existsSync(outFile)) {
        rows = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        console.log(`чекпойнт: уже собрано ${rows.length}`);
    }
    const done = new Set(rows.map(r => r.slug));
    const todo = [...slugs].filter(s => !done.has(s)).slice(0, limit);
    console.log(`к загрузке: ${todo.length} карточек`);

    const save = () => fs.writeFileSync(outFile, JSON.stringify(rows, null, 1));
    let fetched = 0, noInn = 0;
    for (const slug of todo) {
        await sleep(DELAY_MS);
        const html = await fetchPage(`${BASE}/proizvoditel/${slug}`);
        fetched++;
        if (!html) { console.log('  ! не открылась:', slug); continue; }
        const row = parseCard(html, slug);
        if (!row) { noInn++; continue; }
        rows.push(row);
        if (rows.length % CHECKPOINT_EVERY === 0) save();
        if (fetched % 25 === 0) console.log(`  ${fetched}/${todo.length}…`);
    }
    save();
    const withEmail = rows.filter(r => r.email).length;
    console.log(`Готово: ${rows.length} компаний (email у ${withEmail}, без ИНН пропущено ${noInn})`);
    console.log(`Файл: ${outFile}`);
    console.log(`Дальше (на VPS): node scripts/import-registry.js ${path.relative(path.join(__dirname, '..'), outFile).replace(/\\/g, '/')} --source fabricators --dry-run`);
}

module.exports = { parseCard, extractSlugs, hasNextPage };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
