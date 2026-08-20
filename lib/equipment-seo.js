'use strict';

const { esc, plural } = require('./region-seo');

/* Есть ли на странице собственный разбор — процессы, чек-лист заказа, вопросы.
   Такая страница отвечает на запрос сама, а не пересказывает список карточек. */
function hasOwnContent(op) {
    return Boolean(op && ((op.processes && op.processes.length) || (op.faq && op.faq.length)));
}

/** Ниже этого числа список предприятий сам по себе странице ценности не даёт —
 *  дальше решает `isOperationIndexable`, есть ли у страницы собственный разбор. */
const MIN_INDEXABLE = 5;

/* Заголовок и описание зависят от того, чем страница сильна.
 *
 * Список из тринадцати заводов — сам по себе ответ, и число в заголовке работает
 * на клик. А «Лазерная резка: 2 предприятия» в выдаче по запросу на 166 000
 * показов отталкивает: человек видит пустой каталог ещё до перехода. Там, где
 * предприятий мало, а разбор есть, заголовок говорит про услугу, а не про
 * размер списка. Врать при этом не приходится — число никуда не девается, оно
 * стоит на самой странице в плашке. */
function buildOperationTitle(op, total) {
    if (hasOwnContent(op) && total < MIN_INDEXABLE) {
        return `${op.offer || op.name} — ТехЗаказ`;
    }
    return `${op.name}: ${total} ${plural(total, 'предприятие', 'предприятия', 'предприятий')} — ТехЗаказ`;
}

function buildOperationDescription(op, total) {
    const head = hasOwnContent(op) && total < MIN_INDEXABLE
        ? `${op.lead} Что указать в заказе, от чего зависит цена и срок. Разместите чертёж — предложения придут напрямую от производств.`
        : `${op.lead} ${total} ${plural(total, 'предприятие', 'предприятия', 'предприятий')} в каталоге ТехЗаказ — разместите чертёж и получите предложения.`;
    return head.length <= 160 ? head : head.slice(0, 157).replace(/[\s,.]+$/, '') + '…';
}

/**
 * Звать ли робота на страницу операции.
 *
 * Правило «меньше пяти предприятий — не зовём» писалось, когда страница была
 * списком карточек и ничем больше: два завода в таком списке — это пустая
 * витрина, и робот прав, что ей не рад.
 *
 * С разбором процессов всё иначе. У лазерной резки 166 000 показов в месяц и
 * два предприятия в каталоге — но человек по этому запросу идёт не каталог
 * смотреть, а размещать чертёж, и страница отвечает ему сама: чем волоконный
 * лазер отличается от CO₂, влезет ли деталь на стол, почему цена считается по
 * длине реза. Прятать такую страницу из-за короткого списка — значит закрывать
 * дверь ровно перед тем заказчиком, которого мы ищем.
 *
 * Поэтому индексируем, если предприятий хватает **или** у страницы есть свой
 * разбор. Пустой список при этом не скрывается: он честно говорит, что
 * предприятий пока нет, и предлагает заводу заполнить профиль.
 */
function isOperationIndexable(op, total) {
    return total >= MIN_INDEXABLE || hasOwnContent(op);
}

function buildOperationRobots(total, op) {
    return isOperationIndexable(op, total) ? 'index, follow' : 'noindex, follow';
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
    isOperationIndexable,
    buildOperationTitle,
    buildOperationContent,
    buildOperationFaqJsonLd,
    buildOperationDescription,
    buildOperationRobots,
    buildOperationSsr,
    buildOperationJsonLd,
};
