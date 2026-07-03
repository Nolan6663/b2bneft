'use strict';

const express = require('express');

function createAuctionsRouter(deps) {
    const { pool, requireAuth, getIo } = deps;

    const router = express.Router();

    // Create auction (customer only)
    router.post('/', requireAuth, async (req, res, next) => {
        try {
            if (req.user.role !== 'customer') return res.status(403).json({ error: 'Только заказчики могут создавать аукционы' });
            const { orderId, startPrice, durationHours = 24 } = req.body;
            if (!orderId || !startPrice) return res.status(400).json({ error: 'orderId и startPrice обязательны' });

            const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1 AND company = $2', [orderId, req.user.company]);
            if (!order) return res.status(404).json({ error: 'Заявка не найдена' });

            const { rows: [existing] } = await pool.query("SELECT id FROM auctions WHERE order_id = $1 AND status = 'active'", [orderId]);
            if (existing) return res.status(409).json({ error: 'Аукцион по этой заявке уже активен' });

            const endTime = new Date(Date.now() + durationHours * 60 * 60 * 1000);
            const { rows: [auction] } = await pool.query(
                'INSERT INTO auctions (order_id, start_price, current_best, end_time) VALUES ($1,$2,$2,$3) RETURNING *',
                [orderId, startPrice, endTime]
            );
            const io = getIo();
            if (io) io.emit('auction:created', { auctionId: auction.id, orderId, startPrice, endTime });
            res.json(auction);
        } catch (e) { next(e); }
    });

    // List active auctions (for producers)
    router.get('/', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT a.*, o.title, o.category, o.description, o.quantity, o.company as customer_company,
                       (SELECT COUNT(*) FROM auction_bids WHERE auction_id = a.id) as bid_count,
                       (SELECT company FROM auction_bids WHERE auction_id = a.id ORDER BY price ASC LIMIT 1) as leader_company
                FROM auctions a
                JOIN orders o ON o.id = a.order_id
                WHERE a.status = 'active' AND a.end_time > NOW()
                ORDER BY a.end_time ASC
            `);
            res.json(rows);
        } catch (e) { next(e); }
    });

    // My auctions (customer — see auctions for own orders)
    router.get('/my/customer', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT a.*, o.title, o.category,
                       (SELECT COUNT(*) FROM auction_bids WHERE auction_id = a.id) as bid_count
                FROM auctions a JOIN orders o ON o.id = a.order_id
                WHERE o.company = $1 ORDER BY a.created_at DESC
            `, [req.user.company]);
            res.json(rows);
        } catch (e) { next(e); }
    });

    // Get single auction with bids
    router.get('/:id', requireAuth, async (req, res, next) => {
        try {
            const { rows: [auction] } = await pool.query(`
                SELECT a.*, o.title, o.category, o.description, o.quantity, o.company as customer_company
                FROM auctions a JOIN orders o ON o.id = a.order_id WHERE a.id = $1
            `, [req.params.id]);
            if (!auction) return res.status(404).json({ error: 'Аукцион не найден' });

            const { rows: bids } = await pool.query(
                'SELECT * FROM auction_bids WHERE auction_id = $1 ORDER BY price ASC, created_at ASC',
                [req.params.id]
            );
            res.json({ ...auction, bids });
        } catch (e) { next(e); }
    });

    // Submit bid (producer only)
    router.post('/:id/bid', requireAuth, async (req, res, next) => {
        try {
            if (req.user.role !== 'producer') return res.status(403).json({ error: 'Только поставщики могут делать ставки' });
            const { price, days } = req.body;
            if (!price || isNaN(price)) return res.status(400).json({ error: 'Укажите цену' });
            if (!days || isNaN(days) || Number(days) <= 0) return res.status(400).json({ error: 'Укажите срок поставки' });

            const { rows: [auction] } = await pool.query(
                "SELECT * FROM auctions WHERE id = $1 AND status = 'active' AND end_time > NOW()", [req.params.id]
            );
            if (!auction) return res.status(404).json({ error: 'Аукцион не найден или завершён' });
            if (Number(price) >= Number(auction.current_best)) {
                return res.status(400).json({ error: `Ставка должна быть ниже текущей лучшей: ${auction.current_best} ₽` });
            }

            const { rows: [bid] } = await pool.query(
                'INSERT INTO auction_bids (auction_id, company, price, days) VALUES ($1,$2,$3,$4) RETURNING *',
                [req.params.id, req.user.company, price, days]
            );
            await pool.query('UPDATE auctions SET current_best = $1, winner_company = $2 WHERE id = $3', [price, req.user.company, req.params.id]);

            const io = getIo();
            if (io) io.to(`auction:${req.params.id}`).emit('auction:bid', {
                auctionId: Number(req.params.id), company: req.user.company, price: Number(price), bidId: bid.id, createdAt: bid.created_at
            });
            res.json(bid);
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createAuctionsRouter;
