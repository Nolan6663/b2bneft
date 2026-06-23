'use strict';

const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'admin@platform.ru';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin2025';

async function fillLoginForm(page, email, password) {
    await page.fill('#authEmail', email);
    await page.fill('#authPassword', password);
    await page.click('#btnSubmit');
}

test.describe('Авторизация', () => {
    test('логин с неверным паролем показывает ошибку', async ({ page }) => {
        await page.goto('/login.html');
        await fillLoginForm(page, ADMIN_EMAIL, 'wrong-password');
        await expect(page.locator('#toastContainer')).toBeVisible({ timeout: 5000 });
    });

    test('логин администратора — попадает в admin.html', async ({ page }) => {
        await page.goto('/login.html');
        await fillLoginForm(page, ADMIN_EMAIL, ADMIN_PASSWORD);
        await expect(page).toHaveURL(/admin\.html/, { timeout: 45000 });
        await expect(page).toHaveURL(/admin\.html/);
    });

    test('logout возвращает на login', async ({ page }) => {
        await page.goto('/login.html');
        await fillLoginForm(page, ADMIN_EMAIL, ADMIN_PASSWORD);
        await expect(page).toHaveURL(/admin\.html/, { timeout: 45000 });
        await page.click('button:has-text("Выйти")');
        await page.waitForURL('**/login.html', { timeout: 5000 });
        await expect(page).toHaveURL(/login\.html/);
    });
});
