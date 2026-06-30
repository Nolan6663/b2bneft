'use strict';

const express = require('express');

function createProposalsRouter(deps) {
    const {
        pool,
        storage,
        requireAuth,
        requireRole,
        requireVerifiedEmail,
        handleKPUpload,
        persistUpload,
        canAccessProposal,
        rowToOrder,
        rowToProposal,
        rowToCompany,
        computeMatchScore,
        computeMatchReasons,
        plainTitle,
        htmlEscape,
        withTransaction,
        addNotification,
        emitRealtime,
        emitDashboardRefresh,
        getCompanyEmail,
        sendEmail,
        getUserIdsByCompany,
        sendPush,
        sendTelegramNotification,
        triggerIntegrations,
        APP_URL,
    } = deps;

    const router = express.Router();

    router.get('/:proposalId/file', requireAuth, async (req, res, next) => {
        try {
            const { rows: [row] } = await pool.query(`
                SELECT p.*, o.company AS order_company
                FROM proposals p
                JOIN orders o ON o.id = p.order_id
                WHERE p.id = $1
            `, [Number(req.params.proposalId)]);
            if (!row || !row.kp_file) return res.status(404).json({ error: 'Файл не найден' });
            if (!canAccessProposal(req.user, row)) return res.status(403).json({ error: 'Нет доступа к этому файлу' });
            const kpFile = JSON.parse(row.kp_file);
            if (!storage.isRemote() && !storage.existsLocally(kpFile.storedName)) {
                return res.status(404).json({ error: 'Файл был удалён с сервера' });
            }
            await storage.streamToResponse(kpFile.storedName, res, kpFile.originalName);
        } catch (e) { next(e); }
    });

    router.post('/', requireAuth, requireRole('producer'), requireVerifiedEmail, handleKPUpload, async (req, res, next) => {
        try {
            const { orderId, orderTitle, price, days } = req.body;
            if (!orderId || !price || !days) return res.status(400).json({ error: 'Не указаны ID заявки, цена или сроки' });

            const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(orderId)]);
            if (!orderRow) return res.status(404).json({ error: 'Заявка с таким ID не найдена' });
            if (orderRow.status !== 'Активный') {
                return res.status(400).json({ error: 'Нельзя подать КП на закрытую или отменённую закупку' });
            }

            const { rows: [existing] } = await pool.query('SELECT id FROM proposals WHERE order_id = $1 AND company = $2', [Number(orderId), req.user.company]);
            if (existing) return res.status(409).json({ error: 'Вы уже подали КП на эту закупку. Отредактируйте существующее предложение.' });

            const kpFile = await persistUpload(req.file, 'kp');

            const newRow = await withTransaction(async (client) => {
                const { rows: [r] } = await client.query(
                    'INSERT INTO proposals (order_id,order_title,price,days,company,kp_file) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
                    [Number(orderId), orderTitle || orderRow.title, Number(price), Number(days), req.user.company, kpFile]
                );
                await client.query('UPDATE orders SET responses = responses + 1 WHERE id = $1', [Number(orderId)]);
                return r;
            });

            const newProposal = rowToProposal(newRow);
            if (orderRow.company) {
                const title = plainTitle(orderRow.title);
                await addNotification(orderRow.company, `Получен новый отклик на «${title}» от ${req.user.company}.`);
                const email = await getCompanyEmail(orderRow.company);
                if (email) await sendEmail(email, `Новый отклик на закупку «${title}»`,
                    `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                      <h3 style="color:#41bd97">Новый отклик на закупку</h3>
                      <p>Компания <strong>${htmlEscape(req.user.company)}</strong> подала коммерческое предложение по закупке <strong>«${htmlEscape(title)}»</strong>.</p>
                      <p>Цена: <strong>${Number(newProposal.price).toLocaleString('ru-RU')} ₽</strong> · Срок: <strong>${newProposal.days} дн.</strong></p>
                      <a href="${APP_URL}/index.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                    </div>`
                );
                getUserIdsByCompany(orderRow.company).then(ids =>
                    ids.forEach(id => {
                        sendPush(id, 'Новое коммерческое предложение', `«${orderRow.title}» — получен новый отклик`, `${APP_URL}/index`);
                        sendTelegramNotification(id, `📨 <b>Новое КП</b> по закупке «${orderRow.title}»\nПоставщик: ${req.user.company}\nЦена: ${Number(newProposal.price).toLocaleString('ru-RU')} руб.`);
                    })
                ).catch(() => {});
                emitDashboardRefresh(orderRow.company);
                emitRealtime(orderRow.company, 'proposal:new', {
                    id: newProposal.id,
                    orderId: newProposal.orderId,
                    orderTitle: title,
                    company: req.user.company,
                    price: newProposal.price,
                    days: newProposal.days,
                });
            }
            res.status(201).json(newProposal);
        } catch (e) { next(e); }
    });

    router.get('/', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query('SELECT * FROM proposals WHERE company = $1', [req.user.company]);
            res.json(rows.map(rowToProposal));
        } catch (e) { next(e); }
    });

    router.post('/:proposalId/accept', requireAuth, requireRole('customer'), async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { rows: [proposalRow] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
            if (!proposalRow) return res.status(404).json({ error: 'Предложение не найдено' });

            const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [proposalRow.order_id]);
            if (!orderRow) return res.status(404).json({ error: 'Связанная заявка не найдена' });
            if (orderRow.company && orderRow.company !== req.user.company) return res.status(403).json({ error: 'Принимать предложения может только владелец закупки' });
            if (orderRow.status === 'Закрыта' || orderRow.status === 'Отменена') {
                return res.status(400).json({ error: 'Эта прямая закупка уже завершена' });
            }

            const title = plainTitle(orderRow.title);
            const notifs = [];

            await withTransaction(async (client) => {
                await client.query("UPDATE orders SET status = 'Закрыта' WHERE id = $1", [orderRow.id]);
                const { rows: allProposals } = await client.query('SELECT * FROM proposals WHERE order_id = $1', [orderRow.id]);
                for (const p of allProposals) {
                    if (p.id === proposalId) {
                        await client.query("UPDATE proposals SET status = 'Выигран' WHERE id = $1", [p.id]);
                        await client.query(
                            "INSERT INTO delivery_events (proposal_id, stage, notes, updated_by) VALUES ($1, 'КП принят', $2, 'system')",
                            [p.id, `КП принят заказчиком. Сумма: ${p.price ? p.price.toLocaleString('ru-RU') + ' ₽' : '—'}, срок: ${p.days} дн.`]
                        );
                        notifs.push({ company: p.company, text: `Ваше предложение по «${title}» принято! Заказ выигран.` });
                    } else {
                        await client.query("UPDATE proposals SET status = 'Отклонен' WHERE id = $1", [p.id]);
                        notifs.push({ company: p.company, text: `Ваше предложение по «${title}» отклонено.` });
                    }
                }
            });

            const wonProposal = { id: proposalId, company: proposalRow.company, price: proposalRow.price, days: proposalRow.days };
            triggerIntegrations(req.user.company, wonProposal, orderRow).catch(() => {});

            await Promise.all(notifs.map(n => addNotification(n.company, n.text)));
            await Promise.all(notifs.map(async n => {
                const email = await getCompanyEmail(n.company);
                const won = n.text.includes('принято');
                if (email) await sendEmail(email, won ? `Предложение принято — «${title}»` : `Предложение отклонено — «${title}»`,
                    `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                      <h3 style="color:${won ? '#41bd97' : '#e07070'}">${won ? 'Ваше предложение принято!' : 'Предложение отклонено'}</h3>
                      <p>${won
                        ? `Поздравляем! Заказчик выбрал ваше предложение по закупке <strong>«${htmlEscape(title)}»</strong>.`
                        : `К сожалению, заказчик выбрал другого поставщика по закупке <strong>«${htmlEscape(title)}»</strong>.`
                      }</p>
                      <a href="${APP_URL}/producer.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                    </div>`
                );
            }));
            getUserIdsByCompany(proposalRow.company).then(ids =>
                ids.forEach(id => {
                    sendPush(id, 'КП принято!', `Ваше предложение по заявке «${title}» принято`, `${APP_URL}/deals`);
                    sendTelegramNotification(id, `✅ <b>КП принято!</b>\nЗакупка: «${title}»\nЗаказчик выбрал ваше предложение.`);
                })
            ).catch(() => {});
            res.json({ message: 'Победитель успешно определен, прямая закупка закрыта' });
        } catch (e) { next(e); }
    });

    router.post('/:proposalId/reject', requireAuth, requireRole('customer'), async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { rows: [proposalRow] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
            if (!proposalRow) return res.status(404).json({ error: 'Предложение не найдено' });

            const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [proposalRow.order_id]);
            if (!orderRow) return res.status(404).json({ error: 'Связанная заявка не найдена' });
            if (orderRow.company && orderRow.company !== req.user.company) return res.status(403).json({ error: 'Отклонять предложения может только владелец закупки' });
            if (proposalRow.status !== 'Ожидает ответа') return res.status(400).json({ error: 'Можно отклонить только предложение в статусе "Ожидает ответа"' });

            const rejectTitle = plainTitle(orderRow.title);
            await pool.query("UPDATE proposals SET status = 'Отклонен' WHERE id = $1", [proposalId]);
            await addNotification(proposalRow.company, `Ваше предложение по «${rejectTitle}» отклонено.`);
            const rejectEmail = await getCompanyEmail(proposalRow.company);
            if (rejectEmail) await sendEmail(rejectEmail, `Предложение отклонено — «${rejectTitle}»`,
                `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                  <h3 style="color:#e07070">Предложение отклонено</h3>
                  <p>Заказчик отклонил ваше предложение по закупке <strong>«${htmlEscape(rejectTitle)}»</strong>.</p>
                  <a href="${APP_URL}/producer.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                </div>`
            );
            getUserIdsByCompany(proposalRow.company).then(ids =>
                ids.forEach(id => {
                    sendPush(id, 'КП отклонено', `Предложение по заявке «${rejectTitle}» отклонено`, `${APP_URL}/proposals`);
                    sendTelegramNotification(id, `❌ <b>КП отклонено</b>\nЗакупка: «${rejectTitle}»`);
                })
            ).catch(() => {});
            const { rows: [updated] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
            res.json(rowToProposal(updated));
        } catch (e) { next(e); }
    });

    router.put('/:proposalId', requireAuth, requireRole('producer'), async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { price, days } = req.body;
            if (!price || !days) return res.status(400).json({ error: 'Не указаны цена или сроки' });

            const { rows: [row] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
            if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
            if (row.company !== req.user.company) return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });
            if (row.status !== 'Ожидает ответа') return res.status(400).json({ error: 'Можно редактировать только предложения в статусе "Ожидает ответа"' });

            await pool.query('UPDATE proposals SET price = $1, days = $2 WHERE id = $3', [Number(price), Number(days), proposalId]);
            const { rows: [updated] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
            res.json(rowToProposal(updated));
        } catch (e) { next(e); }
    });

    router.delete('/:proposalId', requireAuth, requireRole('producer'), async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { rows: [row] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
            if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
            if (row.company !== req.user.company) return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });

            await withTransaction(async (client) => {
                await client.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
                await client.query('UPDATE orders SET responses = GREATEST(0, responses - 1) WHERE id = $1', [row.order_id]);
            });

            res.json({ message: 'Предложение отозвано' });
        } catch (e) { next(e); }
    });

    return router;
}

function createOrderProposalsRouter(deps) {
    const {
        pool,
        requireAuth,
        getOrderAccessRow,
        rowToOrder,
        rowToProposal,
        rowToCompany,
        computeMatchScore,
        computeMatchReasons,
    } = deps;

    const router = express.Router();

    router.get('/:orderId', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const orderRow = await getOrderAccessRow(orderId);
            if (!orderRow) return res.status(404).json({ error: 'Закупка не найдена' });
            let rows;
            if (req.user.role === 'admin' || orderRow.company === req.user.company) {
                ({ rows } = await pool.query('SELECT * FROM proposals WHERE order_id = $1', [orderId]));
            } else if (req.user.role === 'producer') {
                ({ rows } = await pool.query(
                    'SELECT * FROM proposals WHERE order_id = $1 AND company = $2',
                    [orderId, req.user.company]
                ));
            } else {
                return res.status(403).json({ error: 'Нет доступа к предложениям этой закупки' });
            }

            const orderObj = rowToOrder(orderRow);
            const withMatch = (req.user.role === 'customer' || req.user.role === 'admin') && rows.length > 0;
            let producerByName = null;
            if (withMatch) {
                const companies = rows.map(r => r.company);
                const { rows: prodRows } = await pool.query(
                    "SELECT * FROM companies WHERE role = 'producer' AND company = ANY($1::text[])",
                    [companies]
                );
                producerByName = new Map(prodRows.map(r => [r.company, rowToCompany(r)]));
            }

            res.json(rows.map(r => {
                const p = rowToProposal(r);
                if (withMatch) {
                    const producer = producerByName.get(p.company);
                    p.matchScore = producer ? computeMatchScore(orderObj, producer) : 0;
                    p.matchReasons = producer ? computeMatchReasons(orderObj, producer) : [];
                }
                return p;
            }));
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createProposalsRouter;
module.exports.createOrderProposalsRouter = createOrderProposalsRouter;
