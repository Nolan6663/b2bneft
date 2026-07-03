'use strict';

const express = require('express');

function createTasksRouter(deps) {
    const {
        pool,
        requireAuth,
        canAccessOrderThread,
    } = deps;

    const router = express.Router();

    // ===================== ЗАДАЧИ =====================
    
    router.get('/tasks', requireAuth, async (req, res, next) => {
        try {
            const { orderId, company } = req.query;
            if (!orderId || !company) return res.status(400).json({ error: 'orderId и company обязательны' });
            if (!(await canAccessOrderThread(req.user, orderId, company))) {
                return res.status(403).json({ error: 'Нет доступа к задачам этой переписки' });
            }
            const { rows } = await pool.query(
                'SELECT * FROM tasks WHERE order_id = $1 AND company = $2 ORDER BY created_at ASC',
                [Number(orderId), company]
            );
            res.json(rows.map(r => ({ id: r.id, title: r.title, dueDate: r.due_date, status: r.status, createdBy: r.created_by, createdAt: r.created_at })));
        } catch (e) { next(e); }
    });
    
    router.post('/tasks', requireAuth, async (req, res, next) => {
        try {
            const { orderId, company, title, dueDate } = req.body;
            if (!orderId || !company || !title?.trim()) return res.status(400).json({ error: 'Обязательные поля: orderId, company, title' });
            if (!(await canAccessOrderThread(req.user, orderId, company))) {
                return res.status(403).json({ error: 'Нет доступа к задачам этой переписки' });
            }
            const { rows: [row] } = await pool.query(
                'INSERT INTO tasks (order_id, company, title, due_date, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
                [Number(orderId), company, title.trim(), dueDate || null, req.user.company]
            );
            res.json({ id: row.id, title: row.title, dueDate: row.due_date, status: row.status, createdBy: row.created_by, createdAt: row.created_at });
        } catch (e) { next(e); }
    });
    
    router.patch('/tasks/:id', requireAuth, async (req, res, next) => {
        try {
            const { status } = req.body;
            if (!['open', 'done'].includes(status)) return res.status(400).json({ error: 'status: open | done' });
            const { rows: [existing] } = await pool.query('SELECT * FROM tasks WHERE id = $1', [Number(req.params.id)]);
            if (!existing) return res.status(404).json({ error: 'Задача не найдена' });
            if (!(await canAccessOrderThread(req.user, existing.order_id, existing.company))) {
                return res.status(403).json({ error: 'Нет доступа к этой задаче' });
            }
            const { rows: [row] } = await pool.query(
                'UPDATE tasks SET status = $1 WHERE id = $2 RETURNING *',
                [status, Number(req.params.id)]
            );
            if (!row) return res.status(404).json({ error: 'Задача не найдена' });
            res.json({ id: row.id, title: row.title, dueDate: row.due_date, status: row.status });
        } catch (e) { next(e); }
    });
    
    // ── Контекст переписки (для правой панели) ──────────────────────────────────
    
    router.get('/conversation-context/:orderId/:company', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const company = decodeURIComponent(req.params.company);
            if (!(await canAccessOrderThread(req.user, orderId, company))) {
                return res.status(403).json({ error: 'Нет доступа к контексту этой переписки' });
            }
    
            const [orderRes, proposalRes, companyRes] = await Promise.all([
                pool.query('SELECT * FROM orders WHERE id = $1', [orderId]),
                pool.query('SELECT * FROM proposals WHERE order_id = $1 AND company = $2 ORDER BY created_at DESC LIMIT 1', [orderId, company]),
                pool.query('SELECT * FROM companies WHERE company = $1 AND role = $2 LIMIT 1', [company, 'producer']),
            ]);
    
            const order    = orderRes.rows[0]    || null;
            const proposal = proposalRes.rows[0] || null;
            const comp     = companyRes.rows[0]  || null;
    
            res.json({
                order: order ? {
                    id:       order.id,
                    title:    order.title,
                    status:   order.status,
                    quantity: order.quantity,
                    deadline: order.deadline,
                    drawing:  order.drawing ? JSON.parse(order.drawing) : null,
                } : null,
                proposal: proposal ? {
                    id:     proposal.id,
                    price:  proposal.price,
                    days:   proposal.days,
                    status: proposal.status,
                    kpFile: proposal.kp_file ? JSON.parse(proposal.kp_file) : null,
                } : null,
                supplier: comp ? {
                    id:   comp.id,
                    inn:  comp.inn,
                    director: comp.director,
                    phone:    comp.phone,
                } : null,
            });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createTasksRouter;
