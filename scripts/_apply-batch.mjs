import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PARTIAL = path.join(ROOT, 'partials', 'sidebar.html');

const PAGES = {
    'catalog.html': 'catalog.html',
    'proposals.html': 'proposals.html',
    'deliveries.html': 'deliveries.html',
    'partners.html': 'partners.html',
    'analytics.html': 'analytics.html',
    'messages.html': 'messages.html',
    'favorites.html': 'favorites.html',
    'map.html': 'map.html',
    'tariff.html': 'settings.html',
    'company-profile.html': '#sidebarProfileLink',
    'delivery.html': 'deliveries.html',
};

function markActive(sidebar, target) {
    let html = sidebar.replace(/\sclass="active"/g, '');
    if (target.startsWith('#')) {
        const id = target.slice(1);
        const re = new RegExp(`(<a\\s)([^>]*\\bid="${id}"[^>]*)>`, 'i');
        html = html.replace(re, '$1class="active" $2>');
    } else {
        const re = new RegExp(`(<a\\s)([^>]*href="${target}"[^>]*)>`, 'i');
        html = html.replace(re, '$1class="active" $2>');
    }
    return html;
}

function injectSidebar(filePath, sidebar) {
    let html = fs.readFileSync(filePath, 'utf8');
    const anchor = '<div id="spa-content"';
    const idx = html.indexOf(anchor);
    if (idx === -1) return false;
    const start = html.lastIndexOf('<div class="sidebar">', idx);
    if (start === -1) return false;
    fs.writeFileSync(filePath, html.slice(0, start) + sidebar.trim() + '\n\n    ' + html.slice(idx), 'utf8');
    return true;
}

const base = fs.readFileSync(PARTIAL, 'utf8');
const updated = [];

for (const [page, active] of Object.entries(PAGES)) {
    const filePath = path.join(ROOT, page);
    const html = fs.readFileSync(filePath, 'utf8');
    if (!html.includes('sidebar-nav-group')) {
        if (injectSidebar(filePath, markActive(base, active))) updated.push(page);
    }
}

for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
    const filePath = path.join(ROOT, file);
    let html = fs.readFileSync(filePath, 'utf8');
    const next = html.replace(/href="assets\/theme-v2\.css(?:\?v=\d+)?"/g, 'href="assets/theme-v2.css?v=7"');
    if (next !== html) {
        fs.writeFileSync(filePath, next, 'utf8');
        if (!updated.includes(file)) updated.push(file);
    }
}

fs.writeFileSync(path.join(ROOT, 'batch-update-log.txt'), updated.sort().join('\n') + '\n');
console.log(updated.sort().join('\n'));
