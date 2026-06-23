'use strict';

const { test, expect } = require('@playwright/test');

test.describe('Гость', () => {
    test('лендинг открывается', async ({ page }) => {
        await page.goto('/landing.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toBeVisible();
    });

    for (const url of ['/catalog.html', '/proposals.html', '/deals.html', '/admin.html']) {
        test(`${url} редиректит гостя на login`, async ({ page }) => {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await expect(page).toHaveURL(/login\.html/, { timeout: 30000 });
        });
    }
});
