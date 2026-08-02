'use strict';

const { esc, plural } = require('./region-seo');

/** Меньше пяти предприятий — страница операции пустая, робота не зовём. */
const MIN_INDEXABLE = 5;

function buildOperationTitle(op, total) {
    return `${op.name}: ${total} ${plural(total, 'предприятие', 'предприятия', 'предприятий')} — ТехЗаказ`;
}

function buildOperationDescription(op, total) {
    const head = `${op.lead} ${total} ${plural(total, 'предприятие', 'предприятия', 'предприятий')} в каталоге ТехЗаказ — разместите чертёж и получите предложения.`;
    return head.length <= 160 ? head : head.slice(0, 157).replace(/[\s,.]+$/, '') + '…';
}

function buildOperationRobots(total) {
    return total >= MIN_INDEXABLE ? 'index, follow' : 'noindex, follow';
}

/** Карточки предприятий, заявивших операцию. Данные из базы экранируются. */
function buildOperationSsr(op, producers) {
    if (!producers.length) {
        return `    <p class="zr-empty">Предприятий с этой операцией в профиле пока нет. Если вы её выполняете — <a href="/login#register">заполните профиль</a>, и производство появится в каталоге.</p>\n`;
    }
    const cards = producers.map(p => {
        const line = String(p.specialization || p.products || '').trim().slice(0, 160);
        const where = String(p.city || '').trim();
        const badge = p.verifiedByPlatform
            ? '<span class="zr-badge zr-badge--ok">Проверен платформой</span>'
            : (p.claimed ? '' : '<span class="zr-badge">Реестр Минпромторга</span>');
        return `      <li class="zr-card">
        <a class="zr-card-name" href="/p/${Number(p.id)}">${esc(p.company)}</a>
        ${where ? `<p class="zr-card-line">${esc(where)}</p>` : ''}
        ${badge}
        ${line ? `<p class="zr-card-line">${esc(line)}</p>` : ''}
      </li>`;
    }).join('\n');
    return `    <ul class="zr-cards">\n${cards}\n    </ul>\n`;
}

function buildOperationJsonLd(op, total, base) {
    const root = String(base).replace(/\/$/, '');
    return JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `${op.name} — предприятия каталога`,
        url: `${root}/oborudovanie/${op.slug}`,
        breadcrumb: {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Главная', item: root },
                { '@type': 'ListItem', position: 2, name: 'Оборудование и операции', item: `${root}/oborudovanie` },
                { '@type': 'ListItem', position: 3, name: op.name },
            ],
        },
        mainEntity: { '@type': 'ItemList', numberOfItems: total },
    });
}

module.exports = {
    MIN_INDEXABLE,
    buildOperationTitle,
    buildOperationDescription,
    buildOperationRobots,
    buildOperationSsr,
    buildOperationJsonLd,
};
