#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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
    if (idx === -1) {
        console.error('skip (no spa-content):', path.basename(filePath));
        return false;
    }
    const start = html.lastIndexOf('<div class="sidebar">', idx);
    if (start === -1) {
        console.error('skip (no sidebar):', path.basename(filePath));
        return false;
    }
    const next = html.slice(0, start) + sidebar.trim() + '\n\n    ' + html.slice(idx);
    fs.writeFileSync(filePath, next, 'utf8');
    return true;
}

function bumpThemeCss(filePath) {
    let html = fs.readFileSync(filePath, 'utf8');
    const next = html.replace(
        /href="assets\/theme-v2\.css(?:\?v=\d+)?"/g,
        'href="assets/theme-v2.css?v=7"'
    );
    if (next !== html) {
        fs.writeFileSync(filePath, next, 'utf8');
        return true;
    }
    return false;
}

const base = fs.readFileSync(PARTIAL, 'utf8');
const updated = [];

for (const [page, active] of Object.entries(PAGES)) {
    const filePath = path.join(ROOT, page);
    const html = fs.readFileSync(filePath, 'utf8');
    if (html.includes('sidebar-nav-group')) {
        console.log('skip sidebar (already done):', page);
    } else {
        const sidebar = markActive(base, active);
        if (injectSidebar(filePath, sidebar)) {
            console.log('sidebar ok:', page);
            updated.push(page);
        }
    }
}

const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
for (const file of htmlFiles) {
    const filePath = path.join(ROOT, file);
    if (bumpThemeCss(filePath)) {
        console.log('css ok:', file);
        if (!updated.includes(file)) updated.push(file);
    }
}

fs.writeFileSync(path.join(ROOT, 'batch-update-log.txt'), updated.join('\n') + '\n', 'utf8');
console.log('\nUpdated:', updated.length, 'files');
