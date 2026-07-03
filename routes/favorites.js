'use strict';

const express = require('express');

function createFavoritesRouter(deps) {
    const { pool, requireAuth, rowToCompany, enrichCompany } = deps;

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

    router.delete('/:companyId', requireAuth, async (req, res, next) => {
        try {
            await pool.query('DELETE FROM favorites WHERE owner_company = $1 AND company_id = $2', [req.user.company, Number(req.params.companyId)]);
            res.json({ message: 'Удалено из избранного' });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createFavoritesRouter;
