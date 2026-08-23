'use strict';

/* Подсказки адресов для расчёта доставки.
 *
 * Зачем понадобились. До сих пор в расчёте вводился только город, и заказчик
 * жаловался ровно на это: «от точного адреса до точного адреса не даёт
 * выбирать». Плюс город, набранный руками, — источник той самой истории с
 * Зеленоградом, где человек видел город в подсказках, но закреплялась
 * промзона. Из выбранного адреса город достаётся однозначно.
 *
 * Почему через свой сервер, а не из браузера. Ключ подсказок DaData штатно
 * светят на клиенте, но квота у него общая — 10 000 подсказок в сутки на весь
 * аккаунт. Ключ, лежащий в исходниках страницы, любой желающий выжигает за
 * вечер, и расчёт доставки перестаёт работать у всех. Поэтому запрос идёт
 * через наш роут, там же кэш и ограничение частоты.
 *
 * Что мы НЕ используем: секретный ключ и «стандартизацию» адресов. Это платная
 * часть, и для подсказок она не нужна.
 */

const SUGGEST_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const TIMEOUT_MS = 4000;
const MAX_COUNT = 7;

/* Кэш на процесс: одни и те же префиксы набирают десятки раз («мос», «моск»,
   «москв»), и каждый такой набор — это списанная подсказка из суточной квоты. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

function isConfigured() {
    return Boolean((process.env.DADATA_API_KEY || '').trim());
}

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
    return hit.value;
}

function cacheSet(key, value) {
    // Простая отсечка по размеру: словарь префиксов растёт бесконечно, а живут
    // в нём в основном разовые запросы.
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { value, ts: Date.now() });
}

/**
 * Ответ DaData → то, что нужно расчёту.
 *
 * `city` берём в порядке убывания точности: город, затем населённый пункт
 * (село, посёлок), затем сам район — иначе для адреса в посёлке городом
 * окажется пусто, и расчёт не найдёт кода перевозчика.
 */
function normalize(suggestion) {
    const d = suggestion.data || {};
    const city = d.city || d.settlement || d.area || d.region || '';
    return {
        value: suggestion.value || '',
        city: String(city).trim(),
        region: d.region_with_type || '',
        postalCode: d.postal_code || '',
        lat: d.geo_lat ? Number(d.geo_lat) : null,
        lon: d.geo_lon ? Number(d.geo_lon) : null,
        // fias_level говорит, до чего доведён адрес: 8 — дом, 7 — улица.
        // Ниже улицы для доставки бессмысленно, но запрещать не будем —
        // человек может искать по городу и уточнить потом.
        hasHouse: Boolean(d.house),
    };
}

async function suggestAddress(query, count = 5) {
    const q = String(query || '').trim();
    if (!isConfigured() || q.length < 3) return [];

    const key = q.toLowerCase() + '|' + count;
    const cached = cacheGet(key);
    if (cached) return cached;

    const res = await fetch(SUGGEST_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Token ${(process.env.DADATA_API_KEY || '').trim()}`,
        },
        body: JSON.stringify({
            query: q,
            count: Math.min(Number(count) || 5, MAX_COUNT),
            // Россия. Заказы за пределы страны площадка не ведёт, а лишние
            // страны в подсказках только путают.
            locations: [{ country: 'Россия' }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
        const err = new Error(`DaData HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }

    const data = await res.json();
    const out = (data.suggestions || []).map(normalize).filter(s => s.value && s.city);
    cacheSet(key, out);
    return out;
}

module.exports = { isConfigured, suggestAddress, normalize };
