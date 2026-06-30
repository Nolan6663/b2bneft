'use strict';

const express = require('express');

function createMessagesRouter(deps) {
    const {
        pool,
        requireAuth,
        canAccessOrderThread,
        rowToMessage,
        sendEmail,
        getUserIdsByCompany,
        sendPush,
        sendTelegramNotification,
        getIo,
        APP_URL,
    } = deps;

    const router = express.Router();

    router.get('/stats', requireAuth, async (req, res, next) => {
        try {
            const { role, company } = req.user;
            const whereClause = role === 'producer' ? 'm.company=$1' : 'o.company=$1';
            const whereClauseOrig = role === 'producer' ? 'orig.company=$1' : 'o.company=$1';
            const todayStart  = "date_trunc('day', NOW())";

            const [{ rows: [convRow] }, { rows: [todayRow] }, { rows: [avgRow] }] = await Promise.all([
                pool.query(`SELECT
                    COUNT(DISTINCT (m.order_id, m.company)) AS total_convs,
                    SUM(CASE WHEN m.sender!=$2 AND m.read=false THEN 1 ELSE 0 END) AS unread
                    FROM messages m JOIN orders o ON o.id=m.order_id WHERE ${whereClause}`,
                    [company, role]),
                pool.query(`SELECT COUNT(*) AS n FROM messages m JOIN orders o ON o.id=m.order_id
                    WHERE ${whereClause} AND m.sender!=$2 AND m.created_at>=${todayStart}`,
                    [company, role]),
                pool.query(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (reply.created_at - orig.created_at))/3600)::numeric, 1) AS avg_h
                    FROM messages orig
                    JOIN messages reply ON reply.order_id=orig.order_id AND reply.company=orig.company
                        AND reply.sender!=orig.sender AND reply.created_at>orig.created_at
                    JOIN orders o ON o.id=orig.order_id
                    WHERE ${whereClauseOrig} AND orig.sender=$2
                        AND reply.created_at = (
                            SELECT MIN(created_at) FROM messages
                            WHERE order_id=orig.order_id AND company=orig.company
                                AND sender!=orig.sender AND created_at>orig.created_at
                        )`,
                    [company, role]),
            ]);

            res.json({
                totalConversations: Number(convRow.total_convs || 0),
                unread:             Number(convRow.unread || 0),
                repliesToday:       Number(todayRow.n || 0),
                avgResponseHours:   avgRow.avg_h ? Number(avgRow.avg_h) : null,
            });
        } catch (e) { next(e); }
    });

    router.get('/conversations', requireAuth, async (req, res, next) => {
        try {
            const { role, company } = req.user;
            const unreadSender = role === 'producer' ? 'customer' : 'producer';
            const whereClause = role === 'producer' ? 'm.company = $1' : 'o.company = $1';

            const { rows } = await pool.query(`
                WITH last_msg AS (
                    SELECT DISTINCT ON (order_id, company)
                        order_id, company, text, sender
                    FROM messages
                    ORDER BY order_id, company, created_at DESC
                )
                SELECT
                    m.order_id,
                    o.title AS order_title,
                    o.company AS customer_company,
                    m.company,
                    MAX(m.created_at) AS last_at,
                    COUNT(CASE WHEN m.sender = $2 AND m.read = false THEN 1 END) AS unread_count,
                    lm.text  AS last_message,
                    lm.sender AS last_sender
                FROM messages m
                JOIN orders o ON o.id = m.order_id
                LEFT JOIN last_msg lm ON lm.order_id = m.order_id AND lm.company = m.company
                WHERE ${whereClause}
                GROUP BY m.order_id, o.title, o.company, m.company, lm.text, lm.sender
                ORDER BY last_at DESC
            `, [company, unreadSender]);

            res.json(rows.map(r => ({
                orderId: r.order_id,
                orderTitle: r.order_title || `Заявка #${r.order_id}`,
                company: r.company,
                customerCompany: r.customer_company || '',
                lastMessage: r.last_message || '',
                lastSender: r.last_sender || '',
                lastAt: r.last_at,
                unreadCount: Number(r.unread_count) || 0,
            })));
        } catch (e) { next(e); }
    });

    router.post('/:orderId/:company/read', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const company = req.params.company;
            if (!(await canAccessOrderThread(req.user, orderId, company))) {
                return res.status(403).json({ error: 'Нет доступа к этому чату' });
            }
            const otherSender = req.user.role === 'producer' ? 'customer' : 'producer';
            await pool.query(
                'UPDATE messages SET read = true WHERE order_id = $1 AND company = $2 AND sender = $3 AND read = false',
                [orderId, company, otherSender]
            );
            res.json({ ok: true });
        } catch (e) { next(e); }
    });

    router.get('/:orderId/:company', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const company = req.params.company;
            if (!(await canAccessOrderThread(req.user, orderId, company))) {
                return res.status(403).json({ error: 'Нет доступа к этому чату' });
            }
            const { rows } = await pool.query(
                'SELECT * FROM messages WHERE order_id = $1 AND company = $2 ORDER BY created_at ASC',
                [orderId, company]
            );
            res.json(rows.map(rowToMessage));
        } catch (e) { next(e); }
    });

    router.post('/', requireAuth, async (req, res, next) => {
        try {
            const { orderId, text } = req.body;
            if (!orderId || !text) return res.status(400).json({ error: 'Заполните все поля сообщения' });

            const oid = Number(orderId);
            const { rows: [order] } = await pool.query('SELECT company FROM orders WHERE id = $1', [oid]);
            if (!order) return res.status(404).json({ error: 'Заявка не найдена' });

            let threadCompany;
            if (req.user.role === 'customer') {
                if (order.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа к этому чату' });
                threadCompany = req.body.company;
                if (!threadCompany) return res.status(400).json({ error: 'Не указана компания поставщика' });
                const { rows: [proposal] } = await pool.query(
                    'SELECT id FROM proposals WHERE order_id = $1 AND company = $2 LIMIT 1',
                    [oid, threadCompany]
                );
                if (!proposal) return res.status(403).json({ error: 'Чат доступен только с поставщиком, подавшим КП' });
            } else {
                const { rows: [proposal] } = await pool.query(
                    'SELECT id FROM proposals WHERE order_id = $1 AND company = $2 LIMIT 1',
                    [oid, req.user.company]
                );
                if (!proposal) return res.status(403).json({ error: 'Нет доступа к этому чату' });
                threadCompany = req.user.company;
            }

            const { rows: [newRow] } = await pool.query(
                'INSERT INTO messages (order_id,company,sender,text) VALUES ($1,$2,$3,$4) RETURNING *',
                [oid, threadCompany, req.user.role, String(text).slice(0, 2000)]
            );
            const msg = rowToMessage(newRow);
            const io = getIo();
            if (io) io.to(`chat:${msg.orderId}:${msg.company}`).emit('message', msg);

            (async () => {
                try {
                    const recipientCompany = req.user.role === 'customer' ? threadCompany : order.company;
                    const { rows: [orderRow] } = await pool.query('SELECT title FROM orders WHERE id = $1', [oid]);
                    const orderTitle = orderRow?.title || 'Заявка';
                    const { rows: recips } = await pool.query(
                        'SELECT email FROM users WHERE company = $1 LIMIT 3', [recipientCompany]
                    );
                    const preview = String(text).slice(0, 200) + (text.length > 200 ? '…' : '');
                    for (const r of recips) {
                        await sendEmail(r.email, `Новое сообщение по заявке «${orderTitle}» — ТехЗаказ`, `
                            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
                                <h3 style="color:#1E3A5F;margin:0 0 12px;">Новое сообщение</h3>
                                <p style="color:#444;margin:0 0 12px;">Компания <strong>${req.user.company}</strong> написала по заявке <strong>«${orderTitle}»</strong>:</p>
                                <blockquote style="border-left:3px solid #FF6A00;margin:0 0 16px;padding:10px 16px;background:#FFF4EC;border-radius:0 6px 6px 0;color:#333;">${preview}</blockquote>
                                <a href="https://texzakaz.ru/messages.html" style="display:inline-block;background:#FF6A00;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Открыть переписку →</a>
                            </div>`);
                    }
                    const recipientIds = await getUserIdsByCompany(recipientCompany);
                    await Promise.all(recipientIds.map(id => {
                        sendPush(id, 'Новое сообщение', `${req.user.company}: ${String(text).slice(0, 80)}`, `${APP_URL}/messages`);
                        sendTelegramNotification(id, `💬 <b>Новое сообщение</b>\nОт: ${req.user.company}\n${String(text).slice(0, 100)}`);
                    }));
                } catch (e) { console.error('[email:chat]', e.message); }
            })();

            res.status(201).json(msg);
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createMessagesRouter;
