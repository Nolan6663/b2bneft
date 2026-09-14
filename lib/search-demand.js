'use strict';

// Разбор накопленного внутреннего спроса — ТЗ §8.3 и §13.3.
//
// Таблица search_queries пишется больше месяца, но увидеть накопленное до сих
// пор было негде. Между «данные собираются» и «данными пользуются» лежит ровно
// этот модуль: он сводит отдельные строки в картину, по которой редактор решает,
// чего каталогу не хватает.
//
// Главная ценность — не топ запросов, а два других среза:
//
//   • Запросы с нулём результатов. Это спрос, которого у нас нет: человек искал
//     и ушёл ни с чем. Каждая такая строка — кандидат на синоним, сущность или
//     страницу (ТЗ §8.3).
//
//   • Запросы, которым нечего сопоставить в справочнике. Отличается от нуля
//     результатов: каталог что-то показал, но справочник про эту тему не знает,
//     а значит и посадочной страницы под неё не будет никогда.
//
// Решение принимает человек. Автоматическая публикация по частотности запрещена
// ТЗ §8.4 и «Краулинговым бюджетом» — здесь только подготовка материала.

const { buildIndex, matchEntries, tokens, sameStem } = require('./catalog-match');

/* Ниже этого числа обращений фраза ничего не доказывает: один человек мог
   искать пять раз подряд, исправляя опечатку. Порог намеренно низкий — данных
   пока мало, и терять сигнал хуже, чем показать лишнюю строку. */
const MIN_HITS = 2;

/**
 * Сводка по нормализованным фразам.
 * @param {Array} rows строки search_queries: query_normalized, results_count,
 *                     conversion, role, created_at
 */
function summarize(rows) {
    const by = new Map();
    for (const r of rows || []) {
        const key = String(r.query_normalized || '').trim();
        if (!key) continue;
        let item = by.get(key);
        if (!item) {
            item = {
                query: key, hits: 0, zeroHits: 0, conversions: 0,
                roles: new Set(), lastSeen: null, clicked: 0,
            };
            by.set(key, item);
        }
        item.hits++;
        if (Number(r.results_count) === 0) item.zeroHits++;
        if (r.conversion) item.conversions++;
        if (r.clicked_entity) item.clicked++;
        if (r.role) item.roles.add(r.role);
        const at = r.created_at ? new Date(r.created_at) : null;
        if (at && (!item.lastSeen || at > item.lastSeen)) item.lastSeen = at;
    }
    return [...by.values()].map(i => ({
        ...i,
        roles: [...i.roles],
        // Доля пустых выдач важнее их числа: фраза, которая иногда находится,
        // а иногда нет, — это проблема ранжирования, а всегда пустая — дыра
        // в каталоге.
        zeroRate: i.hits ? i.zeroHits / i.hits : 0,
    })).sort((a, b) => b.hits - a.hits);
}

/**
 * Склейка близких фраз в кластеры. «изготовление валов», «валы на заказ» и
 * «вал ступенчатый» — один спрос, и заводить под них три страницы нельзя.
 *
 * Алгоритм намеренно простой: фразы попадают в один кластер, если делят хотя бы
 * один значимый корень. Это грубее настоящей кластеризации по выдаче, которую
 * ТЗ §18.2 требует от SEO-специалиста, но своей задачи — не дать редактору
 * проглядеть, что две строки об одном, — достигает.
 */
function clusterize(items) {
    const clusters = [];
    for (const item of items || []) {
        const t = tokens(item.query);
        if (!t.size) continue;
        let target = null;
        for (const c of clusters) {
            for (const stem of t) {
                if ([...c.stems].some(s => sameStem(s, stem))) { target = c; break; }
            }
            if (target) break;
        }
        if (!target) {
            target = { lead: item.query, stems: new Set(), items: [], hits: 0, zeroHits: 0, conversions: 0 };
            clusters.push(target);
        }
        for (const stem of t) target.stems.add(stem);
        target.items.push(item);
        target.hits += item.hits;
        target.zeroHits += item.zeroHits;
        target.conversions += item.conversions;
    }
    return clusters
        .map(c => ({
            lead: c.items[0].query,
            queries: c.items.map(i => i.query),
            hits: c.hits,
            zeroHits: c.zeroHits,
            conversions: c.conversions,
            zeroRate: c.hits ? c.zeroHits / c.hits : 0,
        }))
        .sort((a, b) => b.hits - a.hits);
}

/**
 * Что делать с фразой. Решение остаётся за редактором, здесь — предложение.
 *
 * @param {object} item      строка из summarize
 * @param {object} dictIndex индекс справочника из buildIndex
 */
function classify(item, dictIndex) {
    if (item.hits < MIN_HITS) return { action: 'noise', why: 'слишком мало обращений, чтобы о чём-то судить' };

    const matched = matchEntries(item.query, dictIndex);
    if (matched.length) {
        // Справочник тему знает. Если при этом каталог ничего не находит, дело
        // не в структуре, а в наполнении: подходящих предприятий просто нет.
        return item.zeroRate > 0.5
            ? { action: 'no_supply', why: `есть в справочнике («${matched[0].name}»), но каталог ничего не находит`, entity: matched[0].name }
            : { action: 'covered', why: `покрыто справочником («${matched[0].name}»)`, entity: matched[0].name };
    }

    if (item.zeroRate > 0.5) {
        return { action: 'new_entity', why: 'справочник не знает темы, и каталог ничего не находит' };
    }
    // Каталог что-то показывает, но справочник тему не знает — чаще всего это
    // синоним к существующей сущности, и завести его дешевле, чем новую запись.
    return { action: 'synonym', why: 'каталог находит, но справочник тему не знает — похоже на синоним' };
}

/** Рост спроса: сравнение двух равных периодов. Возвращает null, когда сравнивать
 *  не с чем, — «рост на 100%» с нуля обращений вводит в заблуждение. */
function growth(current, previous) {
    if (!previous) return current ? null : 0;
    return Math.round(((current - previous) / previous) * 100);
}

/** Полная подготовка панели: свести, разложить по действиям, отсортировать. */
function buildQueue(rows, dictionary) {
    const index = buildIndex(dictionary || []);
    const items = summarize(rows);
    return items.map(i => ({ ...i, suggestion: classify(i, index) }));
}

module.exports = { MIN_HITS, summarize, clusterize, classify, growth, buildQueue };
