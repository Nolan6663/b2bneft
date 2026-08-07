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

module.exports = {
    parseCargo,
    isCargoComplete,
    cargoToPlaces,
    MAX_WEIGHT_KG,
    MAX_DIMENSION_M,
    MAX_PLACES,
};
