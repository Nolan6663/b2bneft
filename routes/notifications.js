'use strict';

const express = require('express');

function createNotificationsRouter(deps) {
    const {
        pool,
        requireAuth,
        rowToNotification,
    } = deps;

    const router = express.Router();

    // ===================== УВЕДОМЛЕНИЯ =====================
    
    router.get('/:company', requireAuth, async (req, res, next) => {
        try {
            if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа к уведомлениям этой компании' });
            const { rows } = await pool.query('SELECT * FROM notifications WHERE company = $1 ORDER BY created_at DESC', [req.user.company]);
            res.json(rows.map(rowToNotification));
        } catch (e) { next(e); }
    });
    
    router.post('/:company/read', requireAuth, async (req, res, next) => {
        try {
            if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
            await pool.query('UPDATE notifications SET read = true WHERE company = $1', [req.user.company]);
            res.json({ message: 'ok' });
        } catch (e) { next(e); }
    });
    
    router.delete('/:company', requireAuth, async (req, res, next) => {
        try {
            if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
            await pool.query('DELETE FROM notifications WHERE company = $1', [req.user.company]);
            res.json({ message: 'ok' });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createNotificationsRouter;
