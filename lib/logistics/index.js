'use strict';

// Реестр перевозчиков: опрашивает всех разом и сводит ответы в один список.
//
// Главное правило здесь — расчёт не падает целиком из-за одного перевозчика.
// Все API чужие и публичные, гарантий доступности нет ни у кого. Молчащий или
// упавший выпадает из выдачи и попадает в failed: интерфейс честно скажет
// «ПЭК не ответил», а не сделает вид, что вариантов и было меньше.
//
// Добавление перевозчика — это строчка в CARRIERS и новый модуль с тем же
// контрактом quote(params) → Quote[]. Ни этот файл, ни соседние модули при
// этом не меняются.

const crypto = require('crypto');

const CARRIERS = [require('./pecom'), require('./dellin'), require('./vozovoz')];

const CARRIER_TIMEOUT_MS = 8000;
const CACHE_TTL_HOURS = 24;

/**
 * Версия формата расчёта. Входит в ключ кэша, поэтому её увеличение делает все
 * старые записи недостижимыми.
 *
 * Поднимать при ЛЮБОМ изменении состава Quote или формулы цены. Иначе после
 * выкатки люди сутки видят числа, посчитанные по прежним правилам: ровно так и
 * случилось при выносе страхования из итога — проверка показывала новые суммы,
 * а интерфейс отдавал старые из кэша.
 *
 * 2 — страхование выведено из total (08.08.2026).
 */
const CACHE_VERSION = 2;

/**
 * Ключ кэша. Считается от точного запроса, а не от округлённых веса и объёма,
 * как предполагалось в плане: округление меняет тарифную ступень, и человек
 * увидел бы цену за другой груз. Повторы в жизни и так точные — одну и ту же
 * карточку КП открывают много раз.
 */
function cacheKey(carrier, { from, to, places, insurance = 0, doorFrom = true, doorTo = true }) {
    const normalized = JSON.stringify({
        v: CACHE_VERSION,
        from: from && from.id,
        to: to && to.id,
        places: (places || []).map((p) => [
            Number(p.width) || 0, Number(p.length) || 0, Number(p.height) || 0,
            Number(p.weight) || 0, p.oversized ? 1 : 0, p.hardPack ? 1 : 0,
        ]),
        insurance: Math.round(Number(insurance) || 0),
        doorFrom: Boolean(doorFrom),
        doorTo: Boolean(doorTo),
    });
    return `${carrier}:${crypto.createHash('sha1').update(normalized).digest('hex')}`;
}

/**
 * Сторожевой таймер поверх модуля перевозчика. Свой таймаут на fetch у модулей
 * есть, но зависнуть можно и не на сети — например на разборе ответа.
 */
function withTimeout(promise, ms, name) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name}: не ответил за ${ms} мс`)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function readCache(pool, key) {
    const { rows } = await pool.query(
        `SELECT payload FROM logistics_quotes_cache
          WHERE cache_key = $1 AND created_at > NOW() - INTERVAL '${CACHE_TTL_HOURS} hours'`,
        [key]
    );
    if (!rows[0]) return null;
    try {
        const parsed = JSON.parse(rows[0].payload);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;   // испорченная запись — считаем, что кэша нет
    }
}

async function writeCache(pool, key, carrier, quotes) {
    await pool.query(
        `INSERT INTO logistics_quotes_cache (cache_key, carrier, payload, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (cache_key) DO UPDATE
            SET payload = EXCLUDED.payload, created_at = NOW()`,
        [key, carrier, JSON.stringify(quotes)]
    );
}

/**
 * Удаляет протухшие записи кэша. TTL проверяется при чтении, но сами строки
 * без этого лежат вечно — таблица растёт, а пользы от них уже нет.
 * Зовётся из суточного крона в server.js.
 */
async function purgeExpiredQuotes(pool) {
    const { rowCount } = await pool.query(
        `DELETE FROM logistics_quotes_cache
          WHERE created_at < NOW() - INTERVAL '${CACHE_TTL_HOURS} hours'`
    );
    return rowCount || 0;
}

/** Дешевле — выше. Предложения без разобранного срока не тонут: цена важнее. */
function sortQuotes(quotes) {
    return quotes.slice().sort((a, b) => a.price.total - b.price.total);
}

async function quoteOne(pool, carrier, params, { useCache, timeoutMs }) {
    const key = cacheKey(carrier.CARRIER, params);

    if (useCache) {
        const cached = await readCache(pool, key);
        if (cached) return { quotes: cached, fromCache: true };
    }

    const quotes = await withTimeout(carrier.quote(params), timeoutMs, carrier.CARRIER_NAME);

    // Пустой ответ тоже кэшируем: «этот перевозчик сюда не возит» — такой же
    // результат, и переспрашивать его каждый раз незачем.
    if (useCache) {
        try {
            await writeCache(pool, key, carrier.CARRIER, quotes);
        } catch {
            // Кэш — ускорение, а не источник правды. Не смогли записать — отдаём расчёт.
        }
    }
    return { quotes, fromCache: false };
}

/**
 * Расчёт по всем перевозчикам.
 * Возвращает { quotes, failed, fromCache } — failed это имена тех, кто не ответил.
 */
async function quoteAll(pool, params, options = {}) {
    const {
        carriers = CARRIERS,
        useCache = true,
        timeoutMs = CARRIER_TIMEOUT_MS,
    } = options;

    const settled = await Promise.allSettled(
        carriers.map((carrier) => quoteOne(pool, carrier, params, { useCache, timeoutMs }))
    );

    const quotes = [];
    const failed = [];
    const fromCache = [];

    settled.forEach((result, i) => {
        const carrier = carriers[i];
        if (result.status === 'fulfilled') {
            quotes.push(...result.value.quotes);
            if (result.value.fromCache) fromCache.push(carrier.CARRIER);
        } else {
            failed.push(carrier.CARRIER_NAME);
        }
    });

    return { quotes: sortQuotes(quotes), failed, fromCache };
}

module.exports = {
    quoteAll,
    cacheKey,
    sortQuotes,
    withTimeout,
    purgeExpiredQuotes,
    CARRIERS,
    CARRIER_TIMEOUT_MS,
    CACHE_TTL_HOURS,
    CACHE_VERSION,
};
