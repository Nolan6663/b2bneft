'use strict';

// Подписки исполнителя на заказы — ТЗ §6.6.
//
// Отдельный роутер, а не часть избранного: избранное — это закладки на то, что
// уже есть, подписка — ожидание того, чего ещё нет. Разная механика и разные
// правила уведомлений.

const express = require('express');
const { normalizeChannel } = require('../lib/order-subscriptions');

const MAX_PER_COMPANY = 20;

function createSubscriptionsRouter(deps) {
    const { pool, requireAuth, requireRole } = deps;
    const router = express.Router();

    function parseId(v) {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    router.get('/', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT sub.id, sub.service_id, sub.product_id, sub.region, sub.channel,
                       sub.created_at, sub.last_sent_at,
                       COALESCE(s.name, p.name) AS topic,
                       COALESCE(s.slug, p.slug) AS slug
                  FROM order_subscriptions sub
                  LEFT JOIN services s ON s.id = sub.service_id
                  LEFT JOIN products p ON p.id = sub.product_id
                 WHERE sub.company = $1
                 ORDER BY sub.created_at DESC
            `, [req.user.company]);
            res.json(rows.map(r => ({
                id: r.id, topic: r.topic, slug: r.slug,
                kind: r.service_id ? 'service' : 'product',
                region: r.region, channel: r.channel,
                createdAt: r.created_at, lastSentAt: r.last_sent_at,
            })));
        } catch (e) { next(e); }
    });

    router.post('/', requireAuth, requireRole('producer'), async (req, res, next) => {
        const serviceId = parseId(req.body?.serviceId);
        const productId = parseId(req.body?.productId);
        if (!serviceId && !productId) {
            return res.status(400).json({ error: 'Укажите услугу или изделие' });
        }
        if (serviceId && productId) {
            // Одна подписка — одна тема: иначе непонятно, по какому из двух
            // совпадений пришло письмо, и отписаться прицельно нельзя.
            return res.status(400).json({ error: 'Подписка оформляется на одну тему' });
        }
        try {
            const { rows: [count] } = await pool.query(
                'SELECT COUNT(*)::int AS n FROM order_subscriptions WHERE company = $1', [req.user.company]
            );
            if (count.n >= MAX_PER_COMPANY) {
                return res.status(409).json({ error: `Больше ${MAX_PER_COMPANY} подписок не нужно — письма превратятся в шум` });
            }

            const table = serviceId ? 'services' : 'products';
            const { rows: [topic] } = await pool.query(
                `SELECT name FROM ${table} WHERE id = $1`, [serviceId || productId]
            );
            if (!topic) return res.status(404).json({ error: 'Тема не найдена' });

            const { rows: [row] } = await pool.query(`
                INSERT INTO order_subscriptions (company, service_id, product_id, region, channel)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (company, service_id, product_id) DO UPDATE
                    SET region = EXCLUDED.region, channel = EXCLUDED.channel
                RETURNING id, channel`,
                [req.user.company, serviceId, productId,
                 String(req.body?.region || '').trim().slice(0, 120),
                 normalizeChannel(req.body?.channel)]
            );

            res.status(201).json({
                id: row.id, topic: topic.name, channel: row.channel,
                // Событие ТЗ §12.1 отправляет клиент: window.ym на сервере нет.
                analytics: {
                    event: 'order_subscription',
                    params: { filters: serviceId ? 'service' : 'product', notification_channel: row.channel },
                },
            });
        } catch (e) { next(e); }
    });

    router.delete('/:id', requireAuth, async (req, res, next) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный идентификатор' });
        try {
            const { rowCount } = await pool.query(
                'DELETE FROM order_subscriptions WHERE id = $1 AND company = $2', [id, req.user.company]
            );
            res.json({ removed: rowCount > 0 });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = { createSubscriptionsRouter, MAX_PER_COMPANY };
