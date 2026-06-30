'use strict';

const express = require('express');

module.exports = function createOrdersRouter(deps) {
    const {
        pool,
        storage,
        requireAuth,
        requireRole,
        requireVerifiedEmail,
        handleDrawingUpload,
        persistUpload,
        deleteDrawingFile,
        canAccessOrderDrawing,
        rowToOrder,
        rowToCompany,
        computeMatchScore,
        matchedProducers,
        computePriceBenchmark,
        plainTitle,
        htmlEscape,
        notifyCompanyEmail,
        withTransaction,
        addNotification,
        getOrderAccessRow,
        APP_URL,
    } = deps;

    const router = express.Router();

    router.get('/public', async (req, res, next) => {
        try {
            const category = req.query.category || '';
            const params = [];
            let where = "status = 'Активный'";
            if (category) { params.push(category); where += ` AND category = $${params.length}`; }
            const { rows } = await pool.query(
                `SELECT id, title, category, deadline, quantity, responses, created_at
                 FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT 30`,
                params
            );
            res.json(rows);
        } catch (e) { next(e); }
    });

    router.get('/match-scores', requireAuth, requireRole('producer'), async (req, res, next) => {
        try {
            const { rows: [meRow] } = await pool.query("SELECT * FROM companies WHERE company = $1 AND role = 'producer'", [req.user.company]);
            const me = meRow ? rowToCompany(meRow) : null;
            const { rows: orders } = await pool.query('SELECT * FROM orders');
            const scores = {};
            orders.map(rowToOrder).forEach(o => { scores[o.id] = me ? computeMatchScore(o, me) : 0; });
            res.json(scores);
        } catch (e) { next(e); }
    });

    router.get('/', requireAuth, async (req, res, next) => {
        try {
            let rows;
            if (req.user.role === 'customer') {
                ({ rows } = await pool.query('SELECT * FROM orders WHERE company = $1 ORDER BY created_at DESC', [req.user.company]));
            } else {
                ({ rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC'));
            }
            res.json(rows.map(rowToOrder));
        } catch (e) { next(e); }
    });

    router.get('/:orderId/drawing', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            if (!(await canAccessOrderDrawing(req.user, orderId))) {
                return res.status(403).json({ error: 'Нет доступа к чертежу этой закупки' });
            }
            const { rows: [row] } = await pool.query('SELECT drawing FROM orders WHERE id = $1', [orderId]);
            if (!row || !row.drawing) return res.status(404).json({ error: 'Файл не найден' });
            const drawing = JSON.parse(row.drawing);
            if (!storage.isRemote() && !storage.existsLocally(drawing.storedName)) {
                return res.status(404).json({ error: 'Файл был удалён с сервера' });
            }
            const inline = req.query.inline === '1';
            await storage.streamToResponse(drawing.storedName, res, drawing.originalName, { inline });
        } catch (e) { next(e); }
    });

    router.get('/:orderId/matched-suppliers', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const orderRow = await getOrderAccessRow(orderId);
            if (!orderRow) return res.status(404).json({ error: 'Закупка не найдена' });
            if (req.user.role !== 'admin' && orderRow.company !== req.user.company) {
                return res.status(403).json({ error: 'Нет доступа к этой закупке' });
            }
            const orderObj = rowToOrder(orderRow);
            const minScore = Math.max(0, Math.min(100, Number(req.query.min) || 30));
            const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 8));
            const matched = await matchedProducers(orderObj, minScore, true);
            res.json(matched.slice(0, limit));
        } catch (e) { next(e); }
    });

    router.get('/:orderId/price-benchmark', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const orderRow = await getOrderAccessRow(orderId);
            if (!orderRow) return res.status(404).json({ error: 'Закупка не найдена' });
            if (req.user.role !== 'admin' && orderRow.company !== req.user.company) {
                return res.status(403).json({ error: 'Нет доступа к этой закупке' });
            }
            const orderObj = rowToOrder(orderRow);
            const benchmark = await computePriceBenchmark(orderObj.category, orderId);

            const { rows: currentProps } = await pool.query(
                `SELECT price FROM proposals WHERE order_id = $1 AND price IS NOT NULL AND price > 0`,
                [orderId]
            );
            const currentPrices = currentProps.map(r => Number(r.price)).filter(v => v > 0);
            if (currentPrices.length) {
                benchmark.currentMin = Math.min(...currentPrices);
                benchmark.currentMax = Math.max(...currentPrices);
            }

            res.json(benchmark);
        } catch (e) { next(e); }
    });

    router.get('/:orderId/producer-benchmark', requireAuth, requireRole('producer'), async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const orderRow = await getOrderAccessRow(orderId);
            if (!orderRow) return res.status(404).json({ error: 'Закупка не найдена' });
            if (orderRow.status !== 'Активный') {
                return res.status(400).json({ error: 'Бенчмарк доступен только для активных закупок' });
            }
            const benchmark = await computePriceBenchmark(orderRow.category, orderId);
            res.json(benchmark);
        } catch (e) { next(e); }
    });

    router.post('/', requireAuth, requireRole('customer'), requireVerifiedEmail, handleDrawingUpload, async (req, res, next) => {
        try {
            const { title, category, deadline, quantity, description } = req.body;
            if (!title || !category || !deadline) return res.status(400).json({ error: 'Заполните все поля заявки' });

            const drawing = await persistUpload(req.file, 'drawings');
            const { rows: [newRow] } = await pool.query(
                'INSERT INTO orders (title,category,deadline,quantity,description,company,drawing) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
                [title, category, deadline, quantity ? Number(quantity) : null,
                 description ? String(description).slice(0, 1000) : '', req.user.company, drawing]
            );
            const newOrder = rowToOrder(newRow);

            const MATCH_NOTIFY_THRESHOLD = 50;
            const matched = await matchedProducers(newOrder, MATCH_NOTIFY_THRESHOLD);
            const orderTitle = plainTitle(newOrder.title);
            await Promise.all(matched.map(m =>
                notifyCompanyEmail(
                    m.company,
                    `🧩 Новая подходящая прямая закупка (${m.score}% совпадение): «${orderTitle}»`,
                    `Новая прямая закупка (${m.score}% совп.) — ТехЗаказ`,
                    `<p style="color:#444;font-size:14px;line-height:1.5;">Появилась закупка, которая подходит вашему профилю на <strong>${m.score}%</strong>:</p>
                     <p style="font-size:15px;font-weight:600;color:#1E3A5F;">«${htmlEscape(orderTitle)}»</p>
                     <p style="color:#666;font-size:13px;">Категория: ${htmlEscape(newOrder.category || '—')}</p>
                     <p style="margin-top:16px;"><a href="${APP_URL}/producer.html" style="display:inline-block;background:#FF6A00;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Открыть заявки →</a></p>`
                )
            ));

            res.status(201).json(newOrder);
        } catch (e) { next(e); }
    });

    router.put('/:orderId', requireAuth, requireRole('customer'), handleDrawingUpload, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const { title, category, deadline, quantity, description } = req.body;
            if (!title || !category || !deadline) return res.status(400).json({ error: 'Заполните все поля заявки' });

            const { rows: [row] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
            const order = rowToOrder(row);
            if (order.company && order.company !== req.user.company) return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
            if (order.status === 'Закрыта' || order.status === 'Отменена') return res.status(400).json({ error: 'Закрытую или отменённую закупку нельзя редактировать' });

            let drawingJson = row.drawing;
            if (req.file) {
                deleteDrawingFile(order.drawing);
                drawingJson = await persistUpload(req.file, 'drawings');
            }

            await pool.query(
                'UPDATE orders SET title=$1,category=$2,deadline=$3,quantity=$4,description=$5,drawing=$6 WHERE id=$7',
                [title, category, deadline, quantity ? Number(quantity) : null,
                 description !== undefined ? String(description).slice(0, 1000) : (order.description || ''),
                 drawingJson, orderId]
            );
            const { rows: [updated] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            res.json(rowToOrder(updated));
        } catch (e) { next(e); }
    });

    router.post('/:orderId/cancel', requireAuth, requireRole('customer'), async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const { rows: [row] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
            const order = rowToOrder(row);
            if (order.company && order.company !== req.user.company) return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
            if (order.status === 'Закрыта')  return res.status(400).json({ error: 'Закупка уже завершена, отменить её нельзя' });
            if (order.status === 'Отменена') return res.status(400).json({ error: 'Закупка уже отменена' });

            const title = plainTitle(order.title);
            const notifs = [];

            await withTransaction(async (client) => {
                await client.query("UPDATE orders SET status = 'Отменена' WHERE id = $1", [orderId]);
                const { rows: pending } = await client.query(
                    "SELECT * FROM proposals WHERE order_id = $1 AND status = 'Ожидает ответа'", [orderId]
                );
                for (const p of pending) {
                    await client.query("UPDATE proposals SET status = 'Отозвана заказчиком' WHERE id = $1", [p.id]);
                    notifs.push({ company: p.company, text: `Закупка «${title}» отменена заказчиком, ваше предложение по ней снято с рассмотрения.` });
                }
            });

            await Promise.all(notifs.map(n => addNotification(n.company, n.text)));
            const { rows: [updated] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            res.json(rowToOrder(updated));
        } catch (e) { next(e); }
    });

    return router;
};
