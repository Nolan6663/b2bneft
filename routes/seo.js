'use strict';

const express = require('express');

function createSeoRouter(deps) {
    const {
        pool,
        requireAuth,
        requireRole,
        genAI,
    } = deps;

    const router = express.Router();

    // ===================== SEO =====================
    const seoAuditor = require('../seo/auditor');
    const seoGsc = require('../seo/gsc');
    const seoYandex = require('../seo/yandex');
    const seoIntents = require('../seo/intents');
    
    router.post('/audit', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const results = await seoAuditor.auditAll();
            for (const r of results) {
                await pool.query(
                    'INSERT INTO seo_audits (page, score, issues) VALUES ($1, $2, $3)',
                    [r.page, r.score, JSON.stringify(r.issues)]
                );
            }
            res.json(results);
        } catch (e) { next(e); }
    });
    
    router.post('/sync', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const end   = new Date().toISOString().slice(0, 10);
            const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    
            const [gscRows, yandexRows] = await Promise.all([
                seoGsc.enabled    ? seoGsc.fetchSearchAnalytics(start, end) : [],
                seoYandex.enabled ? seoYandex.fetchQueries(start, end)      : [],
            ]);
    
            const allRows = [...gscRows, ...yandexRows];
            for (const r of allRows) {
                await pool.query(
                    `INSERT INTO seo_snapshots (source, date, query, page, impressions, clicks, ctr, position)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (source, date, query, page)
                     DO UPDATE SET impressions=$5, clicks=$6, ctr=$7, position=$8`,
                    [r.source, r.date, r.query, r.page, r.impressions, r.clicks, r.ctr, r.position]
                );
            }
    
            const uniqueQueries = [...new Set(allRows.map(r => r.query))];
            await seoIntents.classifyIntents(uniqueQueries, genAI, pool);
    
            const { rows: [lg] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='google'`);
            const { rows: [ly] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='yandex'`);
    
            res.json({
                synced: allRows.length,
                newQueries: uniqueQueries.length,
                lastSync: { google: lg?.d || null, yandex: ly?.d || null },
            });
        } catch (e) { next(e); }
    });
    
    router.get('/data', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            // latest audit result per page
            const { rows: auditRows } = await pool.query(`
                SELECT DISTINCT ON (page) page, score, issues, audited_at
                FROM seo_audits
                ORDER BY page, audited_at DESC
            `);
    
            // latest snapshot per (source, query) with intent join
            const { rows: snapRows } = await pool.query(`
                SELECT s.source, s.query, s.page, s.impressions, s.clicks, s.ctr, s.position, s.date,
                       i.intent, i.intent_ru
                FROM seo_snapshots s
                LEFT JOIN seo_intents i ON i.query = s.query
                WHERE s.date = (
                    SELECT MAX(s2.date) FROM seo_snapshots s2
                    WHERE s2.source = s.source AND s2.query = s.query
                )
                ORDER BY s.impressions DESC
                LIMIT 1000
            `);
    
            // compute delta vs previous snapshot for each row
            const snapshots = await Promise.all(snapRows.map(async s => {
                const { rows: [prev] } = await pool.query(
                    `SELECT position FROM seo_snapshots
                     WHERE source=$1 AND query=$2 AND date < $3
                     ORDER BY date DESC LIMIT 1`,
                    [s.source, s.query, s.date]
                );
                const delta = prev ? parseFloat((s.position - prev.position).toFixed(2)) : null;
                return { ...s, delta };
            }));
    
            const { rows: [lg] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='google'`);
            const { rows: [ly] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='yandex'`);
    
            res.json({
                audit: auditRows,
                gscEnabled: seoGsc.enabled,
                yandexEnabled: seoYandex.enabled,
                snapshots,
                lastSync: { google: lg?.d || null, yandex: ly?.d || null },
            });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createSeoRouter;
