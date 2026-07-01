'use strict';

async function acceptWonProposal(deps, { proposalId, actorCompany }) {
    const {
        pool, withTransaction, addNotification, getCompanyEmail, sendEmail,
        getUserIdsByCompany, sendPush, sendTelegramNotification,
        triggerIntegrations, logOrderEvent, plainTitle, htmlEscape, APP_URL,
    } = deps;

    const { rows: [proposalRow] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
    if (!proposalRow) return { ok: false, reason: 'proposal_not_found' };

    const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [proposalRow.order_id]);
    if (!orderRow) return { ok: false, reason: 'order_not_found' };
    if (orderRow.status === 'Закрыта' || orderRow.status === 'Отменена') {
        return { ok: false, reason: 'order_already_closed' };
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

    await logOrderEvent(
        orderRow.id,
        'closed',
        'Закупка закрыта — КП принято',
        `${proposalRow.company} · ${Number(proposalRow.price).toLocaleString('ru-RU')} ₽`,
        actorCompany
    );

    const wonProposal = { id: proposalId, company: proposalRow.company, price: proposalRow.price, days: proposalRow.days };
    // triggerIntegrations looks up integrations by the ORDER OWNER's company, not the actor — must stay orderRow.company even when actorCompany is 'Система (аукцион)'
    triggerIntegrations(orderRow.company, wonProposal, orderRow).catch(() => {});

    await Promise.all(notifs.map(n => addNotification(n.company, n.text)));
    await Promise.all(notifs.map(async n => {
        const email = await getCompanyEmail(n.company);
        const won = n.text.includes('принято');
        if (email) {
            try {
                await sendEmail(email, won ? `Предложение принято — «${title}»` : `Предложение отклонено — «${title}»`,
                    `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                      <h3 style="color:${won ? '#41bd97' : '#e07070'}">${won ? 'Ваше предложение принято!' : 'Предложение отклонено'}</h3>
                      <p>${won
                        ? `Поздравляем! Заказчик выбрал ваше предложение по закупке <strong>«${htmlEscape(title)}»</strong>.`
                        : `К сожалению, заказчик выбрал другого поставщика по закупке <strong>«${htmlEscape(title)}»</strong>.`
                      }</p>
                      <a href="${APP_URL}/producer.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                    </div>`
                );
            } catch (e) {
                console.error('[email]', e.message);
            }
        }
    }));
    getUserIdsByCompany(proposalRow.company).then(ids =>
        ids.forEach(id => {
            sendPush(id, 'КП принято!', `Ваше предложение по заявке «${title}» принято`, `${APP_URL}/deals`);
            sendTelegramNotification(id, `✅ <b>КП принято!</b>\nЗакупка: «${title}»\nЗаказчик выбрал ваше предложение.`);
        })
    ).catch(() => {});

    return { ok: true, orderTitle: title, orderRow, winner: wonProposal };
}

module.exports = { acceptWonProposal };
