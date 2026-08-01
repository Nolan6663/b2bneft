'use strict';

// Снимает публичные страницы на телефоне и десктопе. Нужен, чтобы вёрстку
// смотреть глазами, а не гадать по CSS: карта в июле трижды чинилась вслепую.
//
//   node scripts/shoot-pages.js https://texzakaz.ru before
//   node scripts/shoot-pages.js http://localhost:3000 after
//
// Кроме снимка печатает переполнение по горизонтали — самый частый косяк на 390.

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Третье поле — файл на диске: с ним же скрипт работает и без сервера,
// `node scripts/shoot-pages.js file local`. Локальная база протухшая, сервер
// не поднимается, а каркас страницы по file:// виден целиком.
const PAGES = [
    ['landing', '/', 'landing.html'],
    ['zakupki', '/zakupki', 'zakupki.html'],
    ['armatura', '/zakupki/armatura', 'zakupki/armatura.html'],
    ['elektro', '/zakupki/elektro', 'zakupki/elektro.html'],
    ['metall', '/zakupki/metall', 'zakupki/metall.html'],
    ['rti', '/zakupki/rti', 'zakupki/rti.html'],
    ['catalog', '/catalog', 'catalog.html'],
    ['map', '/map', 'map.html'],
    ['supplier-public', '/supplier/1', 'supplier-public.html'],
    ['dlya-postavshchikov', '/dlya-postavshchikov', 'dlya-postavshchikov.html'],
    ['partners', '/partners', 'partners.html'],
    ['tariff', '/tariff', 'tariff.html'],
    ['delivery', '/delivery', 'delivery.html'],
    ['privacy', '/privacy', 'privacy.html'],
    ['terms', '/terms', 'terms.html'],
    ['login', '/login', 'login.html'],
    ['404', '/no-such-page', '404.html'],
];
const WIDTHS = [390, 1440];

(async () => {
    const base = (process.argv[2] || 'https://texzakaz.ru').replace(/\/$/, '');
    const label = process.argv[3] || 'shots';
    const outDir = path.join(__dirname, '..', '.shots', label);
    fs.mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch();
    const problems = [];

    const fromDisk = base === 'file';

    for (const width of WIDTHS) {
        for (const [name, route, file] of PAGES) {
            // Свой контекст на страницу: в общем контексте живые опросы и сокеты
            // прошлых страниц копятся и снимок начинает виснуть на шестой-седьмой.
            const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
            const page = await ctx.newPage();
            const url = fromDisk
                ? 'file:///' + path.join(__dirname, '..', file).replace(/\\/g, '/')
                : base + route;
            try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
            } catch {
                // networkidle не наступает на страницах с живой картой и опросами
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            }
            await page.waitForTimeout(900);

            // Гостя с /catalog редиректит на /login уже из скрипта. Снимок во время
            // такого перехода зависает намертво — ждём, пока адрес перестанет меняться.
            let seen = page.url();
            for (let i = 0; i < 6; i++) {
                await page.waitForTimeout(500);
                if (page.url() === seen) break;
                seen = page.url();
            }
            const settled = decodeURI(seen);
            const asked = decodeURI(url);
            const toLogin = settled !== asked && /\/login(\.html)?$/.test(settled);

            // Гостя с закрытых страниц перекидывает на вход клиентским скриптом.
            // Кадр такой страницы Chromium не отдаёт вообще — рендерер остаётся с
            // висящей навигацией, и снимок висит до таймаута. Не снимаем и не
            // роняем прогон: для гостевого прохода это факт, а не сбой.
            if (toLogin) {
                console.log(`${name} ${width}: требует входа, снимок пропущен`);
                await ctx.close();
                continue;
            }
            if (settled !== asked) console.log(`${name} ${width}: редирект на ${settled}`);

            // Блоки с появлением по скроллу до срабатывания наблюдателя стоят
            // прозрачными, но место занимают: без прокрутки снимок показывает
            // пустые полосы там, где у живого посетителя контент.
            await page.evaluate(async () => {
                const step = Math.round(window.innerHeight * 0.8);
                for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
                    window.scrollTo(0, y);
                    await new Promise(r => setTimeout(r, 120));
                }
                window.scrollTo(0, 0);
                await new Promise(r => setTimeout(r, 300));
            });

            const shot = path.join(outDir, `${name}-${width}.png`);
            let shotOk = true;
            try {
                // animations: disabled — иначе бесконечные спиннеры не дают снимку завершиться
                await page.screenshot({ path: shot, fullPage: true, animations: 'disabled', timeout: 20000 });
            } catch {
                // Страница, на которую гостя перекинул клиентский редирект, не отдаёт
                // кадр вообще: рендерер остаётся с висящей навигацией. Не роняем прогон
                // из-за одной страницы — метрики ниже всё равно снимаются.
                shotOk = false;
                problems.push(`${name} ${width}: снимок не снялся (адрес ${seen})`);
                console.log(`${name} ${width}: снимок не снялся`);
            }

            const overflow = await page.evaluate(() => {
                const doc = document.documentElement;
                const over = doc.scrollWidth - doc.clientWidth;
                if (over <= 0) return { over: 0, culprits: [] };
                const culprits = [];
                for (const el of document.querySelectorAll('body *')) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.right <= doc.clientWidth + 1) continue;
                    culprits.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} +${Math.round(r.right - doc.clientWidth)}px`);
                    if (culprits.length >= 5) break;
                }
                return { over, culprits };
            });

            if (overflow.over > 0) {
                problems.push(`${name} ${width}: +${overflow.over}px — ${overflow.culprits.join(', ')}`);
                console.log(`${name} ${width}: HORIZONTAL SCROLL +${overflow.over}px`);
                for (const c of overflow.culprits) console.log(`    ${c}`);
            } else if (shotOk) {
                console.log(`${name} ${width}: ok`);
            }

            await ctx.close();
        }
    }

    await browser.close();

    console.log(`\nСнимки: .shots/${label}`);
    if (problems.length) {
        console.log(`Горизонтальный скролл на ${problems.length} экранах:`);
        for (const p of problems) console.log('  ' + p);
        process.exitCode = 1;
    }
})();
