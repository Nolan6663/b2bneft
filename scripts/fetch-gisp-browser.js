'use strict';
// Выгрузка перечня производителей ГИСП ПП-719 через настоящий браузер (Playwright):
// сайт — SPA с CSRF/HMAC-токенами, простой fetch отдаёт только HTML-оболочку.
// ЗАПУСКАТЬ С ВЫКЛЮЧЕННЫМ VPN (госсайт режет зарубежные/DC IP).
//   Разведка:  node scripts/fetch-gisp-browser.js --recon
//     → сохраняет gisp-recon.html, gisp-recon.png, gisp-recon-net.txt в корень репо
//   Выгрузка:  node scripts/fetch-gisp-browser.js --pages 20
//     → scripts/data/registry-gisp.json (формат import-registry)
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const URL = 'https://gisp.gov.ru/pp719v2/pub/org/';
const OUT = path.join(__dirname, 'data', 'registry-gisp.json');
const ROOT = path.join(__dirname, '..');

function argNum(name, dflt) {
    const i = process.argv.indexOf(name);
    return i > -1 ? Number(process.argv[i + 1]) : dflt;
}

async function scrapeVisibleRows(page) {
    // Универсальный съём: строки таблиц, в которых встречается ИНН (10/12 цифр)
    return page.evaluate(() => {
        const out = [];
        const rows = document.querySelectorAll('table tr, [role="row"], .ag-row');
        for (const row of rows) {
            const cells = [...row.querySelectorAll('td, [role="gridcell"], .ag-cell')]
                .map(c => c.textContent.trim());
            if (!cells.length) continue;
            const innIdx = cells.findIndex(c => /^\d{10}(\d{2})?$/.test(c.replace(/\s/g, '')));
            if (innIdx === -1) continue;
            const name = cells.find((c, i) => i !== innIdx && c.length > 5 && !/^\d[\d\s]*$/.test(c)) || '';
            if (!name) continue;
            out.push({
                company: name,
                inn: cells[innIdx].replace(/\s/g, ''),
                city: cells[innIdx + 1] || '',
                specialization: '',
                ogrn: '',
            });
        }
        return out;
    });
}

(async () => {
    const recon = process.argv.includes('--recon');
    const pages = argNum('--pages', 5);

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();

    // Лог сетевых JSON-ответов — чтобы найти их внутренний API
    const netLog = [];
    page.on('response', async res => {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json') && !res.url().includes('cloudflare')) {
            let preview = '';
            try { preview = (await res.text()).slice(0, 800); } catch {}
            netLog.push(`${res.status()} ${res.url()}\n${preview}\n${'-'.repeat(60)}`);
        }
    });

    console.log('Открываю', URL, '(нужен ВЫКЛЮЧЕННЫЙ VPN)...');
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000); // SPA догружает данные

    if (recon) {
        fs.writeFileSync(path.join(ROOT, 'gisp-recon.html'), await page.content());
        await page.screenshot({ path: path.join(ROOT, 'gisp-recon.png'), fullPage: false });
        fs.writeFileSync(path.join(ROOT, 'gisp-recon-net.txt'), netLog.join('\n') || '(JSON-ответов не поймано)');
        const rows = await scrapeVisibleRows(page);
        console.log(`Разведка: снято строк с первой страницы: ${rows.length}`);
        console.log('Сохранено: gisp-recon.html, gisp-recon.png, gisp-recon-net.txt');
        await browser.close();
        return;
    }

    let all = [];
    for (let p = 0; p < pages; p++) {
        const batch = await scrapeVisibleRows(page);
        const before = all.length;
        const seen = new Set(all.map(r => r.inn));
        for (const r of batch) if (!seen.has(r.inn)) { all.push(r); seen.add(r.inn); }
        console.log(`страница ${p + 1}: +${all.length - before} (всего ${all.length})`);
        // Следующая страница: типовые кнопки пагинации
        const next = page.locator('a[aria-label="Next"], button[aria-label="Next"], .pagination-next, li.next a, [class*="pagination"] [class*="next"]').first();
        if (!(await next.count()) || !(await next.isEnabled().catch(() => false))) {
            console.log('Кнопка «дальше» не найдена/неактивна — стоп.');
            break;
        }
        await next.click();
        await page.waitForTimeout(2000); // вежливо к госресурсу
    }

    fs.writeFileSync(OUT, JSON.stringify(all, null, 1));
    console.log(`Сохранено ${all.length} записей → ${OUT}`);
    console.log(`Дальше: node scripts/import-registry.js ${path.relative(ROOT, OUT)} --dry-run`);
    await browser.close();
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
