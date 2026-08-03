'use strict';

const path = require('path');
const { test, expect } = require('@playwright/test');

const storageFile = path.join(__dirname, 'admin-storage.json');

/* Подсказки под полями заявки: тексты лежат в assets/onboarding-hints.js и
   используются двумя формами — модалкой кабинета и гостевым мастером. Тест
   ловит два случая: подсказка пропала и тексты в двух формах разъехались. */

const collectHints = () => {
    const out = {};
    document.querySelectorAll('[data-hint]').forEach((el) => {
        const group = el.closest('.form-group, .ob-field') || el.parentElement;
        const hint = group && group.querySelector(':scope > .form-hint');
        out[el.dataset.hint] = {
            text: hint ? hint.textContent.trim() : null,
            /* подсказка должна стоять под полем, а не над ним: кастомный селект
               подменяет <select> своим виджетом и легко уводит её вверх */
            below: hint ? hint.getBoundingClientRect().top >= el.getBoundingClientRect().bottom - 2 : false,
        };
    });
    return out;
};

test.describe('Подсказки в форме заявки', () => {
    test('в модалке кабинета подсказка есть под каждым полем', async ({ page }) => {
        await page.context().addInitScript(() => {
            localStorage.setItem('isLoggedIn', '1');
            localStorage.setItem('userRole', 'customer');
            localStorage.setItem('ob_welcome_v2', '1');
            localStorage.setItem('ob_tour_done_v1', '1');
        });
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        await page.click('#createOrderBtn');
        await page.waitForTimeout(400);

        const hints = await page.evaluate(collectHints);
        const keys = Object.keys(hints);
        expect(keys.length, 'в модалке должны быть поля с data-hint').toBeGreaterThanOrEqual(6);
        for (const key of keys) {
            expect(hints[key].text, `нет подсказки у поля ${key}`).toBeTruthy();
            expect(hints[key].text.length, `подсказка у ${key} слишком короткая`).toBeGreaterThan(10);
            expect(hints[key].below, `подсказка у ${key} стоит выше самого поля`).toBe(true);
        }

        const nextSteps = await page.locator('#orderNextList li').count();
        expect(nextSteps, 'блок «что будет после публикации» пуст').toBe(3);
    });

    test('тексты подсказок в мастере и в кабинете совпадают', async ({ page }) => {
        await page.context().addInitScript(() => {
            localStorage.setItem('isLoggedIn', '1');
            localStorage.setItem('userRole', 'customer');
            localStorage.setItem('ob_welcome_v2', '1');
            localStorage.setItem('ob_tour_done_v1', '1');
        });
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        await page.click('#createOrderBtn');
        await page.waitForTimeout(400);
        const cabinet = await page.evaluate(collectHints);

        await page.goto('/zayavka', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        const wizard = await page.evaluate(collectHints);

        const shared = Object.keys(cabinet).filter(k => k in wizard);
        expect(shared.length, 'формы не делят ни одного поля — проверка бессмысленна').toBeGreaterThan(3);
        for (const key of shared) {
            expect(wizard[key].text, `тексты подсказки «${key}» разъехались между формами`)
                .toBe(cabinet[key].text);
        }
    });
});

test.describe('Подсказки видны админу на общей странице', () => {
    test.use({ storageState: storageFile });

    test('/index.html открывается без JS-ошибок с подключённым модулем подсказок', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const hasModule = await page.evaluate(() => typeof window.applyFieldHints === 'function');
        expect(hasModule, 'assets/onboarding-hints.js не подключён').toBe(true);
        expect(errors, `JS-ошибки: ${errors.join(', ')}`).toHaveLength(0);
    });
});
