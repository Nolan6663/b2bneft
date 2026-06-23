'use strict';

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e',
    globalSetup: './tests/e2e/global-setup.js',
    timeout: 60000,
    retries: 1,
    reporter: 'list',
    use: {
        baseURL: process.env.E2E_BASE_URL || 'https://b2bneft.onrender.com',
        headless: true,
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
});
