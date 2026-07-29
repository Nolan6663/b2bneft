#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { LEGAL, FOOTER_EXCLUDE } = require('./legal-data');

const ROOT = path.join(__dirname, '..');
const PARTIAL = path.join(ROOT, 'partials', 'footer.html');
const START = '<!-- legal-footer:start -->';
const END = '<!-- legal-footer:end -->';

function renderFooter(template, legal, year) {
    return template
        .replace(/\{\{ORG_NAME\}\}/g, legal.orgName)
        .replace(/\{\{INN\}\}/g, legal.inn)
        .replace(/\{\{OGRNIP\}\}/g, legal.ogrnip)
        .replace(/\{\{ADDRESS\}\}/g, legal.address)
        .replace(/\{\{EMAIL\}\}/g, legal.email)
        .replace(/\{\{YEAR\}\}/g, String(year));
}

/** Идемпотентно: первый прогон вставляет блок с маркерами перед </body>,
 *  последующие — заменяют содержимое между маркерами. */
function applyFooter(html, footerHtml) {
    const block = `${START}\n${footerHtml.trim()}\n${END}`;
    const from = html.indexOf(START);
    const to = html.indexOf(END);
    if (from !== -1 && to !== -1) {
        return html.slice(0, from) + block + html.slice(to + END.length);
    }
    const bodyEnd = html.lastIndexOf('</body>');
    if (bodyEnd === -1) return html;
    return html.slice(0, bodyEnd) + block + '\n' + html.slice(bodyEnd);
}

/** Футер идёт на страницы без сайдбара: со сайдбаром — компоновка кабинета, футер её ломает.
 *  Плюс явные исключения из legal-data.js. */
function footerPages(root) {
    const rootPages = fs.readdirSync(root)
        .filter(f => f.endsWith('.html'))
        .filter(f => !FOOTER_EXCLUDE.has(f))
        .filter(f => !fs.readFileSync(path.join(root, f), 'utf8').includes('<div class="sidebar">'));

    const catDir = path.join(root, 'zakupki');
    const catPages = fs.existsSync(catDir)
        ? fs.readdirSync(catDir).filter(f => f.endsWith('.html')).map(f => path.join('zakupki', f))
        : [];

    return [...rootPages, ...catPages].sort();
}

function syncAll(root) {
    const template = fs.readFileSync(PARTIAL, 'utf8');
    const footer = renderFooter(template, LEGAL, new Date().getFullYear());
    const pages = footerPages(root);
    const changed = [];
    for (const page of pages) {
        const file = path.join(root, page);
        const before = fs.readFileSync(file, 'utf8');
        const after = applyFooter(before, footer);
        if (after !== before) {
            fs.writeFileSync(file, after, 'utf8');
            changed.push(page);
        }
    }
    return { changed, total: pages.length };
}

module.exports = { renderFooter, applyFooter, footerPages, syncAll, START, END };

if (require.main === module) {
    const { changed, total } = syncAll(ROOT);
    console.log(`Footer synced: ${changed.length} changed of ${total} pages`);
    changed.forEach(p => console.log('  ' + p));
}
