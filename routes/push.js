'use strict';

const express = require('express');

function createPushRouter(deps) {
    const {
        pool,
        requireAuth,
    } = deps;

    const router = express.Router();

    // ===================== WEB PUSH =====================
    
    router.get('/vapid-key', (req, res) => {
        if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push не настроен' });
        res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
    });
    
    router.post('/subscribe', requireAuth, async (req, res, next) => {
        try {
            const { subscription } = req.body;
            if (!subscription?.endpoint) return res.status(400).json({ error: 'Неверный subscription объект' });
            await pool.query(
                `INSERT INTO push_subscriptions (user_id, subscription)
                 VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [req.user.id, JSON.stringify(subscription)]
            );
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    
    router.delete('/subscribe', requireAuth, async (req, res, next) => {
        try {
            await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createPushRouter;
