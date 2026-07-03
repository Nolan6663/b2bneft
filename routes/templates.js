'use strict';

const express = require('express');

function createTemplatesRouter(deps) {
    const {
        pool,
        requireAuth,
    } = deps;

    const router = express.Router();

    // ===================== ШАБЛОНЫ ЗАКУПОК =====================
    
    router.get('/', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                'SELECT * FROM order_templates WHERE company=$1 ORDER BY created_at DESC',
                [req.user.company]
            );
            res.json(rows);
        } catch (e) { next(e); }
    });
    
    router.post('/', requireAuth, async (req, res, next) => {
        try {
            const { title, category, description, quantity, deadlineDays } = req.body;
            if (!title) return res.status(400).json({ error: 'Укажите название шаблона' });
            const { rows: [row] } = await pool.query(
                `INSERT INTO order_templates (company,title,category,description,quantity,deadline_days)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                [req.user.company, title, category || '', description || '', quantity || null, deadlineDays || null]
            );
            res.status(201).json(row);
        } catch (e) { next(e); }
    });
    
    router.delete('/:id', requireAuth, async (req, res, next) => {
        try {
            await pool.query('DELETE FROM order_templates WHERE id=$1 AND company=$2', [req.params.id, req.user.company]);
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createTemplatesRouter;
