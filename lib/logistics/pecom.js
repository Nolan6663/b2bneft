'use strict';

// Расчёт доставки сборным грузом через ПЭК.
//
// Особенность этого перевозчика — публичный API без ключа и регистрации: адрес
// ниже отвечает кому угодно. Это и причина взять его первым, и причина не
// расслабляться. Эндпоинт — ajax-компонент их сайта на Битриксе, а не
// versioned API: путь может измениться при редизайне, и никто не предупредит.
// Поэтому есть scripts/check-logistics.js, который бьёт по нему отдельно от
// npm test: падение чужого сайта не должно останавливать наш деплой.
//
// Формат ответа тоже сайтовый. Цены приходят массивами вида
// ["Стоимость перевозки груза", "Москва Восток - Екатеринбург", 12900] — цена
// третьим элементом. Дополнительные услуги лежат в ADD_1…ADD_4 объектами
// { "1": название, "3": сумма }, и номер услуги не закреплён: страхование
// оказалось третьим на одном маршруте, но полагаться на это нельзя, поэтому
// ищем по названию.

const CALC_URL = 'https://calc.pecom.ru/bitrix/components/pecom/calc/ajax.php';
const ORDER_URL = 'https://pecom.ru/calculator/';
const TIMEOUT_MS = 8000;

const CARRIER = 'pecom';
const CARRIER_NAME = 'ПЭК';

/**
 * Собирает строку запроса. Места передаются повторяющимися параметрами в жёстко
 * заданном порядке: ширина, длина, высота, объём, вес, негабарит, жёсткая
 * упаковка. Метры и килограммы.
 */
function buildQuery({ from, to, places, insurance }) {
    const parts = [];
    places.forEach((place, i) => {
        const width = Number(place.width) || 0;
        const length = Number(place.length) || 0;
        const height = Number(place.height) || 0;
        const volume = Number(place.volume) || width * length * height;
        const values = [width, length, height, volume, Number(place.weight) || 0, place.oversized ? 1 : 0, place.hardPack ? 1 : 0];
        for (const v of values) parts.push(`places[${i}][]=${v}`);
    });
    parts.push(`take[town]=${encodeURIComponent(from)}`);
    parts.push(`deliver[town]=${encodeURIComponent(to)}`);
    if (insurance > 0) parts.push(`strah=${Math.round(insurance)}`);
    return parts.join('&');
}

/** Цена из массива ["название", "маршрут", 12900]. */
function priceOf(entry) {
    if (!Array.isArray(entry)) return null;
    const value = Number(entry[entry.length - 1]);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Сумма дополнительной услуги по названию. Номер ADD_N не закреплён за услугой,
 * поэтому перебираем все и сверяем название.
 */
function additionalService(raw, pattern) {
    for (let i = 1; i <= 8; i += 1) {
        const add = raw[`ADD_${i}`];
        if (!add || typeof add !== 'object') continue;
        if (pattern.test(String(add['1'] || ''))) {
            const sum = Number(add['3']);
            if (Number.isFinite(sum) && sum > 0) return sum;
        }
    }
    return 0;
}

/** Разбор строки вида «4 - 7» или «5». */
function matchDays(value) {
    const m = /^\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/.exec(String(value == null ? '' : value));
    return m ? { min: Number(m[1]), max: Number(m[2] || m[1]) } : null;
}

/**
 * Срок из HTML-куска: у авто есть структурное поле, у авиа только разметка
 * вида «<b>Количество суток в пути</b>: 1 - 5». Теги срезаем, число достаём
 * по подписи. Не разобралось — возвращаем null: в таблице лучше прочерк, чем
 * выдуманный срок.
 */
function parseDaysFromHtml(html) {
    const stripped = String(html == null ? '' : html).replace(/<[^>]*>/g, ' ');
    const m = /Количество суток в пути\s*:?\s*(\d+)(?:\s*[-–]\s*(\d+))?/i.exec(stripped);
    return m ? { min: Number(m[1]), max: Number(m[2] || m[1]) } : null;
}

/**
 * Срок в сутках для наземной доставки. Основной источник — структурное поле
 * periods_days («4 - 7»); HTML разбираем запасным вариантом, потому что он
 * меняется вместе с вёрсткой их сайта.
 */
function parseDays(raw) {
    return matchDays(raw && raw.periods_days) || parseDaysFromHtml(raw && raw.periods);
}

/**
 * Ответ ПЭК → массив предложений. Авто и авиа — разные варианты доставки, а не
 * одна строка с выбором: разница по этому маршруту семикратная (12 900 против
 * 91 500), и прятать её от заказчика неправильно.
 *
 * Забор и доставка считаются перевозчиком всегда, но в итог попадают только
 * если человек их заказывал: до терминала многие возят сами.
 */
function parsePecomResponse(raw, { doorFrom = true, doorTo = true } = {}) {
    if (!raw || typeof raw !== 'object') return [];
    if (raw.error) return [];

    // Округляем каждую составляющую, а итог считаем их суммой. Иначе разбивка
    // на экране не сойдётся с итогом: страхование приходит как 681.6, и
    // округление только итога дало бы «682 + ... = 17581».
    const pickup = doorFrom ? Math.round(priceOf(raw.take) || 0) : 0;
    const delivery = doorTo ? Math.round(priceOf(raw.deliver) || 0) : 0;
    const insurance = Math.round(additionalService(raw, /страхован/i));
    const days = parseDays(raw);
    const calculatedAt = new Date().toISOString();

    const quotes = [];
    for (const [service, entry] of [['auto', raw.auto], ['avia', raw.avia]]) {
        const rawLine = priceOf(entry);
        if (rawLine === null) continue;
        const line = Math.round(rawLine);
        quotes.push({
            carrier: CARRIER,
            carrierName: CARRIER_NAME,
            service,
            price: {
                total: line + pickup + delivery + insurance,
                line,
                pickup,
                delivery,
                insurance,
            },
            days: service === 'avia' ? (parseDaysFromHtml(raw.aperiods) || days) : days,
            doorToDoor: doorFrom && doorTo,
            url: ORDER_URL,
            calculatedAt,
        });
    }
    return quotes;
}

/**
 * Расчёт по маршруту. from/to — точки из lib/logistics/geo.js.
 * Возвращает пустой массив, если у ПЭК нет кода для города: это не ошибка,
 * а «по этому маршруту перевозчик не считает».
 */
async function quote({ from, to, places, insurance = 0, doorFrom = true, doorTo = true }) {
    const fromCode = from && from.codes && from.codes.pecom;
    const toCode = to && to.codes && to.codes.pecom;
    if (!fromCode || !toCode) return [];
    if (!Array.isArray(places) || places.length === 0) return [];

    const url = `${CALC_URL}?${buildQuery({ from: fromCode, to: toCode, places, insurance })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`ПЭК: расчёт вернул ${res.status}`);
    return parsePecomResponse(await res.json(), { doorFrom, doorTo });
}

module.exports = {
    quote,
    parsePecomResponse,
    buildQuery,
    parseDays,
    parseDaysFromHtml,
    CARRIER,
    CARRIER_NAME,
    CALC_URL,
};
