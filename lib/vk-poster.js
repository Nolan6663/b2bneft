'use strict';

/* Автопостинг новых закупок в сообщество ВКонтакте.

   Очередь в базе, а не отправка на месте: ВК может лежать или упереться в
   суточный лимит постов, а публикация закупки от этого зависеть не должна.
   Тот же приём, что с придержанными письмами (orders.outbound_pending).

   Рубильник VK_AUTOPOST_ENABLED=0 глушит отправку целиком: на прод выкатываем
   именно так, включаем осознанно. Без VK_ACCESS_TOKEN воркер не стартует. */

const API_VERSION = process.env.VK_API_VERSION || '5.199';
const TICK_MS = Number(process.env.VK_POST_INTERVAL_MS) || 3 * 60 * 1000;
const BATCH = 5;
const MAX_ATTEMPTS = 5;
const DESC_LIMIT = 400;

function createVkPoster({ pool, appUrl, fetchImpl }) {
    const doFetch = fetchImpl || globalThis.fetch;
    const base = String(appUrl || 'https://texzakaz.ru').replace(/\/$/, '');

    function isEnabled() {
        if (process.env.VK_AUTOPOST_ENABLED === '0') return false;
        return Boolean(process.env.VK_ACCESS_TOKEN && process.env.VK_GROUP_ID);
    }

    /* Тестовые закупки в живое сообщество не пускаем: проверки идут на проде
       под учётками из .env, и лента сообщества от них засоряется. */
    function isTestCompany(company) {
        const testNames = [process.env.TEST_CUSTOMER_COMPANY, process.env.TEST_PRODUCER_COMPANY]
            .filter(Boolean)
            .map(s => s.toLowerCase());
        const name = String(company || '').toLowerCase();
        if (testNames.includes(name)) return true;
        return /(^|\s)(тест|test|e2e)/i.test(name);
    }

    async function enqueue(order) {
        if (!order || !order.id) return false;
        if (isTestCompany(order.company)) return false;
        try {
            await pool.query(
                'INSERT INTO vk_posts (order_id) VALUES ($1) ON CONFLICT (order_id) DO NOTHING',
                [order.id]
            );
            return true;
        } catch (e) {
            console.error('[vk] не удалось поставить закупку в очередь:', e.message);
            return false;
        }
    }

    function buildMessage(order) {
        const lines = [];
        lines.push(`Новая заявка: ${order.title}`);
        lines.push('');
        if (order.category) lines.push(`Категория: ${order.category}`);
        if (order.quantity) lines.push(`Количество: ${order.quantity} шт.`);
        if (order.deadline) {
            const d = new Date(order.deadline);
            if (!Number.isNaN(d.getTime())) {
                lines.push(`Срок поставки: ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`);
            }
        }
        const desc = String(order.description || '').trim().replace(/\s+/g, ' ');
        if (desc) {
            lines.push('');
            lines.push(desc.length > DESC_LIMIT ? `${desc.slice(0, DESC_LIMIT).trimEnd()}…` : desc);
        }
        lines.push('');
        lines.push('Задание целиком и отклик — на странице заявки:');
        lines.push(`${base}/zakupka/${order.id}`);
        return lines.join('\n');
    }

    async function callVk(method, params) {
        const body = new URLSearchParams({
            ...params,
            access_token: process.env.VK_ACCESS_TOKEN,
            v: API_VERSION,
        });
        const res = await doFetch(`https://api.vk.com/method/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: AbortSignal.timeout(15000),
        });
        const json = await res.json();
        if (json.error) {
            const err = new Error(json.error.error_msg || 'ошибка ВК');
            err.vkCode = json.error.error_code;
            throw err;
        }
        return json.response;
    }

    /* Пока запись ждала своей очереди, заказчик мог закрыть заявку, а дедлайн —
       пройти. Публиковать такое нельзя: завод придёт по ссылке на мёртвую
       страницу, а лента наберёт заявок, на которые уже не откликнуться. */
    function skipReason(order) {
        if (!order) return 'закупка удалена';
        if (order.status && order.status !== 'Активный') return `статус «${order.status}»`;
        if (order.deadline) {
            const d = new Date(order.deadline);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (!Number.isNaN(d.getTime()) && d < today) return 'дедлайн прошёл';
        }
        return null;
    }

    /* Ссылку отдаём вложением, чтобы ВК собрал карточку сайта. Но он умеет
       отказывать на разборе картинки — «link_photo_sizing_rule: No photo given»,
       в том числе когда держит в кеше прошлую неудачу. Ради красивой карточки
       терять публикацию нельзя, поэтому при такой ошибке повторяем без
       вложения: ссылка остаётся в тексте и всё равно кликабельна. */
    function isLinkSnippetError(e) {
        return /link_photo_sizing_rule|No photo given/i.test(String(e && e.message));
    }

    async function postWithLinkFallback(order) {
        const params = {
            owner_id: `-${process.env.VK_GROUP_ID}`,
            from_group: '1',
            message: buildMessage(order),
        };
        try {
            return await callVk('wall.post', { ...params, attachments: `${base}/zakupka/${order.id}` });
        } catch (e) {
            if (!isLinkSnippetError(e)) throw e;
            console.log(`[vk] закупка ${order.id}: ВК не собрал карточку ссылки, публикую без вложения`);
            return callVk('wall.post', params);
        }
    }

    async function postOne(row) {
        const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [row.order_id]);
        const skip = skipReason(orderRow);
        if (skip) {
            await pool.query("UPDATE vk_posts SET status = 'skipped', last_error = $1 WHERE id = $2", [skip, row.id]);
            console.log(`[vk] закупка ${row.order_id} не публикуется: ${skip}`);
            return;
        }
        try {
            const response = await postWithLinkFallback(orderRow);
            await pool.query(
                "UPDATE vk_posts SET status = 'sent', vk_post_id = $1, posted_at = NOW(), last_error = NULL WHERE id = $2",
                [response && response.post_id ? response.post_id : null, row.id]
            );
            console.log(`[vk] закупка ${row.order_id} опубликована, пост ${response && response.post_id}`);
        } catch (e) {
            const attempts = row.attempts + 1;
            const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
            await pool.query(
                'UPDATE vk_posts SET status = $1, attempts = $2, last_error = $3 WHERE id = $4',
                [status, attempts, String(e.message).slice(0, 300), row.id]
            );
            console.error(`[vk] закупка ${row.order_id}: ${e.message} (попытка ${attempts}/${MAX_ATTEMPTS})`);
        }
    }

    async function tick() {
        if (!isEnabled()) return 0;
        /* SKIP LOCKED — чтобы два процесса не забрали одну запись */
        const { rows } = await pool.query(
            `SELECT id, order_id, attempts FROM vk_posts
              WHERE status = 'pending' AND attempts < $1
              ORDER BY created_at
              LIMIT $2
              FOR UPDATE SKIP LOCKED`,
            [MAX_ATTEMPTS, BATCH]
        );
        for (const row of rows) await postOne(row);
        return rows.length;
    }

    function start() {
        if (process.env.VK_AUTOPOST_ENABLED === '0') {
            console.log('[vk] автопостинг выключен (VK_AUTOPOST_ENABLED=0)');
            return null;
        }
        if (!process.env.VK_ACCESS_TOKEN || !process.env.VK_GROUP_ID) {
            console.log('[vk] VK_ACCESS_TOKEN или VK_GROUP_ID не заданы — автопостинг не запущен');
            return null;
        }
        const timer = setInterval(() => {
            tick().catch(e => console.error('[vk] цикл публикации:', e.message));
        }, TICK_MS);
        timer.unref?.();
        console.log(`[vk] автопостинг включён, интервал ${Math.round(TICK_MS / 1000)}с`);
        return timer;
    }

    return { enqueue, tick, start, buildMessage, isEnabled, isTestCompany, skipReason };
}

module.exports = { createVkPoster };
