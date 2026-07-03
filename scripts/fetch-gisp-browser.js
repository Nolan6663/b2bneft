'use strict';
// Выгрузка перечня производителей ГИСП ПП-719 через настоящий браузер (Playwright):
// сайт — SPA (DevExtreme grid) с CSRF/HMAC, простой fetch отдаёт только HTML-оболочку.
// ЗАПУСКАТЬ С ВЫКЛЮЧЕННЫМ VPN (госсайт режет зарубежные/DC IP).
//   Разведка:  node scripts/fetch-gisp-browser.js --recon
//   Выгрузка:  node scripts/fetch-gisp-browser.js --pages 80
//     (80 страниц по 100 записей ≈ весь перечень ~7500; итог в scripts/data/registry-gisp.json)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('@playwright/test');

const URL = 'https://gisp.gov.ru/pp719v2/pub/org/';
const OUT = path.join(__dirname, 'data', 'registry-gisp.json');
const ROOT = path.join(__dirname, '..');
// Разведфайлы — во временную папку: в корне репо их подхватывает static-checks
const RECON_DIR = os.tmpdir();

function argNum(name, dflt) {
    const i = process.argv.indexOf(name);
    return i > -1 ? Number(process.argv[i + 1]) : dflt;
}

// Строки грида: Наименование | ИНН (10/12 цифр) | ОГРН (13/15 цифр) | Субъект РФ
async function scrapeVisibleRows(page) {
    return page.evaluate(() => {
        const out = [];
        const rows = document.querySelectorAll('table tr, [role="row"]');
        for (const row of rows) {
            const cells = [...row.querySelectorAll('td, [role="gridcell"]')]
                .map(c => c.textContent.trim());
            if (cells.length < 3) continue;
            const innIdx = cells.findIndex(c => /^\d{10}(\d{2})?$/.test(c.replace(/\s/g, '')));
            if (innIdx === -1) continue;
            const name = cells.find((c, i) => i !== innIdx && c.length > 5 && !/^\d[\d\s]*$/.test(c));
            if (!name) continue;
            const after1 = (cells[innIdx + 1] || '').replace(/\s/g, '');
            const ogrn = /^\d{13}(\d{2})?$/.test(after1) ? after1 : '';
            const city = (ogrn ? cells[innIdx + 2] : cells[innIdx + 1]) || '';
            out.push({
                company: name,
                inn: cells[innIdx].replace(/\s/g, ''),
                city: city.trim(),
                specialization: '',
                ogrn,
            });
        }
        return out;
    });
}

async function clickNextPage(page) {
    return page.evaluate(() => {
        const pages = [...document.querySelectorAll('.dx-pages .dx-page')];
        const cur = pages.findIndex(p => p.classList.contains('dx-selection'));
        const next = cur > -1 ? pages[cur + 1] : null;
        if (next) { next.click(); return true; }
        return false;
    });
}

(async () => {
    const recon = process.argv.includes('--recon');
    const pages = argNum('--pages', 80);

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();

    const netLog = [];
    page.on('response', async res => {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json') && !res.url().includes('static/')) {
            let preview = '';
            try { preview = (await res.text()).slice(0, 800); } catch {}
            netLog.push(`${res.status()} ${res.url()}\n${preview}\n${'-'.repeat(60)}`);
        }
    });

    console.log('Открываю', URL, '(нужен ВЫКЛЮЧЕННЫЙ VPN)...');
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000); // SPA догружает данные

    if (process.argv.includes('--org-recon')) {
        // Карточка предприятия: клик по действию «Предприятие» первой строки
        const link = page.locator('a:has-text("Предприятие"), button:has-text("Предприятие")').first();
        if (!(await link.count())) { console.log('Ссылка «Предприятие» не найдена'); await browser.close(); return; }
        await link.click();
        await page.waitForTimeout(6000);
        fs.writeFileSync(path.join(RECON_DIR, 'gisp-org.html'), await page.content());
        await page.screenshot({ path: path.join(RECON_DIR, 'gisp-org.png'), fullPage: true });
        fs.writeFileSync(path.join(RECON_DIR, 'gisp-org-net.txt'), netLog.join('\n') || '(JSON не пойман)');
        console.log('URL карточки:', page.url());
        console.log('Сохранено в', RECON_DIR, ': gisp-org.html, gisp-org.png, gisp-org-net.txt');
        await browser.close();
        return;
    }

    if (recon) {
        fs.writeFileSync(path.join(RECON_DIR, 'gisp-recon.html'), await page.content());
        await page.screenshot({ path: path.join(RECON_DIR, 'gisp-recon.png'), fullPage: false });
        fs.writeFileSync(path.join(RECON_DIR, 'gisp-recon-net.txt'), netLog.join('\n') || '(JSON-ответов не поймано)');
        const rows = await scrapeVisibleRows(page);
        console.log(`Разведка: снято строк с первой страницы: ${rows.length}`);
        console.log('Сохранено в', RECON_DIR, ': gisp-recon.html, gisp-recon.png, gisp-recon-net.txt');
        await browser.close();
        return;
    }

    // Крупнее страница — меньше кликов по госсайту
    const size100 = page.locator('.dx-page-size[aria-label="Display 100 items on page"]').first();
    if (await size100.count()) {
        await size100.click();
        await page.waitForTimeout(4000);
        console.log('Размер страницы: 100');
    }

    let all = [];
    const seen = new Set();
    for (let p = 0; p < pages; p++) {
        const batch = await scrapeVisibleRows(page);
        const before = all.length;
        for (const r of batch) if (!seen.has(r.inn)) { all.push(r); seen.add(r.inn); }
        console.log(`страница ${p + 1}: +${all.length - before} (всего ${all.length})`);
        if (p + 1 >= pages) break;
        if (!(await clickNextPage(page))) { console.log('Следующей страницы нет — стоп.'); break; }
        await page.waitForTimeout(1500); // вежливо к госресурсу
    }

    fs.writeFileSync(OUT, JSON.stringify(all, null, 1));
    console.log(`Сохранено ${all.length} записей → ${OUT}`);
    console.log(`Дальше: node scripts/import-registry.js ${path.relative(ROOT, OUT)} --dry-run`);
    await browser.close();
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
