'use strict';

/**
 * Полнота профиля производителя.
 *
 * Зачем: каталог операций (/oborudovanie) и подбор под закупки работают по тому,
 * что предприятие о себе написало. На 4535 профилей станки не указал никто, поэтому
 * витрина операций держится на описаниях. Этот модуль считает, чего в профиле не
 * хватает, и главное — говорит, что именно откроется, когда поле заполнят.
 *
 * Веса — не «красота цифры»: они пропорциональны тому, насколько поле влияет на
 * попадание в подбор и в публичные витрины.
 */
const FIELDS = [
    {
        key: 'specialization', weight: 20,
        label: 'Специализация',
        unlocks: 'по ней профиль попадает в подбор под закупки и в категории каталога',
        filled: c => Boolean(String(c.specialization || '').trim()),
    },
    {
        key: 'products', weight: 20,
        label: 'Продукция и виды работ',
        unlocks: 'по этому тексту вас находят в поиске и в каталоге операций',
        filled: c => String(c.products || '').trim().length >= 20,
    },
    {
        key: 'capabilities', weight: 15,
        label: 'Технологические операции',
        unlocks: 'страницы вида «Токарные работы» и «Сварка» — там сейчас вас нет',
        filled: c => Array.isArray(c.capabilities) && c.capabilities.length > 0,
    },
    {
        key: 'equipment', weight: 15,
        label: 'Станочный парк',
        unlocks: 'заказчик видит, на чём вы работаете, ещё до переписки',
        filled: c => Array.isArray(c.equipment) && c.equipment.length > 0,
    },
    {
        key: 'city', weight: 10,
        label: 'Город или регион',
        unlocks: 'карточка встаёт на карту и на страницу своего региона',
        filled: c => Boolean(String(c.city || '').trim()),
    },
    {
        key: 'about', weight: 8,
        label: 'Описание производства',
        unlocks: 'заказчику понятно, кто вы, без звонка',
        filled: c => String(c.about || '').trim().length >= 40,
    },
    {
        key: 'phone', weight: 7,
        label: 'Телефон',
        unlocks: 'заказчик связывается сразу после выбора предложения',
        filled: c => Boolean(String(c.phone || '').trim()),
    },
    {
        key: 'productionLoad', weight: 5,
        label: 'Загрузка производства',
        unlocks: 'видна в каталоге — заказчики фильтруют по свободным мощностям',
        filled: c => c.productionLoad != null && c.productionLoad !== '',
    },
];

function profileCompleteness(company) {
    const c = company || {};
    const done = [];
    const missing = [];
    let score = 0;
    for (const f of FIELDS) {
        if (f.filled(c)) {
            score += f.weight;
            done.push({ key: f.key, label: f.label });
        } else {
            missing.push({ key: f.key, label: f.label, unlocks: f.unlocks, weight: f.weight });
        }
    }
    missing.sort((a, b) => b.weight - a.weight);
    return {
        percent: Math.round(score),
        done,
        missing,
        complete: missing.length === 0,
    };
}

module.exports = { FIELDS, profileCompleteness };
