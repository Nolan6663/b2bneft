'use strict';

// Расчёт доставки Деловыми Линиями по публичным тарифам.
//
// Ключ бесплатный, с регистрации на dev.dellin.ru, лежит в DELLIN_APP_KEY.
// Без ключа модуль молча выпадает из расчёта: остальные перевозчики считают
// как обычно, а не падает всё.
//
// Два капкана этого API, оба проверены живыми запросами 2026-08-08 и оба
// опасны именно тем, что не приводят к ошибке.
//
// 1. КОД ГОРОДА. Формально принимается «КЛАДР или почтовый индекс», но
//    тринадцатизначный КЛАДР («7700000000000») не находится, а почтовый индекс
//    (101000 → Москва) не отвергается — вместо этого API молча посчитал
//    маршрут Майкоп → Майкоп и вернул уверенные 2080 руб. Ни ошибки, ни
//    предупреждения. Поэтому коды берём только из их же поиска
//    /v2/public/kladr.json, где они 25-значные, и никогда не собираем сами.
//
// 2. ЕДИНИЦЫ ВЕСА. sizedWeight в ТОННАХ. Передать 500 вместо 0.5 не ошибка:
//    запрос проходит и возвращает 23 365 руб. вместо 13 709 — правдоподобное
//    число за груз, которого нет.

const { normalizeCityName } = require('./geo');

const CALC_URL = 'https://api.dellin.ru/v1/public/calculator.json';
const KLADR_URL = 'https://api.dellin.ru/v2/public/kladr.json';
const ORDER_URL = 'https://www.dellin.ru/requests/';
const TIMEOUT_MS = 8000;

const CARRIER = 'dellin';
const CARRIER_NAME = 'Деловые Линии';

// Ключ читаем при каждом вызове, а не при загрузке модуля: тесты и скрипты
// поднимают окружение в разном порядке.
function appKey() {
    return process.env.DELLIN_APP_KEY || '';
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Выбор кода города среди найденного их поиском.
 *
 * Совпадение должно быть точным по названию: на запрос «Екатеринбург» их
 * справочник возвращает ещё и «310 км Екатеринбург-Тюмень автодорога».
 * Из точных совпадений предпочитаем город с терминалом.
 */
function pickCityCode(cities, name) {
    const key = normalizeCityName(name);
    if (!key) return null;
    const exact = (cities || []).filter((c) => normalizeCityName(c.searchString || c.aString) === key);
    const withTerminal = exact.find((c) => c.isTerminal === 1);
    const chosen = withTerminal || exact[0];
    return chosen ? String(chosen.code) : null;
}

/** Название города → код Деловых Линий. null, если не нашли или нет ключа. */
async function findCityCode(name) {
    if (!appKey() || !String(name || '').trim()) return null;
    const res = await fetch(KLADR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: appKey(), q: String(name).trim(), limit: 10 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Деловые Линии: поиск города вернул ${res.status}`);
    const data = await res.json();
    return pickCityCode(data && data.cities, name);
}

/** Габариты мест → объём в м³ и вес в тоннах, как ждёт их калькулятор. */
function sizeOf(places) {
    let volume = 0;
    let weightKg = 0;
    for (const p of places) {
        const w = Number(p.width) || 0;
        const l = Number(p.length) || 0;
        const h = Number(p.height) || 0;
        volume += Number(p.volume) || w * l * h;
        weightKg += Number(p.weight) || 0;
    }
    return { volume: Number(volume.toFixed(3)), weightTons: Number((weightKg / 1000).toFixed(3)) };
}

function daysFrom(block) {
    const value = Number(block && block.time && block.time.value);
    return Number.isFinite(value) && value > 0 ? { min: value, max: value } : null;
}

/**
 * Ответ Деловых Линий → список предложений.
 *
 * Итог по каждому способу считаем сами из составляющих, потому что в ответе
 * есть только один общий price — для наземной перевозки. Формула сверена с их
 * же числом: 8254 плечо + 2460 забор + 1080 доставка + 1900 страховка + 15
 * уведомление = 13 709, ровно как в поле price. Тест это соотношение
 * закрепляет: разойдётся — значит состав ответа поменялся.
 *
 * Страхование в total не входит: у них оно считается по своим правилам и на
 * объявленную стоимость не реагирует (проверено перебором declaredPrice,
 * declaredValue, insurance и ещё пяти имён — страховка всегда одна и та же).
 * У ПЭК же она зависит от объявленной стоимости. Сложить это в одно число
 * и сортировать по нему значило бы сравнивать разное.
 *
 * Уведомление о вручении (15 руб.) кладём в плечо, иначе разбивка на экране
 * не сойдётся с итогом из-за пятнадцати рублей.
 */
function parseDellinResponse(raw, { doorFrom = true, doorTo = true } = {}) {
    if (!raw || typeof raw !== 'object' || raw.errors) return [];

    const pickup = doorFrom ? Math.round(money(raw.derival && raw.derival.price)) : 0;
    const delivery = doorTo ? Math.round(money(raw.arrival && raw.arrival.price)) : 0;
    const notify = money(raw.notify && raw.notify.price);
    const calculatedAt = new Date().toISOString();

    const services = [
        ['auto', raw.intercity],
        ['express', raw.express],
        ['avia', raw.air],
    ];

    const quotes = [];
    for (const [service, block] of services) {
        const line = money(block && block.price);
        if (line <= 0) continue;
        const insurance = Math.round(money(block.insurance));
        const lineTotal = Math.round(line + notify);
        quotes.push({
            carrier: CARRIER,
            carrierName: CARRIER_NAME,
            service,
            price: {
                total: lineTotal + pickup + delivery,
                line: lineTotal,
                pickup,
                delivery,
                insurance,
            },
            days: daysFrom(block) || (service === 'auto' ? daysFrom(raw) : null),
            doorToDoor: doorFrom && doorTo,
            url: ORDER_URL,
            calculatedAt,
        });
    }
    return quotes;
}

/**
 * Расчёт по маршруту. from/to — точки из lib/logistics/geo.js.
 * Пустой массив означает «этот перевозчик по этому маршруту не считает»:
 * нет ключа, нет кода города, нет габаритов.
 */
// insurance в параметрах нет намеренно: их публичный калькулятор объявленную
// стоимость не принимает, страховку считает сам. Общий контракт это допускает —
// перевозчик берёт из запроса то, что умеет.
async function quote({ from, to, places, doorFrom = true, doorTo = true }) {
    const fromCode = from && from.codes && from.codes.dellin;
    const toCode = to && to.codes && to.codes.dellin;
    if (!appKey() || !fromCode || !toCode) return [];
    if (!Array.isArray(places) || places.length === 0) return [];

    const { volume, weightTons } = sizeOf(places);
    if (volume <= 0 || weightTons <= 0) return [];

    const res = await fetch(CALC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            appKey: appKey(),
            derivalPoint: fromCode,
            arrivalPoint: toCode,
            derivalDoor: Boolean(doorFrom),
            arrivalDoor: Boolean(doorTo),
            sizedVolume: volume,
            sizedWeight: weightTons,
            // Объявленную стоимость не передаём: публичный калькулятор её не
            // принимает ни под одним из вероятных имён, страховку считает сам.
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Деловые Линии: расчёт вернул ${res.status}`);
    return parseDellinResponse(await res.json(), { doorFrom, doorTo });
}

module.exports = {
    quote,
    findCityCode,
    pickCityCode,
    parseDellinResponse,
    sizeOf,
    CARRIER,
    CARRIER_NAME,
    CALC_URL,
    KLADR_URL,
};
