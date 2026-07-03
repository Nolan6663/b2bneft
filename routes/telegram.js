'use strict';

const express = require('express');
const crypto = require('crypto');

function createTelegramRouter(deps) {
    const {
        pool,
        requireAuth,
    } = deps;

    const router = express.Router();

    // ===================== TELEGRAM =====================
    
    router.post('/link-token', requireAuth, async (req, res, next) => {
        try {
            const token = crypto.randomBytes(32).toString('hex');
            const expires = new Date(Date.now() + 15 * 60 * 1000);
            await pool.query(
                'UPDATE users SET telegram_link_token=$1, telegram_link_expires=$2 WHERE id=$3',
                [token, expires, req.user.id]
            );
            const botName = process.env.TELEGRAM_BOT_NAME || 'TexZakazBot';
            res.json({ token, deepLink: `https://t.me/${botName}?start=${token}` });
        } catch (e) { next(e); }
    });
    
    router.delete('/unlink', requireAuth, async (req, res, next) => {
        try {
            await pool.query(
                'UPDATE users SET telegram_id=NULL, telegram_link_token=NULL, telegram_link_expires=NULL WHERE id=$1',
                [req.user.id]
            );
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    
    router.get('/status', requireAuth, async (req, res, next) => {
        try {
            const { rows: [user] } = await pool.query(
                'SELECT telegram_id FROM users WHERE id=$1', [req.user.id]
            );
            res.json({ linked: Boolean(user?.telegram_id), telegramId: user?.telegram_id || null });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createTelegramRouter;
