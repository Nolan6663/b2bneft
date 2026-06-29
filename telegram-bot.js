'use strict';
const { Telegraf, Markup } = require('telegraf');
const { pool } = require('./db');

const MAIN_MENU = Markup.keyboard([
    ['📋 Закупки', '📨 КП'],
    ['💬 Чат', '📦 Сделки'],
    ['🔔 Уведомления', '⚙️ Профиль'],
]).resize();

function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getUserByTgId(telegramId) {
    const { rows: [user] } = await pool.query(
        'SELECT * FROM users WHERE telegram_id=$1', [telegramId]
    );
    return user || null;
}

// Хранилище FSM-состояния для ответа в чат (in-memory, достаточно для polling)
const chatReplyState = new Map(); // tgId → { orderId, company }
const bidState = new Map(); // tgId → { orderId, step, price? }

function startTelegramBot() {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        console.log('[tg] TELEGRAM_BOT_TOKEN не задан — бот не запущен');
        return null;
    }

    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    global.__tgBot = bot;

    // /start — привязка или приветствие
    bot.start(async (ctx) => {
        const token = ctx.startPayload;
        const tgId = ctx.from.id;

        if (token) {
            const { rows: [user] } = await pool.query(
                `SELECT * FROM users WHERE telegram_link_token=$1 AND telegram_link_expires > NOW()`,
                [token]
            );
            if (!user) {
                return ctx.reply('Ссылка недействительна или истекла. Получите новую в настройках сайта.');
            }
            await pool.query(
                'UPDATE users SET telegram_id=$1, telegram_link_token=NULL, telegram_link_expires=NULL WHERE id=$2',
                [tgId, user.id]
            );
            return ctx.reply(
                `✅ Аккаунт привязан!\n\nДобро пожаловать, ${escHtml(user.company || user.email)}!`,
                MAIN_MENU
            );
        }

        const user = await getUserByTgId(tgId);
        if (!user) {
            return ctx.reply(
                '👋 Добро пожаловать в ТехЗаказ!\n\nЧтобы начать, привяжите аккаунт:\n1. Войдите на texzakaz.ru\n2. Откройте Настройки → Telegram\n3. Нажмите «Подключить Telegram»'
            );
        }
        return ctx.reply(`С возвращением, ${escHtml(user.company || user.email)}! 👋`, MAIN_MENU);
    });

    // Middleware: проверить что аккаунт привязан (пропускаем только /start)
    bot.use(async (ctx, next) => {
        if (!ctx.from) return;
        ctx.tgUser = await getUserByTgId(ctx.from.id);
        if (!ctx.tgUser) {
            await ctx.reply('Аккаунт не привязан. Отправьте /start для начала.');
            return;
        }
        return next();
    });

    // ── 📋 Закупки ────────────────────────────────────────────────────────────
    bot.hears('📋 Закупки', async (ctx) => {
        const { role, company } = ctx.tgUser;
        try {
            if (role === 'customer') {
                const { rows } = await pool.query(
                    `SELECT o.id, o.title, o.status, o.deadline,
                            COUNT(p.id) AS proposal_count
                     FROM orders o
                     LEFT JOIN proposals p ON p.order_id=o.id AND p.status='Ожидает ответа'
                     WHERE o.company=$1 AND o.status='Активный'
                     GROUP BY o.id ORDER BY o.created_at DESC LIMIT 10`,
                    [company]
                );
                if (!rows.length) return ctx.reply('У вас нет активных закупок.');
                const text = rows.map((o, i) =>
                    `${i + 1}. <b>${escHtml(o.title)}</b>\n   КП: ${o.proposal_count} | Дедлайн: ${o.deadline || '—'}`
                ).join('\n\n');
                await ctx.reply(`📋 <b>Ваши закупки:</b>\n\n${text}`, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(
                        rows.map(o => [Markup.button.callback(`📄 ${o.title.slice(0, 30)}`, `order:${o.id}`)])
                    )
                });
            } else {
                const { rows } = await pool.query(
                    `SELECT id, title, category, deadline FROM orders
                     WHERE status='Активный' ORDER BY created_at DESC LIMIT 10`
                );
                if (!rows.length) return ctx.reply('Активных закупок нет.');
                const text = rows.map((o, i) =>
                    `${i + 1}. <b>${escHtml(o.title)}</b>\n   ${escHtml(o.category)} | Дедлайн: ${o.deadline || '—'}`
                ).join('\n\n');
                await ctx.reply(`📋 <b>Активные закупки:</b>\n\n${text}`, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(
                        rows.map(o => [Markup.button.callback(`📨 ${o.title.slice(0, 28)}`, `bid:${o.id}`)])
                    ),
                });
            }
        } catch (e) {
            console.error('[tg:orders]', e.message);
            ctx.reply('Произошла ошибка. Попробуйте позже.');
        }
    });

    // Inline callback — карточка закупки (заказчик)
    bot.action(/^order:(\d+)$/, async (ctx) => {
        const orderId = parseInt(ctx.match[1]);
        try {
            const { rows: [o] } = await pool.query(
                `SELECT id, title, category, deadline, quantity, description FROM orders WHERE id=$1 AND status='Активный'`,
                [orderId]
            );
            if (!o) return ctx.answerCbQuery('Закупка не найдена');
            await ctx.editMessageText(
                `<b>${escHtml(o.title)}</b>\n` +
                `Категория: ${escHtml(o.category)}\n` +
                `Дедлайн: ${o.deadline || '—'}\n` +
                `Кол-во: ${o.quantity || '—'}`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[
                        Markup.button.callback('📨 Подать КП', `bid:${orderId}`),
                    ]]),
                }
            );
            await ctx.answerCbQuery();
        } catch (e) {
            console.error('[tg:order]', e.message);
            ctx.answerCbQuery('Ошибка');
        }
    });

    // Подать КП — FSM для поставщика
    bot.action(/^bid:(\d+)$/, async (ctx) => {
        if (ctx.tgUser.role !== 'producer') return ctx.answerCbQuery('Только для поставщиков');
        const orderId = parseInt(ctx.match[1]);
        bidState.set(ctx.from.id, { orderId, step: 'price' });
        await ctx.reply('Введите цену КП (число в рублях):');
        await ctx.answerCbQuery();
    });

    // ── 📨 КП ────────────────────────────────────────────────────────────────
    bot.hears('📨 КП', async (ctx) => {
        const { role, company } = ctx.tgUser;
        try {
            if (role === 'customer') {
                const { rows } = await pool.query(
                    `SELECT p.id, p.price, p.days, p.company AS supplier, o.title AS order_title
                     FROM proposals p JOIN orders o ON o.id=p.order_id
                     WHERE o.company=$1 AND p.status='Ожидает ответа'
                     ORDER BY p.created_at DESC LIMIT 10`,
                    [company]
                );
                if (!rows.length) return ctx.reply('Нет КП, ожидающих решения.');
                const text = rows.map((p, i) =>
                    `${i + 1}. <b>${escHtml(p.order_title)}</b>\n   Поставщик: ${escHtml(p.supplier)}\n   Цена: ${p.price} руб. | Срок: ${p.days} дн.`
                ).join('\n\n');
                await ctx.reply(`📨 <b>КП, ожидающие решения:</b>\n\n${text}`, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(
                        rows.map(p => [
                            Markup.button.callback(`✅ Принять #${p.id}`, `accept:${p.id}`),
                            Markup.button.callback(`❌ Отклонить #${p.id}`, `reject:${p.id}`),
                        ])
                    )
                });
            } else {
                const { rows } = await pool.query(
                    `SELECT p.id, p.price, p.days, p.status, o.title AS order_title
                     FROM proposals p JOIN orders o ON o.id=p.order_id
                     WHERE p.company=$1
                     ORDER BY p.created_at DESC LIMIT 10`,
                    [company]
                );
                if (!rows.length) return ctx.reply('У вас нет поданных КП.');
                const text = rows.map((p, i) =>
                    `${i + 1}. <b>${escHtml(p.order_title)}</b>\n   ${p.price} руб. | ${p.days} дн. | <i>${escHtml(p.status)}</i>`
                ).join('\n\n');
                await ctx.reply(`📨 <b>Ваши КП:</b>\n\n${text}`, { parse_mode: 'HTML' });
            }
        } catch (e) {
            console.error('[tg:proposals]', e.message);
            ctx.reply('Произошла ошибка. Попробуйте позже.');
        }
    });

    // Inline callback — принять КП
    bot.action(/^accept:(\d+)$/, async (ctx) => {
        const proposalId = parseInt(ctx.match[1]);
        try {
            const { rows: [proposal] } = await pool.query(
                `SELECT p.*, o.company AS customer_company, o.title AS order_title, o.id AS order_id
                 FROM proposals p JOIN orders o ON o.id=p.order_id
                 WHERE p.id=$1`, [proposalId]
            );
            if (!proposal) return ctx.answerCbQuery('КП не найдено');
            if (proposal.status !== 'Ожидает ответа') return ctx.answerCbQuery('КП уже обработано');

            await pool.query(`UPDATE proposals SET status='Выигран' WHERE id=$1`, [proposalId]);
            await pool.query(
                `UPDATE proposals SET status='Проигран'
                 WHERE order_id=$1 AND id!=$2 AND status='Ожидает ответа'`,
                [proposal.order_id, proposalId]
            );
            await ctx.editMessageText(
                `✅ КП #${proposalId} принято!\n\nЗакупка: <b>${escHtml(proposal.order_title)}</b>\nПоставщик: ${escHtml(proposal.company)}`,
                { parse_mode: 'HTML' }
            );
            await ctx.answerCbQuery('КП принято!');
        } catch (e) {
            console.error('[tg:accept]', e.message);
            ctx.answerCbQuery('Ошибка при принятии КП');
        }
    });

    // Inline callback — отклонить КП
    bot.action(/^reject:(\d+)$/, async (ctx) => {
        const proposalId = parseInt(ctx.match[1]);
        try {
            const { rows: [proposal] } = await pool.query(
                'SELECT * FROM proposals WHERE id=$1', [proposalId]
            );
            if (!proposal) return ctx.answerCbQuery('КП не найдено');
            if (proposal.status !== 'Ожидает ответа') return ctx.answerCbQuery('КП уже обработано');

            await pool.query(`UPDATE proposals SET status='Отклонен' WHERE id=$1`, [proposalId]);
            await ctx.editMessageText(`❌ КП #${proposalId} отклонено.`);
            await ctx.answerCbQuery('КП отклонено');
        } catch (e) {
            console.error('[tg:reject]', e.message);
            ctx.answerCbQuery('Ошибка');
        }
    });

    // ── 💬 Чат ──────────────────────────────────────────────────────────────
    bot.hears('💬 Чат', async (ctx) => {
        const { role, company } = ctx.tgUser;
        try {
            let rows;
            if (role === 'customer') {
                const { rows: r } = await pool.query(
                    `SELECT m.order_id, m.company, o.title, MAX(m.created_at) AS last_msg,
                            COUNT(CASE WHEN m.read=false AND m.sender='producer' THEN 1 END) AS unread
                     FROM messages m JOIN orders o ON o.id=m.order_id
                     WHERE o.company=$1
                     GROUP BY m.order_id, m.company, o.title
                     ORDER BY last_msg DESC LIMIT 10`,
                    [company]
                );
                rows = r;
            } else {
                const { rows: r } = await pool.query(
                    `SELECT m.order_id, m.company, o.title, MAX(m.created_at) AS last_msg,
                            COUNT(CASE WHEN m.read=false AND m.sender='customer' THEN 1 END) AS unread
                     FROM messages m JOIN orders o ON o.id=m.order_id
                     WHERE m.company=$1
                     GROUP BY m.order_id, m.company, o.title
                     ORDER BY last_msg DESC LIMIT 10`,
                    [company]
                );
                rows = r;
            }

            if (!rows.length) return ctx.reply('Нет активных переписок.');
            const text = rows.map((r, i) =>
                `${i + 1}. <b>${escHtml(r.title)}</b>${r.unread > 0 ? ` 🔴${r.unread}` : ''}`
            ).join('\n');
            await ctx.reply(`💬 <b>Переписки:</b>\n\n${text}`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard(
                    rows.map(r => [
                        Markup.button.callback(
                            `💬 ${r.title.slice(0, 25)}${r.unread > 0 ? ` (${r.unread} новых)` : ''}`,
                            `chat:${r.order_id}:${r.company}`
                        )
                    ])
                )
            });
        } catch (e) {
            console.error('[tg:chat]', e.message);
            ctx.reply('Произошла ошибка.');
        }
    });

    bot.action(/^chat:(\d+):(.+)$/, async (ctx) => {
        const orderId = parseInt(ctx.match[1]);
        const company = ctx.match[2];
        try {
            const { rows } = await pool.query(
                `SELECT sender, text, created_at FROM messages
                 WHERE order_id=$1 AND company=$2
                 ORDER BY created_at DESC LIMIT 5`,
                [orderId, company]
            );
            const preview = rows.reverse().map(m =>
                `<b>${m.sender === 'customer' ? '🏢' : '🏭'}</b> ${escHtml(m.text.slice(0, 100))}`
            ).join('\n');

            chatReplyState.set(ctx.from.id, { orderId, company });
            await ctx.editMessageText(
                `${preview || 'Нет сообщений'}\n\n<i>Напишите ответ или нажмите Отмена:</i>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'chat:cancel')]])
                }
            );
            await ctx.answerCbQuery();
        } catch (e) {
            console.error('[tg:chat:open]', e.message);
            ctx.answerCbQuery('Ошибка');
        }
    });

    bot.action('chat:cancel', async (ctx) => {
        chatReplyState.delete(ctx.from.id);
        await ctx.editMessageText('Отмена.');
        await ctx.answerCbQuery();
    });

    // Текстовые сообщения: КП из Telegram, ответ в чат
    bot.on('text', async (ctx, next) => {
        const bid = bidState.get(ctx.from.id);
        if (bid && ctx.tgUser?.role === 'producer') {
            const text = ctx.message.text.trim();
            if (bid.step === 'price') {
                const price = parseFloat(text.replace(/\s/g, '').replace(',', '.'));
                if (!Number.isFinite(price) || price <= 0) {
                    return ctx.reply('Введите корректную цену числом.');
                }
                bid.price = price;
                bid.step = 'days';
                bidState.set(ctx.from.id, bid);
                return ctx.reply('Укажите срок поставки в днях:');
            }
            if (bid.step === 'days') {
                const days = parseInt(text, 10);
                if (!Number.isFinite(days) || days <= 0) {
                    return ctx.reply('Введите корректный срок (целое число дней).');
                }
                bidState.delete(ctx.from.id);
                try {
                    const { rows: [o] } = await pool.query('SELECT title FROM orders WHERE id=$1', [bid.orderId]);
                    await pool.query(
                        `INSERT INTO proposals (order_id, order_title, price, days, company, status)
                         VALUES ($1,$2,$3,$4,$5,'Ожидает ответа')`,
                        [bid.orderId, o?.title || '', bid.price, days, ctx.tgUser.company]
                    );
                    await pool.query(
                        'UPDATE orders SET responses = responses + 1 WHERE id = $1',
                        [bid.orderId]
                    );
                    await ctx.reply(`✅ КП отправлено!\n\nЦена: ${bid.price} ₽\nСрок: ${days} дн.`, MAIN_MENU);
                } catch (e) {
                    console.error('[tg:bid]', e.message);
                    await ctx.reply('Не удалось отправить КП. Возможно, вы уже откликались.', MAIN_MENU);
                }
                return;
            }
        }

        const state = chatReplyState.get(ctx.from.id);
        if (!state) return next();

        const { orderId, company } = state;
        chatReplyState.delete(ctx.from.id);

        try {
            const text = ctx.message.text.slice(0, 2000);
            const role = ctx.tgUser.role;
            await pool.query(
                'INSERT INTO messages (order_id,company,sender,text) VALUES ($1,$2,$3,$4)',
                [orderId, company, role, text]
            );
            await ctx.reply('✅ Сообщение отправлено!', MAIN_MENU);
        } catch (e) {
            console.error('[tg:chat:send]', e.message);
            ctx.reply('Не удалось отправить сообщение.');
        }
    });

    // ── 📦 Сделки ────────────────────────────────────────────────────────────
    bot.hears('📦 Сделки', async (ctx) => {
        const { role, company } = ctx.tgUser;
        try {
            let rows;
            if (role === 'customer') {
                const { rows: r } = await pool.query(
                    `SELECT o.title, p.company AS supplier, p.price, p.days, p.delivery_stage
                     FROM proposals p JOIN orders o ON o.id=p.order_id
                     WHERE o.company=$1 AND p.status='Выигран'
                     ORDER BY p.created_at DESC LIMIT 10`,
                    [company]
                );
                rows = r;
            } else {
                const { rows: r } = await pool.query(
                    `SELECT o.title, o.company AS customer, p.price, p.days, p.delivery_stage
                     FROM proposals p JOIN orders o ON o.id=p.order_id
                     WHERE p.company=$1 AND p.status='Выигран'
                     ORDER BY p.created_at DESC LIMIT 10`,
                    [company]
                );
                rows = r;
            }

            if (!rows.length) return ctx.reply('Нет активных сделок.');
            const text = rows.map((d, i) =>
                `${i + 1}. <b>${escHtml(d.title)}</b>\n   ${d.price} руб. | Этап: ${escHtml(d.delivery_stage || 'не указан')}`
            ).join('\n\n');
            await ctx.reply(`📦 <b>Сделки:</b>\n\n${text}`, { parse_mode: 'HTML' });
        } catch (e) {
            console.error('[tg:deals]', e.message);
            ctx.reply('Произошла ошибка.');
        }
    });

    // ── 🔔 Уведомления ───────────────────────────────────────────────────────
    bot.hears('🔔 Уведомления', async (ctx) => {
        const { company } = ctx.tgUser;
        try {
            const { rows } = await pool.query(
                `SELECT text, read, created_at FROM notifications
                 WHERE company=$1 ORDER BY created_at DESC LIMIT 10`,
                [company]
            );
            if (!rows.length) return ctx.reply('Нет уведомлений.');
            const text = rows.map(n =>
                `${n.read ? '○' : '🔴'} ${escHtml(n.text)}`
            ).join('\n');
            await ctx.reply(`🔔 <b>Уведомления:</b>\n\n${text}`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[
                    Markup.button.callback('✓ Отметить все прочитанными', 'notif:read_all')
                ]])
            });
        } catch (e) {
            console.error('[tg:notifications]', e.message);
            ctx.reply('Произошла ошибка.');
        }
    });

    bot.action('notif:read_all', async (ctx) => {
        try {
            await pool.query(
                'UPDATE notifications SET read=true WHERE company=$1',
                [ctx.tgUser.company]
            );
            await ctx.editMessageText('✅ Все уведомления отмечены прочитанными.');
            await ctx.answerCbQuery();
        } catch (e) {
            ctx.answerCbQuery('Ошибка');
        }
    });

    // ── ⚙️ Профиль ──────────────────────────────────────────────────────────
    bot.hears('⚙️ Профиль', async (ctx) => {
        const { email, role, company } = ctx.tgUser;
        const roleLabel = role === 'customer' ? 'Заказчик' : role === 'producer' ? 'Поставщик' : 'Администратор';
        const appUrl = process.env.APP_URL || 'https://texzakaz.ru';
        await ctx.reply(
            `⚙️ <b>Профиль</b>\n\n` +
            `Email: ${escHtml(email)}\n` +
            `Компания: ${escHtml(company)}\n` +
            `Роль: ${roleLabel}\n\n` +
            `<a href="${appUrl}">Открыть ТехЗаказ →</a>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[
                    Markup.button.callback('🔗 Отвязать Telegram', 'profile:unlink')
                ]])
            }
        );
    });

    bot.action('profile:unlink', async (ctx) => {
        try {
            await pool.query(
                'UPDATE users SET telegram_id=NULL WHERE id=$1',
                [ctx.tgUser.id]
            );
            await ctx.editMessageText('Telegram отвязан. Для повторной привязки используйте настройки сайта.');
            await ctx.answerCbQuery();
        } catch (e) {
            ctx.answerCbQuery('Ошибка');
        }
    });

    // Запуск polling
    bot.launch({ dropPendingUpdates: true });
    console.log('[tg] Telegram бот запущен (polling)');

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

    return bot;
}

module.exports = { startTelegramBot };
