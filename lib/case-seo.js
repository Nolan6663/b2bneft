'use strict';

// Публичная страница кейса — ТЗ §9 и §3.6.
//
// Кейс отличается от страницы услуги тем, что он конкретен: не «мы умеем
// точение», а «вал Ø40 из стали 45, партия 200, допуск h7, сделали за 12 дней».
// Отсюда устройство страницы: сначала параметры, потом рассказ. Параметры — это
// и есть подтверждение компетенции, ради которого кейс существует; текст без
// них превращается в рекламную заметку.
//
// Имя заказчика попадает сюда только если исполнитель отдельно подтвердил
// разрешение (ТЗ §9.2). Решение принимается в lib/cases, здесь мы лишь
// показываем то, что уже разрешено.

const { esc, plural, fitTitle } = require('./cluster-seo');

const DESC_MAX = 160;

function buildTitle(c) {
    const company = String(c.company_name || '').trim();
    // Название предприятия в заголовке работает на доверие: человек видит, кто
    // именно это сделал, ещё в выдаче.
    return company
        ? fitTitle(c.title, ` — ${company}`, '')
        : fitTitle(c.title, '', ' — ТехЗаказ');
}

function buildDescription(c) {
    const facts = [];
    if (c.material) facts.push(String(c.material));
    if (c.quantity) facts.push(`${Number(c.quantity)} ${plural(Number(c.quantity), 'штука', 'штуки', 'штук')}`);
    if (c.tolerance) facts.push(`допуск ${c.tolerance}`);
    const head = facts.length ? `${c.title}: ${facts.join(', ')}. ` : `${c.title}. `;
    const tail = String(c.result || c.task || '').replace(/\s+/g, ' ').trim();
    const base = (head + tail).trim();
    return base.length <= DESC_MAX ? base : base.slice(0, DESC_MAX - 3).replace(/[\s,.;:]+$/, '') + '…';
}

function buildLead(c) {
    const who = String(c.company_name || '').trim();
    const what = String(c.product_name || '').trim();
    const parts = [];
    if (who) parts.push(`Выполнено: ${who}`);
    if (what) parts.push(`изделие — ${what}`);
    if (c.customer_named && c.customer_name) parts.push(`заказчик — ${c.customer_name}`);
    return parts.length ? parts.join(', ') + '.' : 'Выполненная работа предприятия каталога.';
}

/** Числовая часть кейса. Именно она подтверждает возможности, поэтому стоит
 *  на первом экране, а не в подвале. Пустые поля не выводятся: прочерк в
 *  карточке хуже отсутствия строки. */
function buildStats(c) {
    const stats = [
        [c.quantity, `${Number(c.quantity)} ${plural(Number(c.quantity), 'штука', 'штуки', 'штук')}`, 'тираж'],
        [c.material, c.material, 'материал'],
        [c.tolerance, c.tolerance, 'допуск'],
        [c.roughness, c.roughness, 'шероховатость'],
    ];
    return stats
        .filter(([has]) => has)
        .map(([, value, label]) => `<div class="zr-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
        .join('\n      ');
}

function section(title, text) {
    if (!text || !String(text).trim()) return '';
    const paragraphs = String(text).split(/\n{2,}/).map(p => `    <p>${esc(p.trim())}</p>`).join('\n');
    return `    <h2 class="zr-h2">${esc(title)}</h2>\n${paragraphs}\n`;
}

function buildBody(c, services) {
    const parts = [];

    /* Параметры изготовления таблицей: это то, что исполнитель ищет глазами,
       чтобы понять, сопоставима ли работа с его собственной. */
    const rows = [
        ['Изделие', c.product_name],
        ['Материал', c.material],
        ['Тираж', c.quantity ? String(c.quantity) + ' шт.' : ''],
        ['Габариты', c.dimensions],
        ['Масса', c.weight],
        ['Допуск', c.tolerance],
        ['Шероховатость', c.roughness],
        ['Оборудование', c.equipment],
    ].filter(([, v]) => v && String(v).trim());

    if (rows.length) {
        const body = rows.map(([k, v]) => `      <dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('\n');
        parts.push(`    <h2 class="zr-h2">Параметры работы</h2>\n    <dl class="zc-factors">\n${body}\n    </dl>\n`);
    }

    parts.push(section('Задача', c.task));
    parts.push(section('Сложность', c.complexity));
    parts.push(section('Решение', c.solution));
    parts.push(section('Результат', c.result));

    if (services && services.length) {
        const links = services
            .map(s => `<li><a href="/uslugi/${esc(s.slug)}">${esc(s.name)}</a></li>`)
            .join('\n      ');
        parts.push(`    <h2 class="zr-h2">Технологии</h2>\n    <ul class="zr-regions">\n      ${links}\n    </ul>\n`);
    }

    // Путь к действию: кейс должен заканчиваться не точкой, а возможностью
    // заказать похожее (ТЗ §7.1 — связь кейса с созданием заказа).
    parts.push('    <p class="zr-more">Нужна похожая работа? '
        + '<a href="/zayavka">Разместите закупку</a> — опишите задачу или приложите чертёж, '
        + 'и предложения придут напрямую от производств.</p>\n');

    return parts.filter(Boolean).join('\n');
}

function buildBreadcrumb(c) {
    return [
        '<a href="/">Главная</a><span>›</span>',
        '<a href="/keisy">Кейсы</a><span>›</span>',
        `<span>${esc(c.title)}</span>`,
    ].join('\n      ');
}

function buildJsonLd(c, services, base) {
    const root = String(base || '').replace(/\/$/, '');
    return JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: c.title,
        url: `${root}/keisy/${c.slug}`,
        datePublished: c.published_at || undefined,
        // Автор — предприятие: кейс подтверждает его компетенцию, а не нашу.
        author: c.company_name ? { '@type': 'Organization', name: c.company_name } : undefined,
        about: (services || []).map(s => s.name).join(', ') || undefined,
        breadcrumb: {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Главная', item: root },
                { '@type': 'ListItem', position: 2, name: 'Кейсы', item: `${root}/keisy` },
                { '@type': 'ListItem', position: 3, name: c.title },
            ],
        },
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

module.exports = { buildTitle, buildDescription, buildLead, buildStats, buildBody, buildBreadcrumb, buildJsonLd };
