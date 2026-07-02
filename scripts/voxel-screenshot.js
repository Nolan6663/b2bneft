'use strict';
// Скриншот hero лендинга с воксельной картой. Пишет PNG в системный tmp.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('@playwright/test');

const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let f = path.join(root, urlPath === '/' ? 'landing.html' : urlPath);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const out = path.join(os.tmpdir(), 'voxel-hero.png');
    // NO_WEBGL=1 — проверка фолбэка (панель должна остаться скрытой, .lp-industrial видна)
    const browser = await chromium.launch({
        args: process.env.NO_WEBGL ? ['--disable-webgl', '--disable-webgl2'] : [],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log('[page]', m.text()); });
    await page.goto(`http://127.0.0.1:${port}/landing.html`);
    await page.waitForTimeout(2500); // дождаться анимации сборки
    const panel = page.locator('#lp-voxel-panel');
    const visible = await panel.isVisible();
    if (visible) await panel.screenshot({ path: out });
    else await page.screenshot({ path: out });
    console.log('panel visible:', visible, '→', out);
    await browser.close();
    server.close();
    process.exit(visible ? 0 : 1);
});
