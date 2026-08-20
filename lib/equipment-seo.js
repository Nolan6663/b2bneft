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

/* Разбор операции: процессы, что указать в заказе, вопросы.
 *
 * Страница операции до сих пор состояла из одной строки лида и списка заводов.
 * Для запроса вроде «цинкование» (68 000 показов) этого мало и человеку, и
 * поисковику: пришедший не понимает, горячее ему нужно или гальваническое, и
 * что вообще написать в заявке.
 *
 * Классы взяты те же, что на категорийных страницах, — своей вёрстки здесь не
 * заводим, разметка и стили уже есть в zakupki-cat.css. */
function buildOperationContent(op) {
    const out = [];

    if (op.processes && op.processes.length) {
        out.push(`    <h2 class="zr-h2">Какие бывают</h2>
    <dl class="zc-factors">
      ${op.processes.map(p => `<dt>${esc(p.title)}</dt><dd>${esc(p.text)}</dd>`).join('\n      ')}
    </dl>`);
    }

    if (op.order && op.order.length) {
        out.push(`    <h2 class="zr-h2">Что указать в заказе</h2>
    <ul class="zc-checklist">
      ${op.order.map(item => `<li>${esc(item)}</li>`).join('\n      ')}
    </ul>`);
    }

    if (op.faq && op.faq.length) {
        out.push(`    <h2 class="zr-h2">Частые вопросы</h2>
    <div>
      ${op.faq.map(f => `<details class="zc-faq-item"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('\n      ')}
    </div>`);
    }

    return out.join('\n\n');
}

/** Вопросы страницы отдельным блоком разметки — тем же способом, что на
 *  категорийных страницах. Нет вопросов — нет и блока: пустой FAQPage хуже,
 *  чем его отсутствие. */
function buildOperationFaqJsonLd(op) {
    if (!op.faq || !op.faq.length) return '';
    return JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: op.faq.map(f => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
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
    buildOperationContent,
    buildOperationFaqJsonLd,
    buildOperationDescription,
    buildOperationRobots,
    buildOperationSsr,
    buildOperationJsonLd,
};
