'use strict';

const express = require('express');

function createReviewsRouter(deps) {
    const { pool, requireAuth } = deps;

    const router = express.Router();

    router.post('/', requireAuth, async (req, res, next) => {
        try {
            const { orderId, toCompany, score, text = '' } = req.body;
            if (!orderId || !toCompany || !score) return res.status(400).json({ error: 'Заполните все поля' });
            const s = Number(score);
            if (s < 1 || s > 5) return res.status(400).json({ error: 'Оценка от 1 до 5' });

            const { rows: [deal] } = await pool.query(
                `SELECT 1 FROM proposals p JOIN orders o ON o.id=p.order_id
                 WHERE p.order_id=$1 AND p.company=$2 AND p.status='Выигран' AND o.company=$3`,
                [orderId, toCompany, req.user.company]
            );
            if (!deal) return res.status(403).json({ error: 'Отзыв доступен только после завершения сделки' });

            await pool.query(
                `INSERT INTO reviews (order_id,from_company,to_company,score,text)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (order_id,from_company,to_company) DO UPDATE SET score=$4, text=$5`,
                [orderId, req.user.company, toCompany, s, text.slice(0, 1000)]
            );
            res.json({ ok: true });
        } catch (e) { next(e); }
    });

    router.get('/company/:name', async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT from_company, score, text, created_at FROM reviews
                 WHERE to_company=$1 ORDER BY created_at DESC LIMIT 30`,
                [req.params.name]
            );
            const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length * 10) / 10 : null;
            res.json({ reviews: rows, avg, count: rows.length });
        } catch (e) { next(e); }
    });

    // Check if current user already reviewed a specific deal
    router.get('/check/:orderId/:toCompany', requireAuth, async (req, res, next) => {
        try {
            const { rows: [row] } = await pool.query(
                'SELECT score, text FROM reviews WHERE order_id=$1 AND from_company=$2 AND to_company=$3',
                [req.params.orderId, req.user.company, req.params.toCompany]
            );
            res.json(row || null);
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createReviewsRouter;
