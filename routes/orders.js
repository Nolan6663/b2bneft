'use strict';

const express = require('express');
const { sendHttpError } = require('../lib/http-errors');
const { linkOrder } = require('../lib/order-linking');
const { matchSubscribers, isQuiet, notificationText } = require('../lib/order-subscriptions');

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
        vkPoster,
        persistUploads,
        handleVideoUpload,
        persistVideo,
        parseOrderAttachments,
        maxOrderAttachments,
        rowToOrder,
        rowToCompany,
        computeMatchScore,
        computeMatchReasons,
        matchedProducers,
        computePriceBenchmark,
        plainTitle,
        htmlEscape,
        notifyCompanyEmail,
        withTransaction,
        addNotification,
        emitRealtime,
        emitDashboardRefresh,
        getUserIdsByCompany,
        sendPush,
        sendTelegramNotification,
        getOrderAccessRow,
        APP_URL,
        logOrderEvent,
        registryInviter,
    } = deps;

    const router = express.Router();

    // Первая закупка компании публикуется без подтверждённого email: людей приводит
    // публичный мастер, почта на домене пока не поднята, и терять их на письме
    // дороже, чем риск одной мусорной заявки. Рассылки наружу при этом
    // придерживаются до подтверждения — см. allowOutbound в обработчике ниже.
    async function allowFirstOrderWithoutVerification(req, res, next) {
        try {
            if (req.user.role === 'admin' || req.user.email_verified) return next();
            const { rows: [row] } = await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE company = $1', [req.user.company]);
            if (Number(row?.n || 0) === 0) return next();
            return res.status(403).json({ error: 'Подтвердите email — ссылка в письме. После этого закупки размещаются без ограничений.' });
        } catch (e) { next(e); }
    }

    router.get('/public/category-benchmark', async (req, res, next) => {
        try {
            const category = String(req.query.category || '').trim();
            if (!category) return res.json({ enough: false, sampleSize: 0, category: '' });
            const benchmark = await computePriceBenchmark(category, 0);
            res.json(benchmark);
        } catch (e) { next(e); }
    });

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
            orders.map(rowToOrder).forEach(o => {
                if (!me) {
                    scores[o.id] = { score: 0, reasons: [] };
                    return;
                }
                scores[o.id] = {
                    score: computeMatchScore(o, me),
                    reasons: computeMatchReasons(o, me),
                };
            });
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

    /* Один эндпоинт на все вложения: ?file=<индекс> выбирает нужное, без
       параметра отдаётся первое — так продолжают работать старые ссылки. */
    router.get('/:orderId/drawing', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            if (!(await canAccessOrderDrawing(req.user, orderId))) {
                return sendHttpError(req, res, 403, 'Нет доступа к чертежу этой закупки');
            }
            const { rows: [row] } = await pool.query('SELECT drawing, attachments FROM orders WHERE id = $1', [orderId]);
            const files = parseOrderAttachments(row);
            if (!files.length) return sendHttpError(req, res, 404, 'Файл не найден');

            const index = req.query.file !== undefined ? Number(req.query.file) : 0;
            const drawing = Number.isInteger(index) ? files[index] : null;
            if (!drawing) return sendHttpError(req, res, 404, 'Файл не найден');

            if (!storage.isRemote() && !storage.existsLocally(drawing.storedName)) {
                return sendHttpError(req, res, 404, 'Файл был удалён с сервера');
            }
            const inline = req.query.inline === '1';
            /* Range прокидываем как есть: без него видео в плеере не мотается */
            await storage.streamToResponse(drawing.storedName, res, drawing.originalName, {
                inline,
                range: req.headers.range || null,
            });
        } catch (e) { next(e); }
    });

    /* Запрос доступа к чертежу.
     *
     * Размыкает круг, в который упирался завод: чертёж открывался после КП, а
     * КП требует цену — то есть цену просили назвать вслепую. Теперь доступ
     * даёт отдельный шаг, ни к чему не обязывающий.
     *
     * Шаг именной: запись остаётся в order_drawing_requests, заказчик получает
     * уведомление и видит, кто открывал его чертёж. Защита от растаскивания
     * чертежей по каталогу не исчезла — она перестала быть замком и стала
     * журналом, и это осознанный размен.
     */
    router.post('/:orderId/drawing-access', requireAuth, requireRole('producer'), async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            if (!orderId) return res.status(400).json({ error: 'Не указана закупка' });

            const order = await getOrderAccessRow(orderId);
            if (!order) return res.status(404).json({ error: 'Закупка не найдена' });
            // По закрытой заявке чертёж не выдаём: откликнуться на неё уже
            // нельзя, а значит и смотреть незачем — это был бы просто слив.
            if (order.status === 'Отменена' || order.status === 'Закрыта') {
                return res.status(409).json({ error: 'Заявка закрыта — чертёж по ней больше не выдаётся' });
            }

            // RETURNING, а не rowCount: по нему видно, была ли запись создана
            // именно сейчас, и это же читаемо в тестах без живой базы.
            const { rows: [created] } = await pool.query(
                `INSERT INTO order_drawing_requests (order_id, company) VALUES ($1, $2)
                 ON CONFLICT (order_id, company) DO NOTHING
                 RETURNING id`,
                [orderId, req.user.company]
            );

            // Уведомляем заказчика только на первом запросе: повторный — это тот
            // же завод, открывший чертёж во второй раз, дёргать человека незачем.
            if (created) {
                await addNotification(
                    order.company,
                    `Завод «${req.user.company}» открыл чертёж по заявке «${plainTitle(order.title) || ''}»`
                );
            }
            res.json({ ok: true });
        } catch (e) { next(e); }
    });

    /* Заявки, по которым чертёж этой компании уже открыт. Нужен интерфейсу:
       без него он не знает, рисовать кнопку «Посмотреть чертёж» или сами
       ссылки на файл, и рисовал бы ссылки всегда — ровно тот баг, из-за
       которого завод получал на экран текст ошибки вместо чертежа. */
    router.get('/drawing-access', requireAuth, requireRole('producer'), async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                'SELECT order_id FROM order_drawing_requests WHERE company = $1',
                [req.user.company]
            );
            res.json(rows.map((r) => r.order_id));
        } catch (e) { next(e); }
    });

    /* Видео грузится отдельным запросом, а не вместе с заявкой: ролик весит
       сотни мегабайт, и держать создание закупки заложником такой загрузки
       нельзя — заявка публикуется сразу, видео доезжает следом. */
    router.post('/:orderId/video', requireAuth, requireRole('customer'), handleVideoUpload, async (req, res, next) => {
        try {
            const orderId = Number(req.params.orderId);
            const { rows: [row] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
            const order = rowToOrder(row);
            if (order.company && order.company !== req.user.company) {
                return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
            }
            if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

            const files = Array.isArray(order.attachments) ? order.attachments.slice() : [];
            if (files.length >= maxOrderAttachments) {
                return res.status(400).json({ error: `К заявке уже приложено ${maxOrderAttachments} файлов` });
            }
            if (files.some(f => f.kind === 'video')) {
                return res.status(400).json({ error: 'К заявке уже приложено видео' });
            }

            const video = await persistVideo(req.file);
            files.push(video);

            await pool.query(
                'UPDATE orders SET drawing = $1, attachments = $2 WHERE id = $3',
                [JSON.stringify(files[0]), JSON.stringify(files), orderId]
            );
            const { rows: [updated] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            res.json(rowToOrder(updated));
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

    /* Уведомление подписчиков о новой заявке — ТЗ §6.6.
     *
     * Совпадение считается по тем же связям, по которым заявка попадает в хаб
     * заказов: если она там показывается, подписчик этой темы должен о ней
     * узнать, и наоборот. Отдельное правило для одного и того же вопроса
     * неизбежно разъехалось бы с первым же изменением.
     *
     * Тишина в час на подписку — не оптимизация, а забота о читателе: заявки
     * приходят пачками, и десять писем подряд превращают полезное уведомление
     * в причину отписаться. */
    async function notifySubscribers(orderRow) {
        const { rows: links } = await pool.query(
            `SELECT 'service' AS kind, service_id AS id FROM order_services WHERE order_id = $1
             UNION ALL
             SELECT 'product', product_id FROM order_products WHERE order_id = $1`,
            [orderRow.id]
        );
        if (!links.length) return;

        const services = links.filter(l => l.kind === 'service').map(l => l.id);
        const products = links.filter(l => l.kind === 'product').map(l => l.id);

        const { rows: subs } = await pool.query(`
            SELECT sub.id, sub.company, sub.service_id, sub.product_id, sub.region,
                   sub.channel, sub.last_sent_at, COALESCE(s.name, p.name) AS topic
              FROM order_subscriptions sub
              LEFT JOIN services s ON s.id = sub.service_id
              LEFT JOIN products p ON p.id = sub.product_id
             WHERE sub.service_id = ANY($1::int[]) OR sub.product_id = ANY($2::int[])
        `, [services, products]);

        const matched = matchSubscribers(subs, { services, products });
        for (const sub of matched) {
            if (isQuiet(sub)) continue;
            // Заказчику своя же заявка не нужна.
            if (sub.company === orderRow.company) continue;
            try {
                await addNotification(sub.company, notificationText(orderRow, sub.topic));
                await pool.query('UPDATE order_subscriptions SET last_sent_at = NOW() WHERE id = $1', [sub.id]);
            } catch (e) {
                console.error('order-subscriptions: не удалось уведомить', sub.company, e.message);
            }
        }
    }

    router.post('/', requireAuth, requireRole('customer'), allowFirstOrderWithoutVerification, handleDrawingUpload, async (req, res, next) => {
        try {
            const { title, category, deadline, quantity, description, productionType, material } = req.body;
            if (!title || !category || !deadline) return res.status(400).json({ error: 'Заполните все поля заявки' });

            /* Тип производства и материал (ТЗ §6.8) необязательны: заказчик
               часто их не знает, и требовать — значит терять заявку. Тип
               сверяем со списком, а не пишем что прислали: это поле показывается
               исполнителю как факт о заказе. */
            const PRODUCTION_TYPES = ['Единичное', 'Партия', 'Серия'];
            const prodType = PRODUCTION_TYPES.includes(productionType) ? productionType : '';
            const materialText = String(material || '').trim().slice(0, 200);

            // Пока email не подтверждён, наружу ничего не шлём: письма и инвайты
            // ждут подтверждения (их отпускает flushPendingOutbound в routes/auth.js).
            const allowOutbound = req.user.role === 'admin' || Boolean(req.user.email_verified);

            const files = await persistUploads(req.uploadedFiles, 'drawings');
            /* drawing пишем первым файлом: на него смотрят старые записи и код,
               который умеет только один чертёж. Полный список — в attachments. */
            const drawing = files.length ? JSON.stringify(files[0]) : null;
            const attachments = files.length ? JSON.stringify(files) : null;
            const { rows: [newRow] } = await pool.query(
                'INSERT INTO orders (title,category,deadline,quantity,description,company,drawing,attachments,outbound_pending,production_type,material) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
                [title, category, deadline, quantity ? Number(quantity) : null,
                 description ? String(description).slice(0, 1000) : '', req.user.company, drawing, attachments, !allowOutbound,
                 prodType, materialText]
            );
            const newOrder = rowToOrder(newRow);
            await logOrderEvent(newOrder.id, 'created', 'Закупка опубликована', newOrder.category || '', req.user.company);

            /* Привязка к справочнику услуг и изделий: по ней собираются
               тематические хабы /zakazy и блок «открытые закупки» на страницах
               кластера. Разбор не должен ронять публикацию — заявка важнее
               связей, и заказчик не обязан страдать из-за нашего разбора
               текста, поэтому ошибка только пишется в лог. */
            try {
                await linkOrder(pool, newRow);
                await notifySubscribers(newRow);
            } catch (e) {
                console.error('order-linking: не удалось связать заявку', newOrder.id, e.message);
            }

            const MATCH_NOTIFY_THRESHOLD = 50;
            const HOT_MATCH_THRESHOLD = 70;
            const matched = await matchedProducers(newOrder, MATCH_NOTIFY_THRESHOLD, true);
            const orderTitle = plainTitle(newOrder.title);
            const orderUrl = `${APP_URL}/producer.html`;

            await Promise.all(matched.map(async (m) => {
                const reasonsHtml = (m.reasons || []).length
                    ? `<ul style="margin:8px 0 0;padding-left:18px;color:#555;font-size:13px;">${m.reasons.map(r => `<li>${htmlEscape(r)}</li>`).join('')}</ul>`
                    : '';
                const isHot = m.score >= HOT_MATCH_THRESHOLD;
                const label = isHot ? 'Горячий матч' : 'Подходящая закупка';
                const notifText = `${label} (${m.score}%): «${orderTitle}»${m.reasons?.length ? ' — ' + m.reasons[0] : ''}`;

                await addNotification(m.company, notifText);
                if (allowOutbound) await notifyCompanyEmail(
                    m.company,
                    notifText,
                    `${label} (${m.score}%) — ТехЗаказ`,
                    `<p style="color:#444;font-size:14px;line-height:1.5;">${isHot ? '<strong>Горячий матч</strong> — закупка хорошо подходит вашему профилю' : 'Появилась закупка, которая подходит вашему профилю'} на <strong>${m.score}%</strong>:</p>
                     <p style="font-size:15px;font-weight:600;color:#1E3A5F;">«${htmlEscape(orderTitle)}»</p>
                     <p style="color:#666;font-size:13px;">Категория: ${htmlEscape(newOrder.category || '—')}</p>
                     ${reasonsHtml}
                     <p style="margin-top:16px;"><a href="${orderUrl}" style="display:inline-block;background:#FF6A00;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Открыть закупки →</a></p>`
                );

                if (isHot && allowOutbound) {
                    const userIds = await getUserIdsByCompany(m.company);
                    const pushBody = `${m.score}% · ${orderTitle}${m.reasons?.[0] ? ' · ' + m.reasons[0] : ''}`;
                    await Promise.all(userIds.map(id => {
                        sendPush(id, `Горячий матч ${m.score}%`, pushBody.slice(0, 120), orderUrl);
                        sendTelegramNotification(id, `<b>Горячий матч ${m.score}%</b>\n«${orderTitle}»\n${(m.reasons || []).slice(0, 2).join('\n')}`);
                    }));
                }
            }));

            const orderSummary = { id: newOrder.id, title: orderTitle, category: newOrder.category, deadline: newOrder.deadline };
            const notifiedCompanies = [...new Set(matched.map(m => m.company))];
            for (const company of notifiedCompanies) {
                emitDashboardRefresh(company);
                emitRealtime(company, 'order:new', orderSummary);
            }

            /* Публикация в сообществе ВКонтакте: только ставим в очередь, постит
               воркер. До подтверждения email наружу ничего не выпускаем — пост
               в ленте так же не откатить, как и письмо. */
            if (allowOutbound && vkPoster) {
                vkPoster.enqueue(newOrder).catch(e => console.error('[vk] очередь:', e.message));
            }

            // Приглашения заводам из госреестра (fire-and-forget). До подтверждения
            // email не шлём: письмо уходит двадцати живым заводам, откатить нельзя.
            if (allowOutbound) {
                registryInviter.inviteStubsForOrder(newOrder)
                    .then(n => { if (n) console.log(`registry-invites: отправлено ${n} по заявке ${newOrder.id}`); })
                    .catch(e => console.error('registry-invites:', e.message));
            }

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

            /* Вложения: клиент присылает список оставленных файлов (keepFiles —
               storedName через запятую) и, возможно, новые. Чего нет в списке —
               удаляем из хранилища. Поля нет вообще — считаем, что старые файлы
               остаются: так старый клиент не потеряет чертёж. */
            let files = Array.isArray(order.attachments) ? order.attachments.slice() : [];
            if (req.body.keepFiles !== undefined) {
                const keep = new Set(String(req.body.keepFiles).split(',').map(s => s.trim()).filter(Boolean));
                files.filter(f => !keep.has(f.storedName)).forEach(deleteDrawingFile);
                files = files.filter(f => keep.has(f.storedName));
            }
            const added = await persistUploads(req.uploadedFiles, 'drawings');
            files = files.concat(added).slice(0, maxOrderAttachments);

            const drawingJson = files.length ? JSON.stringify(files[0]) : null;
            const attachmentsJson = files.length ? JSON.stringify(files) : null;

            await pool.query(
                'UPDATE orders SET title=$1,category=$2,deadline=$3,quantity=$4,description=$5,drawing=$6,attachments=$7 WHERE id=$8',
                [title, category, deadline, quantity ? Number(quantity) : null,
                 description !== undefined ? String(description).slice(0, 1000) : (order.description || ''),
                 drawingJson, attachmentsJson, orderId]
            );
            const { rows: [updated] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            await logOrderEvent(orderId, 'updated', 'Закупка изменена', title, req.user.company);
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
            await logOrderEvent(orderId, 'cancelled', 'Закупка отменена', title, req.user.company);
            const { rows: [updated] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            res.json(rowToOrder(updated));
        } catch (e) { next(e); }
    });

    return router;
};
