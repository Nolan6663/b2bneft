'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

/* Подсказки под полями заявки: тексты лежат в assets/onboarding-hints.js и
   используются двумя формами — модалкой кабинета и гостевым мастером. Тест
   ловит два случая: подсказка пропала и тексты в двух формах разъехались.

   Кабинет заказчика требует настоящей сессии (серверная кука), её готовит
   global-setup из TEST_CUSTOMER_*. Без кредов пропускаем: админа в кабинет
   заказчика не пускают, а localStorage без куки страницу не открывает. */

const customerFile = path.join(__dirname, 'customer-storage.json');
const hasCustomer = fs.existsSync(customerFile);

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
    test.skip(!hasCustomer, 'нет сессии заказчика: задайте TEST_CUSTOMER_EMAIL и TEST_CUSTOMER_PASSWORD');
    test.use({ storageState: hasCustomer ? customerFile : undefined });

    /* Тур глушим: он стартует сам и накрывает форму оверлеем — здесь проверяем
       подсказки, а сам тур живёт в onboarding-tour.spec.js */
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('ob_welcome_v2', '1');
            localStorage.setItem('ob_tour_done_v1', '1');
        });
    });

    test('в модалке кабинета подсказка есть под каждым полем', async ({ page }) => {
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        await page.click('#createOrderBtn');
        await page.waitForTimeout(500);

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
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        await page.click('#createOrderBtn');
        await page.waitForTimeout(500);
        const cabinet = await page.evaluate(collectHints);

        await page.goto('/zayavka', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const wizard = await page.evaluate(collectHints);

        const shared = Object.keys(cabinet).filter(k => k in wizard);
        expect(shared.length, 'формы не делят ни одного поля — проверка бессмысленна').toBeGreaterThan(3);
        for (const key of shared) {
            expect(wizard[key].text, `тексты подсказки «${key}» разъехались между формами`)
                .toBe(cabinet[key].text);
        }
    });
});

test.describe('Гостевой мастер', () => {
    test('на /zayavka подсказки подключены и без входа', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('/zayavka', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);

        const hasModule = await page.evaluate(() => typeof window.applyFieldHints === 'function');
        expect(hasModule, 'assets/onboarding-hints.js не подключён').toBe(true);

        const hints = await page.evaluate(collectHints);
        const filled = Object.values(hints).filter(h => h.text && h.text.length > 10);
        expect(filled.length, 'в мастере не отрисовалось ни одной подсказки').toBeGreaterThanOrEqual(5);
        expect(errors, `JS-ошибки: ${errors.join(', ')}`).toHaveLength(0);
    });
});
