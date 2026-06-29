#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PARTIAL = path.join(ROOT, 'partials', 'sidebar.html');

const CABINET_PAGES = [
    'index.html', 'producer.html', 'catalog.html', 'proposals.html',
    'deals.html', 'deliveries.html', 'partners.html',
    'analytics.html', 'messages.html', 'favorites.html',
    'map.html', 'settings.html', 'tariff.html', 'admin.html',
    'company-profile.html', 'delivery.html',
];

/** Страница → селектор активного пункта меню */
const ACTIVE = {
    'index.html': '#mainCabinetLink',
    'producer.html': '#mainCabinetLink',
    'catalog.html': 'catalog.html',
    'proposals.html': 'proposals.html',
    'deals.html': 'deals.html',
    'deliveries.html': 'deliveries.html',
    'partners.html': 'partners.html',
    'analytics.html': 'analytics.html',
    'messages.html': 'messages.html',
    'favorites.html': 'favorites.html',
    'map.html': 'map.html',
    'settings.html': 'settings.html',
    'tariff.html': 'settings.html',
    'admin.html': 'admin.html',
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

function injectSidebar(filePath, sidebar) {
    let html = fs.readFileSync(filePath, 'utf8');
    const anchor = '<div id="spa-content"';
    const idx = html.indexOf(anchor);
    if (idx === -1) {
        console.warn('skip (no spa-content):', path.basename(filePath));
        return false;
    }
    const start = html.lastIndexOf('<div class="sidebar">', idx);
    if (start === -1) {
        console.warn('skip (no sidebar):', path.basename(filePath));
        return false;
    }
    const next = html.slice(0, start) + sidebar.trim() + '\n\n    ' + html.slice(idx);
    fs.writeFileSync(filePath, next, 'utf8');
    return true;
}

function main() {
    const base = fs.readFileSync(PARTIAL, 'utf8');
    let ok = 0;
    for (const page of CABINET_PAGES) {
        const filePath = path.join(ROOT, page);
        if (!fs.existsSync(filePath)) {
            console.warn('missing:', page);
            continue;
        }
        const sidebar = markActive(base, page);
        if (injectSidebar(filePath, sidebar)) {
            console.log('ok:', page);
            ok++;
        }
    }
    console.log(`\nSynced sidebar on ${ok}/${CABINET_PAGES.length} pages.`);
    fs.writeFileSync(path.join(ROOT, 'sync-log.txt'), `ok=${ok}\n${CABINET_PAGES.join('\n')}\n`, 'utf8');
}

main();
