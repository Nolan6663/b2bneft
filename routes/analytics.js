'use strict';

const express = require('express');

function createAnalyticsRouter(deps) {
    const {
        pool,
        requireAuth,
        requireRole,
    } = deps;

    const router = express.Router();

    // ===================== DASHBOARD COUNTS =====================
    
    router.get('/dashboard/counts', requireAuth, async (req, res, next) => {
        try {
            const company = req.user.company;
            if (req.user.role === 'producer') {
                const [{ rows: [{ n: activeOrders }] }, { rows: [{ n: pendingProposals }] }, { rows: [{ n: unreadMessages }] }] = await Promise.all([
                    pool.query("SELECT COUNT(*) AS n FROM orders WHERE status = 'Активный'"),
                    pool.query("SELECT COUNT(*) AS n FROM proposals WHERE company = $1 AND status = 'Ожидает ответа'", [company]),
                    pool.query("SELECT COUNT(*) AS n FROM messages WHERE company = $1 AND sender = 'customer' AND read = false", [company]),
                ]);
                res.json({ activeOrders, pendingProposals, unreadMessages });
            } else {
                const [{ rows: [{ n: myActiveOrders }] }, { rows: [{ n: newResponses }] }, { rows: [{ n: unreadMessages }] }] = await Promise.all([
                    pool.query("SELECT COUNT(*) AS n FROM orders WHERE company = $1 AND status = 'Активный'", [company]),
                    pool.query("SELECT COUNT(*) AS n FROM proposals p JOIN orders o ON p.order_id = o.id WHERE o.company = $1 AND p.status = 'Ожидает ответа'", [company]),
                    pool.query("SELECT COUNT(*) AS n FROM messages m JOIN orders o ON o.id = m.order_id WHERE o.company = $1 AND m.sender = 'producer' AND m.read = false", [company]),
                ]);
                res.json({ myActiveOrders, newResponses, unreadMessages });
            }
        } catch (e) { next(e); }
    });
    
    // ===================== CRM / АНАЛИТИКА =====================
    
    router.get('/producer/crm-stats', requireAuth, requireRole('producer'), async (req, res, next) => {
        try {
            const company = req.user.company;
            const [
                { rows: [{ n: leads }] },
                { rows: [{ n: sent }] },
                { rows: [{ n: won }] },
                { rows: [{ n: active }] },
            ] = await Promise.all([
                pool.query("SELECT COUNT(*) AS n FROM orders WHERE status = 'Активный'"),
                pool.query('SELECT COUNT(*) AS n FROM proposals WHERE company = $1', [company]),
                pool.query("SELECT COUNT(*) AS n FROM proposals WHERE company = $1 AND status = 'Выигран'", [company]),
                pool.query("SELECT COUNT(*) AS n FROM proposals WHERE company = $1 AND status = 'Ожидает ответа'", [company]),
            ]);
            const conversion = sent > 0 ? Math.round((won / sent) * 100) : 0;
            res.json({ leads, sent, won, active, conversion });
        } catch (e) { next(e); }
    });
    
    router.get('/customer/analytics', requireAuth, async (req, res, next) => {
        try {
            const company = req.user.company;
            const [
                { rows: [{ n: monthOrders }] },
                { rows: [{ n: activeOrders }] },
                { rows: [{ n: closedOrders }] },
                { rows: [{ n: totalProposals }] },
                { rows: [{ avg: avgDays }] },
                { rows: savingsRows },
                { rows: dynamicsRows },
                { rows: categoryRows },
                { rows: supplierRows },
            ] = await Promise.all([
                pool.query("SELECT COUNT(*) AS n FROM orders WHERE company=$1 AND created_at>=date_trunc('month',NOW())", [company]),
                pool.query("SELECT COUNT(*) AS n FROM orders WHERE company=$1 AND status='Активный'", [company]),
                pool.query("SELECT COUNT(*) AS n FROM orders WHERE company=$1 AND status='Закрыта'", [company]),
                pool.query("SELECT COUNT(*) AS n FROM proposals p JOIN orders o ON o.id=p.order_id WHERE o.company=$1", [company]),
                pool.query(`SELECT ROUND(AVG(p.days)) AS avg FROM proposals p JOIN orders o ON o.id=p.order_id WHERE o.company=$1 AND p.status='Выигран'`, [company]),
                pool.query(`SELECT
                        (SELECT price FROM proposals WHERE order_id=o.id AND status='Выигран' LIMIT 1) AS win_price,
                        (SELECT AVG(price) FROM proposals WHERE order_id=o.id) AS avg_price
                    FROM orders o WHERE o.company=$1 AND o.status='Закрыта'`, [company]),
                // Monthly dynamics: last 6 months
                pool.query(`SELECT
                        to_char(date_trunc('month', o.created_at), 'Mon YYYY') AS label,
                        date_trunc('month', o.created_at) AS month_dt,
                        COUNT(o.id) AS order_count,
                        COALESCE(SUM(p.price) FILTER (WHERE p.status='Выигран'), 0) AS volume,
                        ROUND(AVG(p.days) FILTER (WHERE p.status='Выигран')) AS avg_days,
                        CASE WHEN COUNT(o.id) > 0
                            THEN ROUND(COUNT(o.id) FILTER (WHERE o.status='Закрыта')::numeric / COUNT(o.id) * 100)
                            ELSE 0 END AS conversion
                    FROM orders o
                    LEFT JOIN proposals p ON p.order_id = o.id AND p.status='Выигран'
                    WHERE o.company=$1 AND o.created_at >= NOW()-INTERVAL '6 months'
                    GROUP BY date_trunc('month',o.created_at)
                    ORDER BY month_dt`, [company]),
                // Category breakdown
                pool.query(`SELECT category, COUNT(*) AS cnt
                    FROM orders WHERE company=$1
                    GROUP BY category ORDER BY cnt DESC LIMIT 6`, [company]),
                // Top suppliers by won deal value + ratings
                pool.query(`SELECT p.company,
                        COUNT(*) AS deals,
                        SUM(p.price) AS total,
                        ROUND(AVG(p.days)) AS avg_days,
                        ROUND(AVG(EXTRACT(EPOCH FROM (p.created_at - o.created_at)) / 3600)) AS avg_response_hours,
                        (SELECT ROUND(AVG(rv.score)::numeric, 1)
                         FROM reviews rv
                         WHERE rv.to_company = p.company AND rv.from_company = $1) AS avg_score
                    FROM proposals p
                    JOIN orders o ON o.id = p.order_id
                    WHERE o.company = $1 AND p.status = 'Выигран'
                    GROUP BY p.company
                    ORDER BY total DESC
                    LIMIT 5`, [company]),
            ]);
    
            const validRows = savingsRows.filter(r => r.win_price && r.avg_price && r.avg_price > 0);
            const savings = validRows.length > 0
                ? Math.round(validRows.reduce((s, r) => s + (1 - r.win_price / r.avg_price), 0) / validRows.length * 100)
                : null;
    
            const totalSupply = supplierRows.reduce((s, r) => s + Number(r.total || 0), 0);
    
            res.json({
                monthOrders:   Number(monthOrders),
                activeOrders:  Number(activeOrders),
                closedOrders:  Number(closedOrders),
                totalProposals:Number(totalProposals),
                avgDays:       avgDays ? Math.round(avgDays) : null,
                savings,
                dynamics: dynamicsRows.map(r => ({
                    label:      r.label,
                    orderCount: Number(r.order_count),
                    volume:     Math.round(Number(r.volume) / 1e6 * 100) / 100,
                    avgDays:    r.avg_days != null ? Number(r.avg_days) : null,
                    conversion: r.conversion != null ? Number(r.conversion) : null,
                })),
                categories: categoryRows.map(r => ({ label: r.category, count: Number(r.cnt) })),
                suppliers: supplierRows.map(r => ({
                    name:   r.company,
                    deals:  Number(r.deals),
                    amount: Math.round(Number(r.total) / 1e6 * 100) / 100,
                    share:  totalSupply > 0 ? Math.round(Number(r.total) / totalSupply * 1000) / 10 : 0,
                    avgScore: r.avg_score != null ? Number(r.avg_score) : null,
                    avgResponseHours: r.avg_response_hours != null ? Number(r.avg_response_hours) : null,
                    avgDays: r.avg_days != null ? Number(r.avg_days) : null,
                })),
            });
        } catch (e) { next(e); }
    });
    
    return router;
}

module.exports = createAnalyticsRouter;
