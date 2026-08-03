'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

/* Тур по кабинету. Нужна настоящая сессия заказчика — её готовит global-setup
   из TEST_CUSTOMER_*; localStorage без серверной куки кабинет не открывает.
   Флаг «тур пройден» сбрасываем перед каждой навигацией. */

const customerFile = path.join(__dirname, 'customer-storage.json');
const hasCustomer = fs.existsSync(customerFile);

const resetTour = (page, { tourDone = false } = {}) => page.addInitScript(({ done }) => {
    localStorage.setItem('ob_welcome_v2', '1');
    if (done) localStorage.setItem('ob_tour_done_v1', '1');
    else localStorage.removeItem('ob_tour_done_v1');
}, { done: tourDone });

test.describe('Тур по кабинету', () => {
    test.skip(!hasCustomer, 'нет сессии заказчика: задайте TEST_CUSTOMER_EMAIL и TEST_CUSTOMER_PASSWORD');
    test.use({ storageState: hasCustomer ? customerFile : undefined });

    test('запускается сам при первом входе и проходится до конца', async ({ page }) => {
        await resetTour(page);
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });

        const card = page.locator('.tour-card');
        await expect(card, 'тур должен открыться после первого входа').toBeVisible({ timeout: 20000 });

        const total = Number((await page.locator('#tourCount').textContent()).match(/из (\d+)/)[1]);
        expect(total, 'в туре должен быть хотя бы один шаг').toBeGreaterThan(0);

        for (let i = 1; i < total; i++) {
            await page.click('#tourNext');
            await page.waitForTimeout(600);
            await expect(page.locator('#tourCount')).toContainText(`Шаг ${i + 1} из ${total}`);
        }

        await expect(page.locator('#tourNext'), 'последний шаг закрывается кнопкой «Готово»').toHaveText('Готово');
        await page.click('#tourNext');
        await expect(card).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem('ob_tour_done_v1'))).toBe('1');
    });

    test('«Пропустить» закрывает тур и он больше не появляется', async ({ page }) => {
        await resetTour(page);
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.tour-card')).toBeVisible({ timeout: 20000 });

        await page.click('#tourSkip');
        await expect(page.locator('.tour-card')).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem('ob_tour_done_v1'))).toBe('1');

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);
        await expect(page.locator('.tour-card'), 'пройденный тур не должен возвращаться').toHaveCount(0);
    });

    test('запускается повторно кнопкой «Как это работает»', async ({ page }) => {
        await resetTour(page, { tourDone: true });
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3500);
        await expect(page.locator('.tour-card'), 'сам по себе тур не стартует').toHaveCount(0);

        const started = await page.evaluate(() => window.startCabinetTour());
        expect(started, 'startCabinetTour должен найти хотя бы один якорь').toBe(true);
        await expect(page.locator('.tour-card')).toBeVisible();
    });

    test('шаг без якоря пропускается, тур не падает', async ({ page }) => {
        await resetTour(page, { tourDone: true });
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);

        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        const started = await page.evaluate(() => window.startTour([
            { selectors: ['#этого-элемента-нет'], title: 'Пропущенный', text: 'Не должен показаться' },
            { selectors: ['#createOrderBtn'], title: 'Живой шаг', text: 'Этот шаг остаётся' },
        ], {}));

        expect(started).toBe(true);
        await expect(page.locator('#tourTitle')).toHaveText('Живой шаг');
        await expect(page.locator('#tourCount')).toContainText('из 1');
        expect(errors, `JS-ошибки: ${errors.join(', ')}`).toHaveLength(0);
    });

    test('на телефоне карточка не уезжает под нижнюю панель', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await resetTour(page);
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.tour-card')).toBeVisible({ timeout: 20000 });

        const inside = await page.evaluate(() => {
            const r = document.querySelector('.tour-card').getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
        });
        expect(inside, 'карточка тура должна целиком помещаться в экран').toBe(true);
    });
});
