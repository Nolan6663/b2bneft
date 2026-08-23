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

/* Позиции опросного листа — по строке на каждую. В документе они перечислены
   поимённо, а не свёрнуты в общий объём: снабженец должен видеть, что именно
   отправляли считать, иначе цифру нечем защищать. Пометки про негабарит и
   обрешётку идут тут же — их учитывает только ПЭК, и об этом сказано ниже. */
function itemLabels(items) {
    if (!Array.isArray(items) || !items.length) return [];
    return items.map((item, i) => {
        const flags = [];
        if (item.oversized) flags.push('негабарит');
        if (item.hardPack) flags.push('жёсткая упаковка');
        const qty = item.quantity && item.quantity > 1 ? ` × ${item.quantity}` : '';
        const size = `${item.length}×${item.width}×${item.height} м`;
        return `${i + 1}. ${size}, ${item.weight} кг${qty}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    });
}

/** Итог по грузу: сколько всего мест и килограммов уехало в расчёт. */
function totalsLabel(items) {
    if (!Array.isArray(items) || !items.length) return '—';
    const places = items.reduce((n, i) => n + (i.quantity || 1), 0);
    const weight = items.reduce((n, i) => n + (i.weight || 0) * (i.quantity || 1), 0);
    const volume = items.reduce((n, i) => n + (i.length * i.width * i.height) * (i.quantity || 1), 0);
    return `мест ${places}, ${Math.round(weight * 100) / 100} кг, ${Math.round(volume * 1000) / 1000} м³`;
}

/* Флаги и объявленная стоимость доезжают не до всех — молчать об этом нельзя,
   иначе документ выглядит так, будто их учли все трое. */
function scopeNote(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    const hasFlags = items.some((i) => i.oversized || i.hardPack);
    const hasValue = Number(data.declaredValue) > 0;
    if (!hasFlags && !hasValue) return '';
    const what = [];
    if (hasFlags) what.push('негабарит и жёсткую упаковку');
    if (hasValue) what.push('объявленную стоимость');
    return `${what.join(', ')} из перечисленных перевозчиков учитывает только ПЭК: `
        + 'у Деловых Линий и Возовоза публичный расчёт этих параметров не принимает.';
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

/* Маршрут для шапки документа.
 *
 * Если адрес известен — показываем его вместо голого города: документ идёт в
 * обоснование выбора, и «Москва → Екатеринбург» там читается как черновик, а
 * «г Москва, Варшавское шоссе, д 132 → г Екатеринбург, ул Малышева, д 51» —
 * как расчёт по конкретной отгрузке.
 *
 * Сама цена при этом считается по городу: все три перевозчика берут за забор и
 * доставку по городской зоне, а не по расстоянию до точки. Поэтому адрес —
 * это уточнение для человека, а не параметр расчёта, и подменять им город в
 * запросе к перевозчику нельзя. */
function routeLabel(data) {
    const side = (p) => {
        if (!p) return '—';
        const address = String(p.address || '').trim();
        return address || String(p.name || '').trim() || '—';
    };
    return `${side(data.from)} → ${side(data.to)}`;
}

module.exports = {
    DISCLAIMER,
    serviceLabel,
    daysLabel,
    breakdownLabel,
    cargoLabel,
    itemLabels,
    totalsLabel,
    scopeNote,
    doorsLabel,
    quoteRows,
    routeLabel,
};
