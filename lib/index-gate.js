'use strict';

// Автоматическая проверка перед переводом страницы в индекс.
// «Краулинговый бюджет» §12 и §14, ТЗ §11.1.
//
// Смысл не в том, чтобы запретить редактору публиковать. Смысл в том, чтобы он
// принимал решение, видя все условия сразу, а не вспоминал их по памяти из
// документа на шестьдесят пять страниц. Проверка возвращает список пунктов —
// какие выполнены, какие нет и чего конкретно не хватает.
//
// Критические пункты блокируют перевод в index: при их невыполнении
// «Краулинговый бюджет» §12 требует оставить страницу черновиком или
// опубликовать с noindex. Остальные — предупреждения: редактор вправе
// опубликовать страницу, где не хватает связанных сущностей, и это его
// осознанный выбор, а не недосмотр.

const { getThreshold } = require('./catalog-settings');
const { LANDING_STATUSES } = require('./catalog-schema');

/* Пороги спроса и предложения по типам страниц — из ответа маркетинга на
   вопрос 1. Ключи те же, что в catalog_settings, значения по умолчанию — на
   случай недоступной базы. */
const RULES = {
    service:    { demand: ['threshold.service.demand', 20],    supply: ['threshold.service.supply', 3],    supplyName: 'активных исполнителей' },
    product:    { demand: ['threshold.product.demand', 10],    supply: ['threshold.product.supply', 3],    supplyName: 'исполнителей или подтверждённых кейсов' },
    contractor: { demand: ['threshold.contractor.demand', 10], supply: ['threshold.contractor.supply', 5], supplyName: 'подходящих компаний' },
    geo:        { demand: ['threshold.geo.demand', 5],         supply: ['threshold.geo.supply', 5],        supplyName: 'исполнителей в регионе' },
    order:      { demand: ['threshold.orderhub.demand', 10],   supply: ['threshold.orderhub.supply', 3],   supplyName: 'новых заказов за окно' },
};

function rule(pageType) {
    return RULES[pageType] || RULES.service;
}

function check(passed, title, detail) {
    return { passed: !!passed, title, detail: detail || '' };
}

/**
 * Проверка готовности посадочной страницы к индексации.
 *
 * @param {object} landing строка landing_pages
 * @param {object} facts   { demand, supply, hasUniqueContent, duplicateKey, duplicateUrl, inboundLinks }
 * @returns {{ready:boolean, blocking:Array, warnings:Array, checks:Array}}
 */
function evaluate(landing, facts = {}) {
    const r = rule(landing && landing.page_type);
    const demandNeed = getThreshold(r.demand[0], r.demand[1]);
    const supplyNeed = getThreshold(r.supply[0], r.supply[1]);

    const demand = Number(facts.demand || 0);
    const supply = Number(facts.supply || 0);

    /* Критические: без них страница в индексе вредна, а не бесполезна.
       Дубль ключа и дубль адреса — первыми: две страницы на один интент это
       ровно та каннибализация, ради которой всё и затевалось (ТЗ §2.2). */
    const blocking = [
        check(!facts.duplicateKey,
            'Системный ключ уникален',
            facts.duplicateKey ? `Ключ уже занят страницей ${facts.duplicateKey}` : ''),
        check(!facts.duplicateUrl,
            'Адрес уникален',
            facts.duplicateUrl ? `Адрес уже занят страницей ${facts.duplicateUrl}` : ''),
        check(landing && landing.url,
            'У страницы есть адрес'),
        check(supply >= supplyNeed,
            `Достаточно предложения: ${supplyNeed} ${r.supplyName}`,
            supply < supplyNeed ? `Сейчас ${supply}` : ''),
        check(facts.hasUniqueContent !== false,
            'Есть собственное содержание',
            facts.hasUniqueContent === false ? 'Страница повторяет родителя и не отвечает на запрос сама' : ''),
    ];

    /* Предупреждения: решает редактор.
       Спрос вынесен сюда намеренно. Данных о частотности у платформы нет — их
       приносит SEO-специалист извне, и пока цифра не проставлена, блокировать
       по ней значит блокировать всё подряд. */
    const warnings = [
        check(demand >= demandNeed,
            `Подтверждён спрос: ${demandNeed} показов в месяц`,
            demand ? `Указано ${demand}` : 'Частотность не проставлена — уточните у SEO'),
        check((facts.inboundLinks || 0) > 0,
            'Страница есть во внутренней перелинковке',
            !(facts.inboundLinks || 0) ? 'На неё никто не ссылается — робот придёт только по карте сайта' : ''),
    ];

    const failedBlocking = blocking.filter(c => !c.passed);
    return {
        ready: failedBlocking.length === 0,
        blocking: failedBlocking,
        warnings: warnings.filter(c => !c.passed),
        checks: [...blocking, ...warnings],
        thresholds: { demand: demandNeed, supply: supplyNeed },
    };
}

/**
 * Допустим ли переход между статусами.
 *
 * Смысл ограничений: в индекс можно попасть только осознанным действием и
 * только из публичного состояния. Прыжок «черновик → в индекс» мимо проверки
 * наполнения — ровно то, что «Краулинговый бюджет» §3 называет недопустимым:
 * перевод в index должен быть отдельным управляемым действием.
 */
const ALLOWED = {
    draft: ['preview', 'published_noindex', 'archived'],
    preview: ['draft', 'published_noindex', 'archived'],
    published_noindex: ['published_index', 'preview', 'merged', 'archived'],
    published_index: ['published_noindex', 'merged', 'archived'],
    merged: ['published_noindex', 'archived'],
    archived: ['draft', 'published_noindex'],
};

function canTransition(from, to) {
    if (!LANDING_STATUSES.includes(to)) {
        return { allowed: false, why: `Неизвестный статус «${to}»` };
    }
    if (from === to) return { allowed: true };
    const list = ALLOWED[from] || [];
    if (!list.includes(to)) {
        // Самый частый случай — попытка открыть черновик сразу в индекс.
        const hint = to === 'published_index'
            ? ' Сначала опубликуйте с noindex и проверьте наполнение.'
            : '';
        return { allowed: false, why: `Из «${from}» нельзя перейти в «${to}».${hint}` };
    }
    return { allowed: true };
}

module.exports = { evaluate, canTransition, ALLOWED, RULES };
