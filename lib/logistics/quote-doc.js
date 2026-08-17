'use strict';

/* Общие куски документов с расчётом доставки — PDF и Excel.
 *
 * Снабженцу расчёт нужен не на экране, а в папке: объяснить своим, почему из
 * трёх перевозчиков выбран этот. Поэтому выгрузка повторяет экран построчно, а
 * не пересказывает его — иначе документ и страница однажды разойдутся, и
 * спорить будут с документом.
 *
 * Оговорка тут не украшение и не дублируется вручную в каждом формате: мы не
 * сторона перевозки и цену от своего лица не обещаем. Документ с нашей рамкой
 * и без этой строки — готовая претензия по первому же разошедшемуся счёту.
 */

const SERVICE_LABEL = { auto: 'авто', avia: 'авиа', express: 'экспресс' };

const DISCLAIMER = 'Цена — за перевозку с забором и доставкой. Страхование показано отдельно '
    + 'и в сумму не входит: перевозчики считают его по-разному. Ориентировочный расчёт по '
    + 'публичному тарифу, без обрешётки, негабарита и класса груза. Итог подтверждает '
    + 'перевозчик. ТехЗаказ грузы не возит и стороной перевозки не является.';

function serviceLabel(service) {
    return SERVICE_LABEL[service] || service || '—';
}

function daysLabel(days) {
    if (!days) return 'срок уточняется';
    return days.min === days.max ? `${days.min} сут.` : `${days.min}–${days.max} сут.`;
}

/* «плечо 11 200, забор 3 100, доставка 4 440» — из чего сложилась цена.
   Формат чисел тот же, что на экране (Intl, ru-RU): документ и страница
   обязаны читаться одинаково, иначе сверять их будут по-разному. */
const fmt = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(v));

function breakdownLabel(price) {
    if (!price) return '';
    const parts = [];
    if (price.line != null) parts.push(`плечо ${fmt(price.line)}`);
    if (price.pickup) parts.push(`забор ${fmt(price.pickup)}`);
    if (price.delivery) parts.push(`доставка ${fmt(price.delivery)}`);
    return parts.join(', ');
}

/** Что именно считали: груз одной строкой. */
function cargoLabel(cargo) {
    if (!cargo) return '—';
    const size = [cargo.length, cargo.width, cargo.height].every((v) => v != null)
        ? `${cargo.length}×${cargo.width}×${cargo.height} м`
        : '—';
    const places = cargo.places && cargo.places > 1 ? `, мест ${cargo.places}` : '';
    return `${cargo.weight != null ? cargo.weight + ' кг' : '—'} · ${size}${places}`;
}

/** Двери: снятый забор или доставка меняют цену, и в документе это видно. */
function doorsLabel(doorFrom, doorTo) {
    const from = doorFrom === false ? 'от терминала' : 'забор от адреса';
    const to = doorTo === false ? 'до терминала' : 'доставка до адреса';
    return `${from}, ${to}`;
}

/** Строки таблицы — одинаковые для обоих форматов. */
function quoteRows(quotes) {
    return (quotes || []).map((q, i) => ({
        n: i + 1,
        carrier: q.carrierName,
        service: serviceLabel(q.service),
        days: daysLabel(q.days),
        breakdown: breakdownLabel(q.price),
        insurance: q.price && q.price.insurance ? Math.round(q.price.insurance) : null,
        total: q.price ? Math.round(q.price.total) : null,
        cheapest: i === 0,
    }));
}

function routeLabel(data) {
    const from = data.from && data.from.name ? data.from.name : '—';
    const to = data.to && data.to.name ? data.to.name : '—';
    return `${from} → ${to}`;
}

module.exports = {
    DISCLAIMER,
    serviceLabel,
    daysLabel,
    breakdownLabel,
    cargoLabel,
    doorsLabel,
    quoteRows,
    routeLabel,
};
