'use strict';
// Обогащение реестра ПП-719: контакты (email/site/телефон) + продукция для заглушек каталога.
// Источник — JSON-RPC каталога компаний ГИСП (разведка 03.07.2026, без CSRF/HMAC в отличие
// от бэкенда pp719v2):
//   POST /company-catalog/rpc?company.list           — весь каталог (49k) страницами: email, site,
//                                                      contactPhone, shortName, ОКВЭД — фильтруем по нашим ИНН
//   POST /company-catalog/rpc?company.productsByOGRN — продукция предприятия по ОГРН
// ЗАПУСКАТЬ С ВЫКЛЮЧЕННЫМ VPN (госсайт режет зарубежные/DC IP).
//   node scripts/fetch-gisp-enrich.js
// Итог: scripts/data/registry-gisp-enrich.json. Обрыв не страшен: чекпойнт каждые 200 записей,
// повторный запуск продолжает с места обрыва.
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const BASE = 'https://gisp.gov.ru';
const CATALOG_URL = BASE + '/company-catalog/';
const REGISTRY = path.join(__dirname, 'data', 'registry-gisp.json');
const OUT = path.join(__dirname, 'data', 'registry-gisp-enrich.json');
const TEST_OGRN = '1037739986030'; // АНО «АВТЕХ» — по ней проверен формат RPC
const LIST_PAGE = 1000;
const PRODUCTS_LIMIT = 10;
const DELAY_MS = 350;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadJson(file, dflt) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

(async () => {
    const registry = loadJson(REGISTRY, null);
    if (!registry) { console.error('Нет', REGISTRY, '— сначала fetch-gisp-browser.js'); process.exit(1); }
    const ourInns = new Set(registry.map(r => r.inn));
    console.log(`Заводов в реестре: ${registry.length}`);

    // Чекпойнт: { contacts: {inn: {...}}, products: {ogrn: "..."} }
    const state = loadJson(OUT, { contacts: {}, products: {}, listDone: false });
    console.log(`Чекпойнт: контактов ${Object.keys(state.contacts).length}, продукций ${Object.keys(state.products).length}`);
    const save = () => fs.writeFileSync(OUT, JSON.stringify(state));

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    console.log('Открываю', CATALOG_URL, '(нужен ВЫКЛЮЧЕННЫЙ VPN)...');
    await page.goto(CATALOG_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);

    // JSON-RPC изнутри страницы (куки/происхождение — как у самой SPA)
    async function rpc(method, params) {
        return page.evaluate(async ({ method, params }) => {
            const body = [{ jsonrpc: '2.0', method, params, id: method + '.' + btoa(unescape(encodeURIComponent(JSON.stringify(params)))) }];
            const r = await fetch('/company-catalog/rpc?' + method, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify(body),
            });
            const text = await r.text();
            try {
                const arr = JSON.parse(text);
                const one = Array.isArray(arr) ? arr[0] : arr;
                return { ok: true, result: one.result, error: one.error || null };
            } catch { return { ok: false, head: text.slice(0, 300) }; }
        }, { method, params });
    }

    // Самопроверка формата на известном ОГРН
    const test = await rpc('company.productsByOGRN', { where: { onlyRussian: false, ogrn: TEST_OGRN }, limit: 3, offset: 0 });
    if (!test.ok || !test.result || !Array.isArray(test.result.rows)) {
        console.error('Самопроверка RPC провалилась:', JSON.stringify(test).slice(0, 500));
        console.error('Формат бэкенда изменился — нужна новая разведка.');
        await browser.close();
        process.exit(1);
    }
    console.log(`Самопроверка ok (продукций у тестовой организации: ${test.result.count ?? test.result.rows.length})`);

    // ===== Этап 1: контакты через company.list (весь каталог страницами) =====
    if (!state.listDone) {
        console.log('Этап 1: company.list...');
        let offset = 0, total = Infinity, matched = Object.keys(state.contacts).length;
        while (offset < total) {
            const res = await rpc('company.list', { where: {}, limit: LIST_PAGE, offset });
            if (!res.ok || !res.result) { console.error('  сбой на offset', offset, '— повтор через 5с'); await sleep(5000); continue; }
            total = res.result.count;
            const rows = res.result.rows || [];
            if (!rows.length) break;
            for (const c of rows) {
                if (!ourInns.has(c.inn)) continue;
                state.contacts[c.inn] = {
                    email: (c.email || '').trim().toLowerCase(),
                    site: (c.site && c.site !== 'Нет') ? String(c.site).trim() : '',
                    phone: (c.contactPhone || '').trim(),
                    shortName: (c.shortName || '').trim(),
                    okved: c.okved2Main || '',
                    ogrn: c.ogrn || '',
                };
                matched++;
            }
            offset += rows.length;
            console.log(`  ${offset}/${total}, наших найдено: ${matched}`);
            save();
            await sleep(DELAY_MS);
        }
        state.listDone = true;
        save();
        console.log(`Этап 1 готов: контактных записей ${Object.keys(state.contacts).length}`);
    } else {
        console.log('Этап 1 уже сделан (чекпойнт) — пропускаю.');
    }

    // ===== Этап 2: продукция по ОГРН =====
    const todo = registry.filter(r => r.ogrn && !(r.ogrn in state.products));
    console.log(`Этап 2: продукция, осталось ${todo.length} из ${registry.length}`);
    let done = 0, fails = 0;
    for (const r of todo) {
        let res = await rpc('company.productsByOGRN', { where: { onlyRussian: false, ogrn: r.ogrn }, limit: PRODUCTS_LIMIT, offset: 0 });
        if (!res.ok || !res.result) {
            await sleep(3000);
            res = await rpc('company.productsByOGRN', { where: { onlyRussian: false, ogrn: r.ogrn }, limit: PRODUCTS_LIMIT, offset: 0 });
        }
        if (res.ok && res.result && Array.isArray(res.result.rows)) {
            const names = res.result.rows.map(p => String(p.product_name || '').trim()).filter(Boolean);
            state.products[r.ogrn] = names.join('; ');
        } else {
            state.products[r.ogrn] = '';
            fails++;
        }
        done++;
        if (done % 200 === 0) { save(); console.log(`  ${done}/${todo.length} (сбоев: ${fails})`); }
        await sleep(DELAY_MS);
    }
    save();
    await browser.close();

    const withEmail = Object.values(state.contacts).filter(c => c.email).length;
    const withProducts = Object.values(state.products).filter(Boolean).length;
    console.log('Готово:', OUT);
    console.log(`  контактов: ${Object.keys(state.contacts).length}, из них с email: ${withEmail}`);
    console.log(`  с продукцией: ${withProducts} из ${Object.keys(state.products).length}`);
    console.log('Дальше: node scripts/import-enrich.js --dry-run');
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
