'use strict';

// Кейсы исполнителей — ТЗ §9.
//
// Кейс решает задачу, которую не решает профиль: профиль — это заявление
// «мы умеем», кейс — подтверждение «мы сделали». Отсюда все требования ниже:
// они отделяют подтверждение от рекламного текста.
//
// Три вещи, которые здесь не даются исполнителю на откуп:
//
// 1. Конфиденциальность заказчика. Назвать его можно только с разрешения
//    (ТЗ §9.2), и по умолчанию кейс обезличен. Галочка «имя раскрывать
//    разрешено» снимается сознательно, а не забывается — потому что цена
//    ошибки здесь чужая, а не наша.
//
// 2. Статусы. Опубликовать свой кейс сам исполнитель не может: между
//    «отправил» и «опубликован» стоит модерация (ТЗ §9.4). Иначе кейсы
//    мгновенно превратятся в рекламные объявления, а страницы услуг — в
//    доску объявлений.
//
// 3. Минимальная содержательность. Кейс без задачи и решения — это заголовок,
//    а не подтверждение компетенции. Такой на модерацию не уходит.

const { toSlug } = require('./slug');

const STATUSES = ['draft', 'review', 'changes_requested', 'published', 'hidden'];

/* Переходы по ТЗ §9.4. Исполнителю доступны только те, что ведут вправо от
   черновика; публикует и скрывает модератор. Явная таблица вместо набора
   if-ов: правила видно целиком, и дописать новый статус, забыв про переходы,
   не получится. */
const TRANSITIONS = {
    // кто → { статус: [роли, которым можно] }
    draft:             { review: ['owner', 'admin'] },
    review:            { published: ['admin'], changes_requested: ['admin'], draft: ['owner'] },
    changes_requested: { review: ['owner', 'admin'], draft: ['owner'] },
    published:         { hidden: ['admin', 'owner'] },
    hidden:            { review: ['owner', 'admin'], published: ['admin'] },
};

const TITLE_MAX = 160;
const TEXT_MAX = 4000;
const MEDIA_MAX = 12;

/** Минимум, без которого кейс — не кейс. Проверяется перед отправкой на
 *  модерацию, а не при сохранении черновика: черновик можно бросить на
 *  середине, это нормальная работа. */
function validateForReview(c) {
    const problems = [];
    const t = v => String(v == null ? '' : v).trim();

    if (t(c.title).length < 8) problems.push('Название: минимум 8 знаков, и лучше конкретное — что именно сделали');
    if (!c.product_id && !((c.services || []).length)) {
        problems.push('Укажите изделие или хотя бы одну услугу — иначе кейс не попадёт ни на одну страницу');
    }
    if (t(c.task).length < 40) problems.push('Задача: опишите исходные требования, минимум 40 знаков');
    if (t(c.solution).length < 40) problems.push('Решение: технологический маршрут и контроль, минимум 40 знаков');
    if (t(c.result).length < 20) problems.push('Результат: чем закончилось — срок, приёмка, измеримый итог');

    // ТЗ §9.2: назвать заказчика можно только с разрешения. Отметка без
    // имени — скорее всего забытая галочка, и лучше переспросить.
    if (c.customer_named && !t(c.customer_name)) {
        problems.push('Отмечено, что заказчика можно назвать, но имя не указано');
    }
    if (!c.customer_named && t(c.customer_name)) {
        problems.push('Имя заказчика указано без разрешения на публикацию — уберите имя или подтвердите разрешение');
    }

    return problems;
}

/* Рекламные штампы. ТЗ §9.2 требует названия «без рекламных штампов», а §9.4 —
   проверки на рекламный спам. Список намеренно короткий: это подсказка автору
   на этапе заполнения, а не фильтр — решение всё равно принимает модератор. */
const AD_CLICHES = [
    'лидер рынка', 'ведущий производитель', 'лучшие цены', 'уникальн',
    'широкий спектр', 'индивидуальный подход', 'высочайшее качество',
    'динамично развивающ', 'гибкая система скидок',
];

function adWarnings(c) {
    const text = [c.title, c.task, c.solution, c.result].map(v => String(v || '')).join(' ').toLowerCase();
    return AD_CLICHES.filter(w => text.includes(w));
}

/**
 * Можно ли перевести кейс в новый статус.
 * @param {string} from текущий статус
 * @param {string} to   желаемый
 * @param {string} role 'owner' — исполнитель-автор, 'admin' — модератор
 */
function canTransition(from, to, role) {
    if (!STATUSES.includes(to)) return { allowed: false, why: `Неизвестный статус «${to}»` };
    if (from === to) return { allowed: true };
    const allowedRoles = (TRANSITIONS[from] || {})[to];
    if (!allowedRoles) return { allowed: false, why: `Из «${from}» нельзя перейти в «${to}»` };
    if (!allowedRoles.includes(role)) {
        const why = to === 'published'
            ? 'Опубликовать кейс может только модератор'
            : 'Недостаточно прав для этого перехода';
        return { allowed: false, why };
    }
    return { allowed: true };
}

/** Показывается ли кейс посторонним. Единственная точка — чтобы публичные
 *  выборки и страница кейса не разошлись в понимании слова «опубликован». */
function isPublic(c) {
    return !!c && c.status === 'published';
}

/** Что видно в публичной карточке. Имя заказчика уходит наружу только при
 *  явном разрешении — здесь это единственное место, где такое решение
 *  принимается. */
function publicView(c) {
    if (!c) return null;
    return {
        slug: c.slug,
        title: c.title,
        product: c.product_name || null,
        services: c.services || [],
        material: c.material || '',
        equipment: c.equipment || '',
        quantity: c.quantity || null,
        dimensions: c.dimensions || '',
        weight: c.weight || '',
        tolerance: c.tolerance || '',
        roughness: c.roughness || '',
        task: c.task || '',
        complexity: c.complexity || '',
        solution: c.solution || '',
        result: c.result || '',
        media: Array.isArray(c.media) ? c.media.slice(0, MEDIA_MAX) : [],
        customer: c.customer_named && c.customer_name ? c.customer_name : null,
        company: { id: c.company_id, name: c.company_name || '' },
        publishedAt: c.published_at || null,
    };
}

/** Slug кейса: из названия, с номером компании для различения одинаковых
 *  заголовков у разных предприятий. Один кейс — один адрес (ТЗ §3.6), поэтому
 *  slug не меняется при правках: смена адреса опубликованного кейса рвёт
 *  ссылки на него. */
function buildSlug(title, companyId) {
    const base = toSlug(title, 60) || 'keys';
    return `${base}-${Number(companyId) || 0}`;
}

/** Нормализация полей перед записью. Длины ограничены здесь, а не в базе:
 *  внятное сообщение автору лучше, чем ошибка драйвера. */
function sanitize(input) {
    const t = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
    const named = input.customerNamed === true || input.customerNamed === 'true';
    return {
        title: t(input.title, TITLE_MAX),
        productId: Number.isInteger(Number(input.productId)) && Number(input.productId) > 0 ? Number(input.productId) : null,
        serviceIds: Array.isArray(input.serviceIds)
            ? [...new Set(input.serviceIds.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 10)
            : [],
        material: t(input.material, 200),
        equipment: t(input.equipment, 300),
        quantity: Number.isFinite(Number(input.quantity)) && Number(input.quantity) > 0 ? Math.round(Number(input.quantity)) : null,
        dimensions: t(input.dimensions, 200),
        weight: t(input.weight, 100),
        tolerance: t(input.tolerance, 100),
        roughness: t(input.roughness, 100),
        task: t(input.task, TEXT_MAX),
        complexity: t(input.complexity, TEXT_MAX),
        solution: t(input.solution, TEXT_MAX),
        result: t(input.result, TEXT_MAX),
        customerNamed: named,
        // Имя без разрешения не сохраняем вовсе: чего нет в базе, то не утечёт.
        customerName: named ? t(input.customerName, 200) : '',
    };
}

module.exports = {
    STATUSES, TRANSITIONS, TITLE_MAX, TEXT_MAX, MEDIA_MAX, AD_CLICHES,
    validateForReview, adWarnings, canTransition, isPublic, publicView,
    buildSlug, sanitize,
};
