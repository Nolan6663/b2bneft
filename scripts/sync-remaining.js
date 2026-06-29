#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PARTIAL = path.join(ROOT, 'partials', 'sidebar.html');
const PAGES = [
    'proposals.html', 'deliveries.html', 'partners.html', 'analytics.html',
    'messages.html', 'favorites.html', 'map.html', 'tariff.html',
    'company-profile.html', 'delivery.html',
];
const ACTIVE = {
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

function markActive(sidebar, pageFile) {
    let html = sidebar.replace(/\sclass="active"/g, '');
    const target = ACTIVE[pageFile];
    if (!target) return html;
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

function inject(filePath, sidebar) {
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
const log = [];
for (const page of PAGES) {
    const fp = path.join(ROOT, page);
    if (!fs.existsSync(fp)) { log.push('missing:' + page); continue; }
    const html = fs.readFileSync(fp, 'utf8');
    if (html.includes('sidebar-nav-group')) { log.push('skip:' + page); continue; }
    if (inject(fp, markActive(base, page))) log.push('ok:' + page);
    else log.push('fail:' + page);
}
fs.writeFileSync(path.join(ROOT, 'sync-remaining-log.txt'), log.join('\n') + '\n', 'utf8');
console.log(log.join('\n'));
