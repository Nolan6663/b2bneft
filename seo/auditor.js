'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function auditPage(filename) {
    const filepath = path.join(ROOT, filename);
    let html;
    try {
        html = fs.readFileSync(filepath, 'utf8');
    } catch (e) {
        return { page: filename, score: 0, issues: [{ type: 'read_error', severity: 'critical', message: `Не удалось прочитать файл: ${e.message}`, fix: 'Проверьте наличие и права доступа к файлу' }] };
    }
    const issues = [];
    let penalty = 0;

    function add(type, severity, message, fix, cost) {
        issues.push({ type, severity, message, fix });
        penalty += cost;
    }

    // <title>
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch || !titleMatch[1].trim()) {
        add('title_missing', 'critical', 'Тег <title> отсутствует', 'Добавьте <title> с описанием страницы (10–60 символов)', 20);
    } else {
        const len = titleMatch[1].trim().length;
        if (len < 10) add('title_short', 'critical', `<title> слишком короткий (${len} симв.)`, 'Напишите title длиной 10–60 символов', 20);
        else if (len > 60) add('title_long', 'warning', `<title> слишком длинный (${len} симв., обрежется в SERP)`, 'Сократите title до 60 символов', 5);
    }

    // meta description
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']/i);
    if (!descMatch) {
        add('desc_missing', 'critical', 'Meta description отсутствует', 'Добавьте <meta name="description" content="..."> длиной 50–160 символов', 20);
    } else {
        const len = descMatch[1].trim().length;
        if (len < 50) add('desc_short', 'warning', `Meta description короткий (${len} симв.)`, 'Расширьте description до 50–160 символов', 5);
        else if (len > 160) add('desc_long', 'warning', `Meta description длинный (${len} симв.)`, 'Сократите description до 160 символов', 5);
    }

    // <h1>
    const h1count = [...html.matchAll(/<h1[\s>]/gi)].length;
    if (h1count === 0) {
        add('h1_missing', 'critical', 'Тег <h1> отсутствует', 'Добавьте один <h1> с главным заголовком страницы', 20);
    } else if (h1count > 1) {
        add('h1_multiple', 'warning', `Несколько тегов <h1> (${h1count} шт.)`, 'Оставьте только один <h1> на странице', 5);
    }

    // noindex
    if (/<meta\s+name=["']robots["'][^>]*noindex/i.test(html)) {
        add('noindex', 'critical', 'Страница закрыта от индексации (robots: noindex)', 'Удалите noindex из meta robots', 20);
    }

    // canonical
    if (!/<link\s+rel=["']canonical["']/i.test(html)) {
        add('no_canonical', 'info', 'Нет тега canonical', 'Добавьте <link rel="canonical" href="https://домен/страница">', 2);
    }

    // OG tags
    if (!/<meta\s+property=["']og:title["']/i.test(html) || !/<meta\s+property=["']og:description["']/i.test(html)) {
        add('no_og', 'info', 'Отсутствуют OG-теги (og:title, og:description)', 'Добавьте Open Graph мета-теги для корректного отображения в соцсетях', 2);
    }

    // empty alt
    const emptyAlts = [...html.matchAll(/<img[^>]+alt=["']\s*["']/gi)].length;
    if (emptyAlts > 0) {
        add('empty_alt', 'warning', `${emptyAlts} изображений с пустым alt`, 'Заполните атрибут alt для каждого изображения', 5);
    }

    // internal links
    if ([...html.matchAll(/href=["'][^"'#]*\.html["']/gi)].length === 0) {
        add('no_internal_links', 'warning', 'Нет внутренних ссылок на другие страницы', 'Добавьте ссылки на связанные страницы для перелинковки', 5);
    }

    return { page: filename, score: Math.max(0, 100 - penalty), issues };
}

async function auditAll() {
    const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
    return files.map(f => auditPage(f));
}

module.exports = { auditAll, auditPage };
