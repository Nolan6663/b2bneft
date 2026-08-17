'use strict';

// Габариты груза в коммерческом предложении.
//
// Спрашиваем у завода, а не у заказчика. Завод знает вес готового изделия
// точно, заказчик обычно нет; и форма заявки при этом не растёт — за её
// конверсию боролись в онбординге.
//
// Поля необязательные. КП без габаритов остаётся полноценным: расчёта доставки
// по нему не будет, но ломать подачу предложения ради вспомогательной функции
// нельзя. По той же причине мусор в поле не приводит к ошибке — он просто не
// сохраняется.

const MAX_WEIGHT_KG = 20000;     // выше — уже не сборный груз, а отдельная машина
const MAX_DIMENSION_M = 20;
const MAX_PLACES = 100;

/** «1,5» → 1.5: запятая как разделитель у нас пишется чаще точки. */
function toNumber(value) {
    if (value == null || value === '') return null;
    const n = Number(String(value).replace(',', '.').trim());
    return Number.isFinite(n) ? n : null;
}

function positiveWithin(value, max) {
    const n = toNumber(value);
    if (n === null || n <= 0 || n > max) return null;
    return n;
}

/**
 * Разбирает габариты из тела запроса. Возвращает объект с числами или null
 * в каждом поле — валидация не отклоняет запрос, а отбрасывает негодное.
 */
function parseCargo(body) {
    const source = body || {};
    const places = positiveWithin(source.cargoPlaces, MAX_PLACES);
    return {
        weight: positiveWithin(source.cargoWeight, MAX_WEIGHT_KG),
        length: positiveWithin(source.cargoLength, MAX_DIMENSION_M),
        width: positiveWithin(source.cargoWidth, MAX_DIMENSION_M),
        height: positiveWithin(source.cargoHeight, MAX_DIMENSION_M),
        places: places === null ? null : Math.round(places),
    };
}

/** Заполнены ли габариты настолько, чтобы перевозчик мог посчитать. */
function isCargoComplete(cargo) {
    return Boolean(cargo && cargo.weight && cargo.length && cargo.width && cargo.height);
}

/**
 * Габариты из КП → места для расчёта. Завод указывает размер одного места и
 * их количество; вес в форме — тоже за место, иначе при вводе «2 места по
 * 300 кг» пришлось бы гадать, 300 это каждое или всё вместе.
 */
function cargoToPlaces(cargo) {
    if (!isCargoComplete(cargo)) return [];
    const count = cargo.places && cargo.places > 0 ? cargo.places : 1;
    return Array.from({ length: count }, () => ({
        width: cargo.width,
        length: cargo.length,
        height: cargo.height,
        weight: cargo.weight,
    }));
}

/* ── Опросный лист: несколько позиций разных габаритов ──────────────────────
 *
 * Одного набора габаритов хватает, пока груз однородный. Станок плюс ящик
 * запчастей в него не укладываются: объём считается по одному размеру,
 * умноженному на количество, и цена уезжает.
 *
 * Что здесь спрашивается — ровно то, что доедет до перевозчиков:
 *   • размеры и вес каждой позиции — объём сложится верно у всех троих;
 *   • негабарит и жёсткая упаковка — их принимает ПЭК (oversized/hardPack в
 *     его запросе), Деловые Линии и Возовоз считают по объёму и весу;
 *   • объявленная стоимость — тоже ПЭК; у остальных двух публичный
 *     калькулятор её не принимает и страховку считает сам.
 *
 * Больше полей заводить нельзя: форма на пятнадцать строк вернула бы тот же
 * ответ, что форма на пять, и это был бы обман интерфейсом.
 */
const MAX_ITEMS = 10;
const MAX_DECLARED_VALUE = 100000000;

function parseItem(raw) {
    const source = raw || {};
    const quantity = positiveWithin(source.quantity, MAX_PLACES);
    return {
        length: positiveWithin(source.length, MAX_DIMENSION_M),
        width: positiveWithin(source.width, MAX_DIMENSION_M),
        height: positiveWithin(source.height, MAX_DIMENSION_M),
        weight: positiveWithin(source.weight, MAX_WEIGHT_KG),
        quantity: quantity === null ? 1 : Math.round(quantity),
        oversized: Boolean(source.oversized),
        hardPack: Boolean(source.hardPack),
    };
}

function isItemComplete(item) {
    return Boolean(item && item.weight && item.length && item.width && item.height);
}

/**
 * Позиции опросного листа из тела запроса. Возвращает { items } или { error }
 * с человеческой причиной — её показывают на месте, а не «проверьте данные».
 */
function parseQuoteItems(body) {
    const raw = Array.isArray(body && body.items) ? body.items : null;
    if (!raw) return { error: 'Не указан груз' };
    if (raw.length > MAX_ITEMS) {
        return { error: `Позиций больше ${MAX_ITEMS} — такой груз считают уже отдельной машиной` };
    }
    // Пустые строки просто выбрасываем: человек добавил место и передумал.
    const items = raw.map(parseItem).filter((i) => i.weight || i.length || i.width || i.height);
    if (!items.length) return { error: 'Укажите вес и все три габарита' };

    const incomplete = items.findIndex((i) => !isItemComplete(i));
    if (incomplete >= 0) {
        return { error: `В позиции ${incomplete + 1} не хватает веса или габаритов` };
    }
    const total = items.reduce((n, i) => n + i.quantity, 0);
    if (total > MAX_PLACES) {
        return { error: `Всего мест больше ${MAX_PLACES} — это уже не сборный груз` };
    }
    return { items };
}

/** Позиции → места для перевозчиков: количество разворачивается в строки. */
function itemsToPlaces(items) {
    const places = [];
    for (const item of items) {
        for (let i = 0; i < (item.quantity || 1); i++) {
            places.push({
                width: item.width,
                length: item.length,
                height: item.height,
                weight: item.weight,
                oversized: item.oversized,
                hardPack: item.hardPack,
            });
        }
    }
    return places;
}

/** Объявленная стоимость: её принимает только ПЭК, но проверяем здесь. */
function parseDeclaredValue(value) {
    return positiveWithin(value, MAX_DECLARED_VALUE) || 0;
}

module.exports = {
    parseCargo,
    isCargoComplete,
    cargoToPlaces,
    parseQuoteItems,
    itemsToPlaces,
    parseDeclaredValue,
    MAX_WEIGHT_KG,
    MAX_DIMENSION_M,
    MAX_PLACES,
    MAX_ITEMS,
};
