'use strict';

const express = require('express');

function createFavoritesRouter(deps) {
    const { pool, requireAuth, rowToCompany, enrichCompany, rowToOrder } = deps;

    const router = express.Router();

    router.get('/', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                'SELECT c.* FROM companies c JOIN favorites f ON c.id = f.company_id WHERE f.owner_company = $1',
                [req.user.company]
            );
            const enriched = await Promise.all(rows.map(r => enrichCompany(rowToCompany(r), req.user.company)));
            res.json(enriched);
        } catch (e) { next(e); }
    });

    router.post('/', requireAuth, async (req, res, next) => {
        try {
            const id = Number(req.body.companyId);
            if (!id) return res.status(400).json({ error: 'Не указан ID компании' });
            const { rows: [exists] } = await pool.query('SELECT 1 FROM companies WHERE id = $1', [id]);
            if (!exists) return res.status(404).json({ error: 'Компания не найдена' });
            await pool.query(
                'INSERT INTO favorites (owner_company, company_id) VALUES ($1, $2) ON CONFLICT (owner_company, company_id) DO NOTHING',
                [req.user.company, id]
            );
            res.status(201).json({ message: 'Добавлено в избранное' });
        } catch (e) { next(e); }
    });

    // ── Избранные закупки ────────────────────────────────────────────────────
    // Закладка на чужую закупку: поставщик метит те, куда собирается ответить.
    // Объявлено до /:companyId — иначе одиночный сегмент перехватит /orders/7.
    router.get('/orders', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT o.* FROM orders o
                 JOIN favorite_orders f ON o.id = f.order_id
                 WHERE f.owner_company = $1
                 ORDER BY f.created_at DESC`,
                [req.user.company]
            );
            res.json(rows.map(rowToOrder));
        } catch (e) { next(e); }
    });

    router.post('/orders', requireAuth, async (req, res, next) => {
        try {
            const id = Number(req.body.orderId);
            if (!id) return res.status(400).json({ error: 'Не указан ID закупки' });
            const { rows: [exists] } = await pool.query('SELECT 1 FROM orders WHERE id = $1', [id]);
            if (!exists) return res.status(404).json({ error: 'Закупка не найдена' });
            await pool.query(
                'INSERT INTO favorite_orders (owner_company, order_id) VALUES ($1, $2) ON CONFLICT (owner_company, order_id) DO NOTHING',
                [req.user.company, id]
            );
            res.status(201).json({ message: 'Закупка добавлена в избранное' });
        } catch (e) { next(e); }
    });

    router.delete('/orders/:orderId', requireAuth, async (req, res, next) => {
        try {
            await pool.query(
                'DELETE FROM favorite_orders WHERE owner_company = $1 AND order_id = $2',
                [req.user.company, Number(req.params.orderId)]
            );
            res.json({ message: 'Закупка удалена из избранного' });
        } catch (e) { next(e); }
    });

    // ── Сохранённые поиски ───────────────────────────────────────────────────
    // Живут рядом с избранным: то же «отложить на потом», только не компания, а
    // набор фильтров каталога. Объявлены до /:companyId — иначе одиночный
    // сегмент перехватит удаление поиска.
    const MAX_SEARCHES = 20;

    function parseParams(raw) {
        try {
            const v = JSON.parse(raw || '{}');
            return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        } catch { return {}; }
    }

    router.get('/searches', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                'SELECT id, name, params, created_at FROM saved_searches WHERE owner_company = $1 ORDER BY created_at DESC',
                [req.user.company]
            );
            res.json(rows.map(r => ({
                id: r.id,
                name: r.name,
                params: parseParams(r.params),
                createdAt: r.created_at,
            })));
        } catch (e) { next(e); }
    });

    router.post('/searches', requireAuth, async (req, res, next) => {
        try {
            const name = String(req.body.name || '').trim().slice(0, 80);
            const params = req.body.params;
            if (!name) return res.status(400).json({ error: 'Не указано название поиска' });
            if (!params || typeof params !== 'object' || Array.isArray(params)) {
                return res.status(400).json({ error: 'Параметры поиска должны быть объектом' });
            }
            const json = JSON.stringify(params);
            if (json.length > 2000) return res.status(400).json({ error: 'Слишком много параметров поиска' });

            const { rows: [{ count }] } = await pool.query(
                'SELECT COUNT(*)::int AS count FROM saved_searches WHERE owner_company = $1',
                [req.user.company]
            );
            if (Number(count) >= MAX_SEARCHES) {
                return res.status(409).json({ error: `Сохранено уже ${MAX_SEARCHES} поисков — удалите лишние` });
            }

            const { rows: [row] } = await pool.query(
                'INSERT INTO saved_searches (owner_company, name, params) VALUES ($1, $2, $3) RETURNING id',
                [req.user.company, name, json]
            );
            res.status(201).json({ id: row.id, message: 'Поиск сохранён' });
        } catch (e) { next(e); }
    });

    router.delete('/searches/:id', requireAuth, async (req, res, next) => {
        try {
            await pool.query(
                'DELETE FROM saved_searches WHERE owner_company = $1 AND id = $2',
                [req.user.company, Number(req.params.id)]
            );
            res.json({ message: 'Поиск удалён' });
        } catch (e) { next(e); }
    });

    router.delete('/:companyId', requireAuth, async (req, res, next) => {
        try {
            await pool.query('DELETE FROM favorites WHERE owner_company = $1 AND company_id = $2', [req.user.company, Number(req.params.companyId)]);
            res.json({ message: 'Удалено из избранного' });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createFavoritesRouter;
