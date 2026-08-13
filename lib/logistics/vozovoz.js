'use strict';

// Расчёт доставки Возовозом.
//
// Третий перевозчик. Вторым напрашивался КИТ — токен получен, но их API
// (capi.gtdel.com) с 21.07.2026 отдаёт просроченный сертификат `*.gtdel.com`,
// и любой клиент, который проверяет TLS, к нему не подключается. Ждать чужой
// починки, держа расчёт на двух перевозчиках, смысла не было.
//
// Ключ бесплатный, заводится в личном кабинете, лежит в VOZOVOZ_TOKEN. Без
// ключа модуль молча выпадает из расчёта — остальные считают как обычно.
// VOZOVOZ_API_URL переключает на демо-сервер: там свой публичный ключ из их
// документации и свои тарифы, для проверки формата этого хватает.
//
// Чем этот API отличается от двух предыдущих:
//
// 1. ПУНКТ ЗАДАЁТСЯ НАЗВАНИЕМ — и именно поэтому названия мы не передаём.
//    На «Москва» их справочник отвечает семью записями (город федерального
//    значения, деревня в Кировской области, СНТ под Сергиевым Посадом), API
//    всё равно считает и кладёт в ответ warnings «не содержит уникального
//    значения». То есть выбор делается за нас и молча. Поэтому в расчёт уходит
//    только guid, добытый нашим же поиском, а любой warning про location
//    считается отказом: цена, посчитанная неизвестно откуда, хуже её отсутствия.
//
// 2. ЕДИНИЦЫ ЧЕСТНЫЕ — объём в м³, вес в кг, как у нас. Проверено живыми
//    запросами 13.08.2026: при 1 м³ вес 0.5 и 5 кг дают одну цену (платная
//    масса считается по объёму), 500 кг — 13 890, 5000 кг — 188 620. Тонн,
//    на которых поймали Деловые Линии, здесь нет.
//
// 3. НЕСУЩЕСТВУЮЩИЙ И БЕЗТЕРМИНАЛЬНЫЙ ГОРОД ОТДАЮТ ОШИБКУ 13001, а не
//    правдоподобную цену. Это единственный из трёх наших перевозчиков, который
//    в такой ситуации не молчит. Но ошибка эта означает «сюда не возим», а не
//    «мы сломались», поэтому она превращается в пустой ответ, а не в исключение:
//    иначе интерфейс сказал бы «Возовоз не ответил», что неправда.

const { normalizeCityName } = require('./geo');

const DEFAULT_API_URL = 'https://vozovoz.ru/api/';
const ORDER_URL = 'https://vozovoz.ru/';
const TIMEOUT_MS = 8000;

const CARRIER = 'vozovoz';
const CARRIER_NAME = 'Возовоз';

// Их код «отсутствуют входящие данные»: город не найден либо у него нет
// терминала. Оба случая — про маршрут, а не про поломку.
const NO_ROUTE_ERROR = 13001;

// Услуги в ответе различаются по названию: отдельных кодов у них нет.
const PICKUP_SERVICE = /забор груза/i;
const DELIVERY_SERVICE = /отвоз груза/i;
const INSURANCE_SERVICE = /страхован/i;

// Ключ и адрес читаем при каждом вызове, а не при загрузке модуля: тесты и
// скрипты поднимают окружение в разном порядке.
function token() {
    return process.env.VOZOVOZ_TOKEN || '';
}

function apiUrl() {
    return process.env.VOZOVOZ_API_URL || DEFAULT_API_URL;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Запрос к их единственному эндпоинту: объект и действие лежат в теле. */
async function call(body) {
    const res = await fetch(`${apiUrl()}?token=${encodeURIComponent(token())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Возовоз: ${body.object} вернул ${res.status}`);
    return res.json();
}

/**
 * Выбор пункта среди найденного их поиском.
 *
 * Правило то же, что в lib/logistics/geo.js: не угадывать. Совпадение по
 * названию должно быть точным, у пункта должен быть терминал, город
 * предпочитается посёлку. А дальше главное: если у оставшихся кандидатов
 * терминалы РАЗНЫЕ — это настоящая неоднозначность, и мы отказываемся.
 * На «Дубровка» их справочник отдаёт двадцать точных совпадений с пятью
 * разными терминалами; выбрать любой значит однажды показать человеку цену до
 * другого конца страны.
 *
 * Обратное тоже верно и потому проверяется отдельно: у «Москвы» записей семь,
 * но терминал у всех один и тот же, и отказываться там не от чего.
 */
function pickLocation(locations, name) {
    const key = normalizeCityName(name);
    if (!key) return null;

    const exact = (locations || []).filter((l) => normalizeCityName(l.name) === key);
    const withTerminal = exact.filter((l) => l.default_terminal && l.default_terminal.guid);
    if (withTerminal.length === 0) return null;

    const towns = withTerminal.filter((l) => l.type === 'г');
    const pool = towns.length ? towns : withTerminal;

    const terminals = new Set(pool.map((l) => l.default_terminal.guid));
    if (terminals.size > 1) return null;   // разные терминалы — выбирать нам нельзя

    return pool[0].guid || null;
}

/** Название города → guid Возовоза. null, если не нашли, нет ключа или неоднозначно. */
async function findCityGuid(name) {
    if (!token() || !String(name || '').trim()) return null;
    const data = await call({
        object: 'location',
        params: { search: String(name).trim(), limit: 20 },
    });
    return pickLocation(data && data.response && data.response.data, name);
}

/** Габариты мест → количество, объём в м³ и вес в кг, как ждёт их калькулятор. */
function sizeOf(places) {
    let volume = 0;
    let weight = 0;
    let quantity = 0;
    for (const p of places) {
        const w = Number(p.width) || 0;
        const l = Number(p.length) || 0;
        const h = Number(p.height) || 0;
        volume += Number(p.volume) || w * l * h;
        weight += Number(p.weight) || 0;
        quantity += 1;
    }
    return { quantity, volume: Number(volume.toFixed(3)), weight: Number(weight.toFixed(3)) };
}

/**
 * Пункт маршрута.
 *
 * До терминала — `terminal: 'default'`. До двери — только location, БЕЗ адреса:
 * улицы в сделке у нас нет, а выдуманная опасна. Проверено живыми запросами:
 * несуществующий адрес не отвергается, а молча заменяется базовым тарифом по
 * городу — то есть выдумывание не дало бы ничего, кроме ложной точности.
 * Реальный адрес цену меняет (центр Москвы добавил 460 руб. к забору), поэтому
 * забор и доставка здесь — нижняя граница, о чём и говорит оговорка на странице.
 */
function point(guid, door) {
    return door ? { point: { location: guid } } : { point: { location: guid, terminal: 'default' } };
}

function serviceSum(services, pattern) {
    return (services || [])
        .filter((s) => pattern.test(String(s.name || '')))
        .reduce((sum, s) => sum + money(s.price), 0);
}

/**
 * Ответ Возовоза → список предложений.
 *
 * Возвращают одно предложение — наземную перевозку; экспресса и авиа в этом
 * API нет, поэтому service всегда 'auto'.
 *
 * Страхование вычитаем из итога. У них это «страхование груза без объявленной
 * стоимости» и входит в price по умолчанию, у Деловых Линий считается своими
 * правилами, у ПЭК зависит от объявленной стоимости. Три разные величины в
 * одной колонке сортировались бы как сравнение разного — поэтому во всех трёх
 * модулях страховка вынесена из total и показывается отдельно.
 *
 * Разбивка сходится с их же полем price: 12 651 перевозка + 960 склад + 179
 * страховка + 100 платный въезд = 13 890. Тест это соотношение закрепляет —
 * разойдётся, значит состав ответа поменялся.
 */
function parseVozovozResponse(raw, { doorFrom = true, doorTo = true } = {}) {
    const response = raw && raw.response;
    if (!response || !Number.isFinite(Number(response.price))) return [];

    // Предупреждение про location означает, что пункт выбран не нами. Считать
    // такой ответ ценой нельзя — см. пункт 1 в шапке файла.
    if ((response.warnings || []).some((w) => /location/i.test(String(w)))) return [];

    const services = response.service || [];
    const insurance = serviceSum(services, INSURANCE_SERVICE);
    const pickup = serviceSum(services, PICKUP_SERVICE);
    const delivery = serviceSum(services, DELIVERY_SERVICE);
    const total = money(response.price) - insurance;

    const time = response.deliveryTime;
    const days = time && Number.isFinite(Number(time.from)) && Number(time.from) > 0
        ? { min: Number(time.from), max: Number(time.to) || Number(time.from) }
        : null;

    return [{
        carrier: CARRIER,
        carrierName: CARRIER_NAME,
        service: 'auto',
        price: {
            total,
            line: total - pickup - delivery,
            pickup,
            delivery,
            insurance,
        },
        days,
        doorToDoor: doorFrom && doorTo,
        url: ORDER_URL,
        calculatedAt: new Date().toISOString(),
    }];
}

/**
 * Расчёт по маршруту. from/to — точки из lib/logistics/geo.js.
 * Пустой массив означает «этот перевозчик по этому маршруту не считает»:
 * нет ключа, нет guid, нет габаритов, нет терминала в городе.
 */
// insurance в параметрах нет намеренно: объявленную стоимость их публичный
// расчёт не принимает, страховку считает сам. Общий контракт это допускает —
// перевозчик берёт из запроса то, что умеет.
async function quote({ from, to, places, doorFrom = true, doorTo = true }) {
    const fromGuid = from && from.codes && from.codes.vozovoz;
    const toGuid = to && to.codes && to.codes.vozovoz;
    if (!token() || !fromGuid || !toGuid) return [];
    if (!Array.isArray(places) || places.length === 0) return [];

    const { quantity, volume, weight } = sizeOf(places);
    if (volume <= 0 || weight <= 0) return [];

    const data = await call({
        object: 'price',
        action: 'get',
        params: {
            cargo: { dimension: { quantity, volume, weight } },
            gateway: {
                dispatch: point(fromGuid, doorFrom),
                destination: point(toGuid, doorTo),
            },
        },
    });

    if (data && data.error) {
        if (Number(data.error.code) === NO_ROUTE_ERROR) return [];   // сюда не возят
        throw new Error(`Возовоз: ${data.error.message || 'расчёт не прошёл'}`);
    }
    return parseVozovozResponse(data, { doorFrom, doorTo });
}

module.exports = {
    quote,
    findCityGuid,
    pickLocation,
    parseVozovozResponse,
    sizeOf,
    CARRIER,
    CARRIER_NAME,
    ORDER_URL,
    DEFAULT_API_URL,
};
