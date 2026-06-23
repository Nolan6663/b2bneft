'use strict';

const path = require('path');
const { test, expect } = require('@playwright/test');

const storageFile = path.join(__dirname, 'admin-storage.json');

const PROTECTED_PAGES = [
    '/index.html', '/proposals.html', '/deals.html', '/messages.html',
    '/partners.html', '/favorites.html', '/settings.html', '/analytics.html',
    '/tariff.html', '/admin.html',
];

test.describe('Страницы не падают', () => {
    test.use({ storageState: storageFile });

    for (const url of PROTECTED_PAGES) {
        test(`${url} открывается без JS-ошибок`, async ({ page }) => {
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(url);
            await expect(page.locator('body')).toBeVisible();
            expect(errors, `JS-ошибки на ${url}: ${errors.join(', ')}`).toHaveLength(0);
        });
    }
});
