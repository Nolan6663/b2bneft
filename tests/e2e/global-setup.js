'use strict';

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const baseURL  = process.env.E2E_BASE_URL  || 'https://b2bneft.onrender.com';
const email    = process.env.ADMIN_EMAIL    || 'admin@platform.ru';
const password = process.env.ADMIN_PASSWORD || 'Admin2025';

const storageFile = path.join(__dirname, 'admin-storage.json');

module.exports = async function globalSetup() {
    // Разбудить сервер
    console.log('\n  Пробуждение сервера...');
    const start = Date.now();
    for (let i = 0; i < 12; i++) {
        try {
            const res = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                console.log(`  Сервер готов (${((Date.now() - start) / 1000).toFixed(1)}s)`);
                break;
            }
        } catch { /* ещё спит */ }
        if (i === 11) throw new Error('Сервер не ответил за 90 секунд');
        await new Promise(r => setTimeout(r, 5000));
    }

    // Залогиниться один раз и сохранить сессию
    console.log('  Вход в систему...');
    const browser = await chromium.launch();
    const context = await browser.newContext({ baseURL });
    const page    = await context.newPage();

    await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
    await page.fill('#authEmail', email);
    await page.fill('#authPassword', password);
    await page.click('#btnSubmit');
    await page.waitForURL(/admin\.html/, { timeout: 30000 });

    await context.storageState({ path: storageFile });
    await browser.close();
    console.log('  Сессия сохранена\n');
};
