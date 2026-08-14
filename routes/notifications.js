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
    
    /* Счётчик для колокольчика.
     *
     * Самый частый запрос в системе: опрос идёт раз в 12 секунд из каждой
     * открытой вкладки. До этого эндпоинта колокольчик тянул ради него весь
     * список уведомлений компании — все, что накопились за всё время, с
     * текстами, — и считал непрочитанные на клиенте. Пока их десятки, это
     * незаметно; список никто не чистит, и растёт он только вверх. */
    router.get('/:company/unread-count', requireAuth, async (req, res, next) => {
        try {
            if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
            const { rows: [row] } = await pool.query(
                'SELECT COUNT(*)::int AS n FROM notifications WHERE company = $1 AND read = false',
                [req.user.company]
            );
            res.json({ unread: row?.n || 0 });
        } catch (e) { next(e); }
    });

    // Список для дропдауна. LIMIT здесь не урезание, а честный размер: дальше
    // сотни в этом окне никто не листает, а отдавали всё до последней строки.
    router.get('/:company', requireAuth, async (req, res, next) => {
        try {
            if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа к уведомлениям этой компании' });
            const { rows } = await pool.query(
                'SELECT * FROM notifications WHERE company = $1 ORDER BY created_at DESC LIMIT 100',
                [req.user.company]
            );
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
