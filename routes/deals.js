'use strict';

const express = require('express');

const DELIVERY_STAGES = ['КП принят', 'В производстве', 'Готов к отгрузке', 'Отгружен', 'Доставлен', 'Принят заказчиком'];

function createDealsRouter(deps) {
    const {
        pool,
        requireAuth,
        requireRole,
        plainTitle,
        htmlEscape,
        addNotification,
        emitRealtime,
        emitDashboardRefresh,
        getCompanyEmail,
        sendEmail,
        APP_URL,
    } = deps;

    const router = express.Router();

    router.get('/', requireAuth, async (req, res, next) => {
        try {
            const { role, company } = req.user;
            let rows;

            if (role === 'customer') {
                const { rows: r } = await pool.query(`
                    SELECT o.id AS order_id, o.title, o.quantity, o.category,
                           p.id AS proposal_id, p.company AS counterparty,
                           p.price, p.days, p.created_at AS deal_date, p.completion_status,
                           p.delivery_stage, c.id AS counterparty_profile_id
                    FROM orders o
                    JOIN proposals p ON p.order_id = o.id AND p.status = 'Выигран'
                    LEFT JOIN companies c ON c.company = p.company AND c.role = 'producer'
                    WHERE o.company = $1
                    ORDER BY p.created_at DESC
                `, [company]);
                rows = r;
            } else if (role === 'producer') {
                const { rows: r } = await pool.query(`
                    SELECT o.id AS order_id, o.title, o.quantity, o.category,
                           p.id AS proposal_id, o.company AS counterparty,
                           p.price, p.days, p.created_at AS deal_date, p.completion_status,
                           p.delivery_stage, c.id AS counterparty_profile_id
                    FROM proposals p
                    JOIN orders o ON o.id = p.order_id
                    LEFT JOIN companies c ON c.company = o.company AND c.role = 'customer'
                    WHERE p.company = $1 AND p.status = 'Выигран'
                    ORDER BY p.created_at DESC
                `, [company]);
                rows = r;
            } else {
                return res.json([]);
            }

            res.json(rows.map(r => ({
                orderId:               r.order_id,
                proposalId:            r.proposal_id,
                title:                 r.title,
                quantity:              r.quantity,
                category:              r.category,
                counterparty:          r.counterparty,
                counterpartyProfileId: r.counterparty_profile_id || null,
                price:                 r.price,
                days:                  r.days,
                dealDate:              r.deal_date,
                completionStatus:      r.completion_status || 'active',
                deliveryStage:         r.delivery_stage || 'КП принят',
            })));
        } catch (e) { next(e); }
    });

    router.put('/:proposalId/complete', requireAuth, requireRole('customer'), async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { rows: [row] } = await pool.query(`
                SELECT p.*, o.company AS customer_company, o.title AS order_title
                FROM proposals p JOIN orders o ON o.id = p.order_id
                WHERE p.id = $1
            `, [proposalId]);

            if (!row) return res.status(404).json({ error: 'Сделка не найдена' });
            if (row.status !== 'Выигран') return res.status(400).json({ error: 'Это не активная сделка' });
            if (row.customer_company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
            if (row.completion_status === 'completed') return res.status(400).json({ error: 'Сделка уже завершена' });

            await pool.query("UPDATE proposals SET completion_status = 'completed' WHERE id = $1", [proposalId]);
            const title = plainTitle(row.order_title);
            await addNotification(row.company, `Заказчик подтвердил выполнение заказа «${title}».`);
            emitDashboardRefresh(row.company);
            emitDashboardRefresh(row.customer_company);
            emitRealtime(row.company, 'deal:status', {
                proposalId,
                orderId: row.order_id,
                orderTitle: title,
                stage: 'Завершена',
                completionStatus: 'completed',
            });
            emitRealtime(row.customer_company, 'deal:status', {
                proposalId,
                orderId: row.order_id,
                orderTitle: title,
                stage: 'Завершена',
                completionStatus: 'completed',
            });
            const email = await getCompanyEmail(row.company);
            if (email) {
                await sendEmail(email, `Сделка завершена — «${title}»`,
                    `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                      <h3 style="color:#41bd97">Сделка завершена</h3>
                      <p>Заказчик подтвердил выполнение заказа <strong>«${htmlEscape(title)}»</strong>.</p>
                      <a href="${APP_URL}/deals.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть сделки</a>
                    </div>`
                ).catch(() => {});
            }
            res.json({ message: 'Сделка завершена' });
        } catch (e) { next(e); }
    });

    router.get('/:proposalId/timeline', requireAuth, async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { rows: [deal] } = await pool.query(`
                SELECT p.id, p.order_id, p.company AS producer_company, p.price, p.days, p.created_at AS proposal_created_at,
                       p.completion_status, p.delivery_stage,
                       o.title AS order_title, o.category, o.company AS customer_company, o.created_at AS order_created_at
                FROM proposals p
                JOIN orders o ON o.id = p.order_id
                WHERE p.id = $1 AND p.status = 'Выигран'
            `, [proposalId]);
            if (!deal) return res.status(404).json({ error: 'Сделка не найдена' });
            if (req.user.role === 'customer' && deal.customer_company !== req.user.company) {
                return res.status(403).json({ error: 'Нет доступа' });
            }
            if (req.user.role === 'producer' && deal.producer_company !== req.user.company) {
                return res.status(403).json({ error: 'Нет доступа' });
            }

            const events = [];
            const push = (type, title, detail, at) => {
                if (!at) return;
                events.push({ type, title, detail: detail || '', at });
            };

            push('order', 'Закупка опубликована', deal.order_title, deal.order_created_at);
            push('proposal', 'КП подано поставщиком', `${Number(deal.price).toLocaleString('ru-RU')} ₽ · ${deal.days} дн.`, deal.proposal_created_at);

            const { rows: allProps } = await pool.query(
                `SELECT company, price, created_at FROM proposals WHERE order_id = $1 ORDER BY created_at ASC`,
                [deal.order_id]
            );
            for (const p of allProps) {
                if (p.company === deal.producer_company) continue;
                push('proposal_other', 'КП от другого поставщика', `${p.company} · ${Number(p.price).toLocaleString('ru-RU')} ₽`, p.created_at);
            }

            const { rows: deliveryRows } = await pool.query(
                'SELECT stage, notes, updated_by, created_at FROM delivery_events WHERE proposal_id = $1 ORDER BY created_at ASC',
                [proposalId]
            );
            for (const ev of deliveryRows) {
                push('delivery', ev.stage, ev.notes || '', ev.created_at);
            }

            const { rows: orderEventRows } = await pool.query(
                'SELECT event_type, title, detail, actor, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at ASC',
                [deal.order_id]
            );
            for (const ev of orderEventRows) {
                if (ev.event_type === 'created') continue;
                push('status', ev.title, ev.detail || ev.actor || '', ev.created_at);
            }

            const { rows: [{ n: msgCount }] } = await pool.query(
                `SELECT COUNT(*)::int AS n FROM messages WHERE order_id = $1 AND company = $2`,
                [deal.order_id, deal.producer_company]
            );
            if (msgCount > 0) {
                const { rows: [{ last_at }] } = await pool.query(
                    `SELECT MAX(created_at) AS last_at FROM messages WHERE order_id = $1 AND company = $2`,
                    [deal.order_id, deal.producer_company]
                );
                push('chat', 'Переписка по сделке', `${msgCount} сообщ.`, last_at);
            }

            if (deal.completion_status === 'completed') {
                push('complete', 'Сделка завершена', 'Заказчик подтвердил выполнение', deliveryRows.at(-1)?.created_at || deal.proposal_created_at);
            }

            const { rows: reviewRows } = await pool.query(
                'SELECT score, text, from_company, created_at FROM reviews WHERE order_id = $1 ORDER BY created_at ASC',
                [deal.order_id]
            );
            for (const rv of reviewRows) {
                push('review', `Отзыв: ${'★'.repeat(rv.score)}`, `${rv.from_company}${rv.text ? ' — ' + rv.text.slice(0, 80) : ''}`, rv.created_at);
            }

            events.sort((a, b) => new Date(a.at) - new Date(b.at));
            res.json({ events, currentStage: deal.delivery_stage || 'КП принят', completionStatus: deal.completion_status || 'active' });
        } catch (e) { next(e); }
    });

    router.get('/:proposalId/delivery', requireAuth, async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { rows: [p] } = await pool.query(`
                SELECT p.id, p.order_id, p.price, p.days, p.company AS producer_company,
                       p.status, p.delivery_stage, p.tracking_number, p.created_at,
                       o.title, o.quantity, o.category, o.company AS customer_company
                FROM proposals p JOIN orders o ON o.id = p.order_id
                WHERE p.id = $1 AND p.status = 'Выигран'
            `, [proposalId]);
            if (!p) return res.status(404).json({ error: 'Сделка не найдена' });

            const { company, role } = req.user;
            if (role !== 'admin' && company !== p.producer_company && company !== p.customer_company) {
                return res.status(403).json({ error: 'Нет доступа' });
            }

            const { rows: events } = await pool.query(
                'SELECT * FROM delivery_events WHERE proposal_id = $1 ORDER BY created_at ASC', [proposalId]
            );
            res.json({ deal: p, events });
        } catch (e) { next(e); }
    });

    router.post('/:proposalId/delivery/stage', requireAuth, async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { stage, notes = '', trackingNumber = '' } = req.body;
            if (!DELIVERY_STAGES.includes(stage)) return res.status(400).json({ error: 'Неверный этап' });

            const { rows: [p] } = await pool.query(`
                SELECT p.*, o.company AS customer_company, o.title AS order_title
                FROM proposals p JOIN orders o ON o.id = p.order_id
                WHERE p.id = $1 AND p.status = 'Выигран'
            `, [proposalId]);
            if (!p) return res.status(404).json({ error: 'Сделка не найдена' });

            const { company, role } = req.user;
            if (stage === 'Принят заказчиком') {
                if (role !== 'customer' || company !== p.customer_company) {
                    return res.status(403).json({ error: 'Только заказчик подтверждает получение' });
                }
            } else if (role !== 'producer' || company !== p.company) {
                return res.status(403).json({ error: 'Только поставщик обновляет статус доставки' });
            }

            const currentIdx = DELIVERY_STAGES.indexOf(p.delivery_stage);
            const newIdx = DELIVERY_STAGES.indexOf(stage);
            if (newIdx <= currentIdx) return res.status(400).json({ error: 'Нельзя вернуться на предыдущий этап' });

            await pool.query(
                "UPDATE proposals SET delivery_stage = $1, tracking_number = COALESCE(NULLIF($2,''), tracking_number) WHERE id = $3",
                [stage, trackingNumber, proposalId]
            );
            await pool.query(
                'INSERT INTO delivery_events (proposal_id, stage, notes, updated_by) VALUES ($1,$2,$3,$4)',
                [proposalId, stage, notes, company]
            );

            if (stage === 'Принят заказчиком') {
                await pool.query("UPDATE proposals SET completion_status = 'completed' WHERE id = $1", [proposalId]);
            }

            const title = plainTitle(p.order_title);
            const notifyCompany = stage === 'Принят заказчиком' ? p.company : p.customer_company;
            await addNotification(notifyCompany, `Статус доставки по «${title}» изменён: ${stage}.`);
            emitDashboardRefresh(p.company);
            emitDashboardRefresh(p.customer_company);
            const statusPayload = {
                proposalId,
                orderId: p.order_id,
                orderTitle: title,
                stage,
                completionStatus: stage === 'Принят заказчиком' ? 'completed' : (p.completion_status || 'active'),
            };
            emitRealtime(p.company, 'deal:status', statusPayload);
            emitRealtime(p.customer_company, 'deal:status', statusPayload);

            const criticalStages = ['Отгружен', 'Принят заказчиком'];
            if (criticalStages.includes(stage)) {
                const email = await getCompanyEmail(notifyCompany);
                if (email) {
                    await sendEmail(email, `Статус поставки: ${stage} — «${title}»`,
                        `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                          <h3 style="color:#41bd97">Обновление поставки</h3>
                          <p>По заказу <strong>«${htmlEscape(title)}»</strong> новый этап: <strong>${htmlEscape(stage)}</strong>.</p>
                          <a href="${APP_URL}/delivery.html?id=${proposalId}" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Отследить доставку</a>
                        </div>`
                    ).catch(() => {});
                }
            }

            res.json({ message: 'Статус обновлён', stage });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createDealsRouter;
