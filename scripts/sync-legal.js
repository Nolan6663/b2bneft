#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { LEGAL, DOC_YEAR, FOOTER_EXCLUDE } = require('./legal-data');

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

/** Рабочая копия может быть выкачана с CRLF (core.autocrlf=true, .gitattributes нет),
 *  а блок ниже склеивается через '\n'. Сравнивать «изменилось ли» можно только
 *  на нормализованных переводах строк, иначе байт-корректные страницы числятся устаревшими. */
function normalizeEol(text) {
    return text.replace(/\r\n/g, '\n');
}

/** Есть ли куда вставить футер: либо маркеры, либо закрывающий </body>.
 *  Без этого applyFooter молча вернёт страницу как есть, и синк отчитается «всё синхронно». */
function hasFooterAnchor(html) {
    return (html.includes(START) && html.includes(END)) || html.lastIndexOf('</body>') !== -1;
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
    const footer = renderFooter(template, LEGAL, DOC_YEAR);
    const pages = footerPages(root);
    const changed = [];
    const anchorless = [];
    for (const page of pages) {
        const file = path.join(root, page);
        const before = fs.readFileSync(file, 'utf8');
        if (!hasFooterAnchor(before)) {
            anchorless.push(page);
            continue;
        }
        const after = applyFooter(before, footer);
        if (normalizeEol(after) !== normalizeEol(before)) {
            fs.writeFileSync(file, after, 'utf8');
            changed.push(page);
        }
    }
    return { changed, anchorless, total: pages.length };
}

module.exports = {
    renderFooter, applyFooter, footerPages, syncAll,
    normalizeEol, hasFooterAnchor, START, END,
};

if (require.main === module) {
    const { changed, anchorless, total } = syncAll(ROOT);
    console.log(`Footer synced: ${changed.length} changed of ${total} pages`);
    changed.forEach(p => console.log('  ' + p));
    if (anchorless.length) {
        console.error('Некуда вставить футер — нет ни маркеров, ни </body>:');
        anchorless.forEach(p => console.error('  ' + p));
        process.exitCode = 1;
    }
}
