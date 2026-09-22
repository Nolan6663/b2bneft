'use strict';

// Панель поискового спроса — ТЗ §13.3.
//
// Журнал внутреннего поиска копится с августа, но посмотреть на него было
// негде. Здесь три среза, по которым редактор решает, чего каталогу не хватает:
// что ищут, что не находят и чего справочник не знает вовсе.
//
// Публикация по частотности запрещена (ТЗ §8.4): панель готовит материал,
// решение принимает человек. Поэтому никаких «создать страницу автоматически»
// тут нет и не будет — только предложения с объяснением, почему именно такое.

const express = require('express');
const { summarize, clusterize, buildQueue, growth } = require('../lib/search-demand');

const WINDOW_DAYS = 30;
const TOP_LIMIT = 100;

function createSearchDemandRouter(deps) {
    const { pool, requireAuth, requireRole } = deps;
    const router = express.Router();
    // Панель спроса — рабочий инструмент SEO-специалиста (ответ маркетинга
    // 22.09, пункт 5). Журнал поиска обезличен: в нём тексты запросов, а не
    // авторы, — поэтому доступ сюда не требует прав администратора.
    const admin = [requireAuth, requireRole('admin', 'seo')];

    function windowDays(req) {
        const n = Number(req.query.days);
        return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : WINDOW_DAYS;
    }

    /** Сырые строки журнала за период. Агрегируем в JS, а не в SQL: кластеризация
     *  всё равно требует разбора слов, и тащить её в запрос смысла нет. */
    async function rowsFor(days) {
        const { rows } = await pool.query(`
            SELECT query_normalized, results_count, conversion, role, clicked_entity, created_at
              FROM search_queries
             WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
             ORDER BY created_at DESC
             LIMIT 20000
        `, [days]);
        return rows;
    }

    async function dictionary() {
        const [{ rows: s }, { rows: p }] = await Promise.all([
            pool.query(`SELECT id, name, synonyms FROM services WHERE status <> 'archived'`),
            pool.query(`SELECT id, name, synonyms FROM products WHERE status <> 'archived'`),
        ]);
        const norm = r => ({ id: r.id, name: r.name, synonyms: Array.isArray(r.synonyms) ? r.synonyms : [] });
        return [...s.map(norm), ...p.map(norm)];
    }

    // ─────────────────── Общая сводка ───────────────────
    router.get('/summary', ...admin, async (req, res, next) => {
        const days = windowDays(req);
        try {
            /* Два равных периода подряд: рост считается сравнением, а не
               «стало больше, чем в прошлый раз я смотрел». */
            const { rows: [counts] } = await pool.query(`
                SELECT
                  COUNT(*) FILTER (WHERE created_at > NOW() - ($1::int * INTERVAL '1 day'))::int AS current,
                  COUNT(*) FILTER (WHERE created_at > NOW() - (2 * $1::int * INTERVAL '1 day')
                                     AND created_at <= NOW() - ($1::int * INTERVAL '1 day'))::int AS previous,
                  COUNT(*) FILTER (WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
                                     AND results_count = 0)::int AS zero,
                  COUNT(*) FILTER (WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
                                     AND conversion IS NOT NULL AND conversion <> '')::int AS converted
                  FROM search_queries
            `, [days]);

            const rows = await rowsFor(days);
            const items = summarize(rows);
            res.json({
                days,
                searches: counts.current,
                previousPeriod: counts.previous,
                growthPercent: growth(counts.current, counts.previous),
                uniqueQueries: items.length,
                zeroResultSearches: counts.zero,
                zeroResultShare: counts.current ? Math.round((counts.zero / counts.current) * 100) : 0,
                conversions: counts.converted,
            });
        } catch (e) { next(e); }
    });

    // ─────────────────── Что ищут ───────────────────
    router.get('/top', ...admin, async (req, res, next) => {
        try {
            const items = summarize(await rowsFor(windowDays(req)));
            res.json(items.slice(0, TOP_LIMIT).map(i => ({
                query: i.query, hits: i.hits, zeroHits: i.zeroHits,
                zeroRate: Math.round(i.zeroRate * 100),
                conversions: i.conversions, clicked: i.clicked,
                roles: i.roles, lastSeen: i.lastSeen,
            })));
        } catch (e) { next(e); }
    });

    // ─────────────────── Чего не находят ───────────────────
    // Самый ценный срез: это спрос, которого у нас нет.
    router.get('/zero', ...admin, async (req, res, next) => {
        try {
            const items = summarize(await rowsFor(windowDays(req)))
                .filter(i => i.zeroHits > 0)
                .sort((a, b) => b.zeroHits - a.zeroHits);
            res.json(items.slice(0, TOP_LIMIT).map(i => ({
                query: i.query, hits: i.hits, zeroHits: i.zeroHits,
                zeroRate: Math.round(i.zeroRate * 100), lastSeen: i.lastSeen,
            })));
        } catch (e) { next(e); }
    });

    // ─────────────────── Кластеры ───────────────────
    router.get('/clusters', ...admin, async (req, res, next) => {
        try {
            const clusters = clusterize(summarize(await rowsFor(windowDays(req))));
            res.json(clusters.slice(0, TOP_LIMIT).map(c => ({
                lead: c.lead, queries: c.queries, hits: c.hits,
                zeroHits: c.zeroHits, zeroRate: Math.round(c.zeroRate * 100),
                conversions: c.conversions,
            })));
        } catch (e) { next(e); }
    });

    // ─────────────────── Очередь решений ───────────────────
    // ТЗ §8.3: редактор выбирает — улучшить страницу, добавить синоним, завести
    // сущность или посадочную. Панель раскладывает спрос по этим корзинам.
    router.get('/queue', ...admin, async (req, res, next) => {
        try {
            const [rows, dict] = await Promise.all([rowsFor(windowDays(req)), dictionary()]);
            const queue = buildQueue(rows, dict).filter(i => i.suggestion.action !== 'noise');

            const buckets = { new_entity: [], synonym: [], no_supply: [], covered: [] };
            for (const i of queue) {
                buckets[i.suggestion.action].push({
                    query: i.query, hits: i.hits, zeroRate: Math.round(i.zeroRate * 100),
                    why: i.suggestion.why, entity: i.suggestion.entity || null,
                });
            }
            res.json({
                days: windowDays(req),
                // Порядок полей — порядок разбора: сначала то, чего нет вовсе.
                newEntity: buckets.new_entity,
                synonym: buckets.synonym,
                noSupply: buckets.no_supply,
                covered: buckets.covered,
            });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = { createSearchDemandRouter, WINDOW_DAYS, TOP_LIMIT };
