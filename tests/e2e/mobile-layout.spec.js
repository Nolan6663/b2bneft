'use strict';

const path = require('path');
const { test, expect } = require('@playwright/test');

const storageFile = path.join(__dirname, 'admin-storage.json');

const MOBILE = { width: 390, height: 844 };

const PAGES = ['/index.html', '/deliveries.html', '/deals.html', '/messages.html', '/map.html', '/analytics.html'];

/* Строка заголовка и таблицы кабинета на телефоне: заголовок не должен рваться
   посреди слова, таблица — либо влезать, либо прокручиваться, а соседние ячейки
   не должны стоять вплотную текст к тексту. */
const inspect = () => {
    const vw = document.documentElement.clientWidth;
    const textRect = (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        range.detach && range.detach();
        return r;
    };

    const titles = [...document.querySelectorAll('.header h2, .msg-header h2')]
        .filter(h => h.offsetParent !== null)
        .map((h) => {
            const cs = getComputedStyle(h);
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            const longestWord = h.textContent.trim().split(/\s+/)
                .reduce((max, w) => Math.max(max, canvas.measureText(w).width), 0);
            return {
                text: h.textContent.trim(),
                width: h.getBoundingClientRect().width,
                longestWord,
            };
        });

    const tables = [...document.querySelectorAll('.main-content table')]
        .filter(t => t.offsetParent !== null)
        .map((t) => {
            const parent = t.parentElement;
            const width = t.getBoundingClientRect().width;
            const glued = [];
            const ths = [...t.querySelectorAll('thead th')].filter(th => th.textContent.trim());
            for (let i = 1; i < ths.length; i++) {
                const prevText = textRect(ths[i - 1]);
                const cur = ths[i].getBoundingClientRect();
                const curText = textRect(ths[i]);
                if (curText.left - prevText.right < 6 && curText.width > 0 && prevText.width > 0) {
                    glued.push(`${ths[i - 1].textContent.trim()}|${ths[i].textContent.trim()}`);
                }
                void cur;
            }
            return {
                width,
                parentWidth: parent ? parent.clientWidth : vw,
                parentScrolls: parent ? parent.scrollWidth > parent.clientWidth + 1 : false,
                glued,
            };
        });

    return { vw, scrollW: document.documentElement.scrollWidth, titles, tables };
};

test.describe('Мобильная вёрстка кабинета (390px)', () => {
    test.use({ storageState: storageFile, viewport: MOBILE, isMobile: true, hasTouch: true });

    for (const url of PAGES) {
        test(`${url} — заголовок и таблицы не ломаются`, async ({ page }) => {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2500);
            const res = await page.evaluate(inspect);

            expect(res.scrollW, `${url}: страница шире экрана`).toBeLessThanOrEqual(res.vw + 1);

            for (const t of res.titles) {
                expect(t.width, `${url}: заголовку «${t.text}» не хватает ширины на самое длинное слово — рвётся посреди слова`)
                    .toBeGreaterThanOrEqual(t.longestWord - 1);
            }

            for (const t of res.tables) {
                expect(t.glued, `${url}: заголовки колонок стоят вплотную: ${t.glued.join(', ')}`).toHaveLength(0);
                if (t.width > t.parentWidth + 1) {
                    expect(t.parentScrolls, `${url}: таблица шире контейнера, но её нельзя прокрутить — колонки обрезаны`).toBe(true);
                }
            }
        });
    }

    test('/delivery.html — колонки схлопываются в одну', async ({ page }) => {
        // без ?id страница уходит на deals.html; данные для проверки сетки не нужны
        await page.goto('/delivery.html?id=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const tracks = await page.evaluate(() => {
            const el = document.querySelector('.delivery-layout');
            return el ? getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length : 0;
        });
        expect(tracks, 'на телефоне .delivery-layout должен быть в одну колонку').toBe(1);
    });
});
