'use strict';

// Пороги индексации живут в таблице catalog_settings, а не в константах кода.
//
// Это прямое требование маркетинга (вкладка «Ответы на вопросы разработчиков»,
// вопрос 1): «Пороги являются стартовыми и хранятся как настройки». До сих пор
// число 5 было записано в трёх местах — lib/region-seo.js, lib/equipment-seo.js
// и через импорт в server.js, — и поменять его можно было только релизом.
//
// Сложность в том, что решение «индексировать или нет» принимается во время
// отрисовки страницы: синхронно, на каждый запрос робота. Ходить за ним в базу
// каждый раз нельзя, поэтому значения держим в памяти и обновляем по TTL.
// Чтение синхронное, обновление — фоновое: запрос не ждёт базу никогда.
//
// Пока настройки не загружены (юнит-тесты, отдельные скрипты, первые
// миллисекунды после старта) возвращается значение по умолчанию из кода. Это
// намеренно: страница обязана отрисоваться разумно и с недоступной базой, а
// «порог не прочитался» не повод отдать роботу пустую витрину.

const TTL_MS = 60 * 1000;

let values = new Map();
let loadedAt = 0;
let pool = null;
let refreshing = null;

async function refresh() {
    if (!pool) return;
    try {
        const { rows } = await pool.query('SELECT key, value FROM catalog_settings');
        const next = new Map();
        for (const r of rows) next.set(r.key, r.value);
        values = next;
        loadedAt = Date.now();
    } catch (e) {
        // Недоступная база не должна ронять отрисовку: работаем на старом кэше
        // либо на значениях по умолчанию. Но молчать тоже нельзя.
        console.error('catalog-settings: не удалось прочитать настройки —', e.message);
        loadedAt = Date.now(); // не долбим базу в цикле на каждый запрос
    } finally {
        refreshing = null;
    }
}

/** Вызывается один раз при старте, из initDb. */
async function initSettings(p) {
    pool = p;
    await refresh();
    return values.size;
}

/** Фоновое обновление, если кэш протух. Вызывающий получает текущее значение
 *  немедленно — возможно, на секунду устаревшее. Для порогов индексации это
 *  несущественно, а блокировать отрисовку ради свежести — несоразмерно. */
function touch() {
    if (!pool || refreshing) return;
    if (Date.now() - loadedAt < TTL_MS) return;
    refreshing = refresh();
}

/**
 * Числовой порог по ключу.
 * @param {string} key      ключ в catalog_settings, например 'threshold.geo.supply'
 * @param {number} fallback значение по умолчанию из кода
 */
function getThreshold(key, fallback) {
    touch();
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    // Мусор в настройке не должен превращать порог в NaN и пускать в индекс всё
    // подряд: непонятное значение равнозначно его отсутствию.
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Строковая настройка — на будущее, для нечисловых значений. */
function getSetting(key, fallback = '') {
    touch();
    const raw = values.get(key);
    return raw === undefined ? fallback : raw;
}

/** Для тестов и скриптов: подставить значения без базы. */
function setForTesting(map) {
    values = new Map(Object.entries(map || {}).map(([k, v]) => [k, String(v)]));
    loadedAt = Date.now();
    pool = null;
}

/** Сбросить в «ничего не загружено» — тогда работают значения по умолчанию. */
function resetForTesting() {
    values = new Map();
    loadedAt = 0;
    pool = null;
    refreshing = null;
}

module.exports = { initSettings, getThreshold, getSetting, setForTesting, resetForTesting, TTL_MS };
