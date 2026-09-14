'use strict';

// Кейсы исполнителей: создание, отправка на модерацию, разбор модератором.
// ТЗ §9.
//
// Разделение ролей здесь важнее самих ручек. Исполнитель владеет своим кейсом
// и может делать с ним всё, кроме публикации; публикует модератор. Между этими
// двумя состояниями стоит журнал: автор обязан видеть, что произошло и почему
// кейс вернулся (ТЗ §9.4) — иначе первый же отказ без объяснения означает, что
// исполнитель больше ничего не пришлёт.

const express = require('express');
const {
    validateForReview, adWarnings, canTransition, publicView,
    buildSlug, sanitize, STATUSES,
} = require('../lib/cases');

function createCasesRouter(deps) {
    const { pool, requireAuth, requireRole, withTransaction, addNotification } = deps;
    const router = express.Router();

    function parseId(v) {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    /** Кейс вместе со связями и названиями — то, что нужно и автору, и
     *  модератору, и публичной странице. */
    async function loadCase(id) {
        const { rows: [c] } = await pool.query(`
            SELECT c.*, comp.company AS company_name, p.name AS product_name
              FROM cases c
              JOIN companies comp ON comp.id = c.company_id
              LEFT JOIN products p ON p.id = c.product_id
             WHERE c.id = $1
        `, [id]);
        if (!c) return null;
        const { rows: services } = await pool.query(
            `SELECT s.id, s.name, s.slug FROM case_services cs
               JOIN services s ON s.id = cs.service_id WHERE cs.case_id = $1 ORDER BY s.name`,
            [id]
        );
        return { ...c, services };
    }

    /** Владелец кейса — компания автора, а не пользователь: в компании может
     *  быть несколько человек, и кейс принадлежит предприятию. */
    async function ownsCase(user, c) {
        if (!c) return false;
        if (user.role === 'admin') return true;
        const { rows: [own] } = await pool.query(
            'SELECT 1 FROM companies WHERE id = $1 AND company = $2', [c.company_id, user.company]
        );
        return !!own;
    }

    async function logEvent(client, caseId, event, actor, note) {
        await client.query(
            'INSERT INTO case_events (case_id, event, actor, note) VALUES ($1,$2,$3,$4)',
            [caseId, event, String(actor || '').slice(0, 200), String(note || '').slice(0, 500)]
        );
    }

    // ─────────────────── Исполнитель ───────────────────

    /** Свои кейсы: список со статусами и причиной возврата. */
    router.get('/mine', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT c.id, c.slug, c.title, c.status, c.moderation_note, c.views,
                       c.created_at, c.updated_at, c.published_at, p.name AS product_name
                  FROM cases c
                  JOIN companies comp ON comp.id = c.company_id
                  LEFT JOIN products p ON p.id = c.product_id
                 WHERE comp.company = $1
                 ORDER BY c.updated_at DESC
            `, [req.user.company]);
            res.json(rows.map(r => ({
                id: r.id, slug: r.slug, title: r.title, status: r.status,
                moderationNote: r.moderation_note, views: r.views,
                product: r.product_name, createdAt: r.created_at,
                updatedAt: r.updated_at, publishedAt: r.published_at,
            })));
        } catch (e) { next(e); }
    });

    router.post('/', requireAuth, requireRole('producer'), async (req, res, next) => {
        try {
            const { rows: [company] } = await pool.query(
                "SELECT id FROM companies WHERE company = $1 AND role = 'producer'", [req.user.company]
            );
            if (!company) return res.status(400).json({ error: 'Профиль предприятия не найден' });

            const data = sanitize(req.body || {});
            if (!data.title) return res.status(400).json({ error: 'Название обязательно' });

            const result = await withTransaction(async (client) => {
                /* Slug закрепляется при создании и дальше не меняется: один кейс —
                   один адрес (ТЗ §3.6), а смена адреса опубликованного кейса рвёт
                   ссылки на него. Номер предприятия в конце различает одинаковые
                   заголовки у разных заводов. */
                let slug = buildSlug(data.title, company.id);
                const { rows: taken } = await client.query('SELECT 1 FROM cases WHERE slug = $1', [slug]);
                if (taken.length) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

                const { rows: [row] } = await client.query(`
                    INSERT INTO cases (slug, company_id, title, product_id, material, equipment,
                                       quantity, dimensions, weight, tolerance, roughness,
                                       task, complexity, solution, result, customer_named, customer_name)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                    RETURNING id, slug, status`,
                    [slug, company.id, data.title, data.productId, data.material, data.equipment,
                     data.quantity, data.dimensions, data.weight, data.tolerance, data.roughness,
                     data.task, data.complexity, data.solution, data.result, data.customerNamed, data.customerName]
                );
                for (const sid of data.serviceIds) {
                    await client.query(
                        'INSERT INTO case_services (case_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
                        [row.id, sid]
                    );
                }
                await logEvent(client, row.id, 'created', req.user.company, '');
                return row;
            });

            res.status(201).json({ id: result.id, slug: result.slug, status: result.status });
        } catch (e) { next(e); }
    });

    router.patch('/:id', requireAuth, async (req, res, next) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный идентификатор' });
        try {
            const c = await loadCase(id);
            if (!c) return res.status(404).json({ error: 'Кейс не найден' });
            if (!await ownsCase(req.user, c)) return res.status(403).json({ error: 'Это чужой кейс' });
            // Опубликованный кейс правится только через возврат на модерацию:
            // иначе проверенный текст можно подменить после публикации.
            if (c.status === 'published' && req.user.role !== 'admin') {
                return res.status(409).json({ error: 'Опубликованный кейс правится после снятия с публикации' });
            }

            const data = sanitize({ ...c, ...req.body, customerNamed: req.body?.customerNamed ?? c.customer_named });
            await withTransaction(async (client) => {
                await client.query(`
                    UPDATE cases SET title=$1, product_id=$2, material=$3, equipment=$4, quantity=$5,
                           dimensions=$6, weight=$7, tolerance=$8, roughness=$9, task=$10,
                           complexity=$11, solution=$12, result=$13, customer_named=$14,
                           customer_name=$15, updated_at=NOW()
                     WHERE id=$16`,
                    [data.title, data.productId, data.material, data.equipment, data.quantity,
                     data.dimensions, data.weight, data.tolerance, data.roughness, data.task,
                     data.complexity, data.solution, data.result, data.customerNamed, data.customerName, id]
                );
                if (Array.isArray(req.body?.serviceIds)) {
                    await client.query('DELETE FROM case_services WHERE case_id = $1', [id]);
                    for (const sid of data.serviceIds) {
                        await client.query(
                            'INSERT INTO case_services (case_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
                            [id, sid]
                        );
                    }
                }
                await logEvent(client, id, 'edited', req.user.company, '');
            });
            res.json({ id, updated: true, warnings: adWarnings(data) });
        } catch (e) { next(e); }
    });

    /** Проверка перед отправкой: что именно мешает уйти на модерацию. */
    router.get('/:id/readiness', requireAuth, async (req, res, next) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный идентификатор' });
        try {
            const c = await loadCase(id);
            if (!c) return res.status(404).json({ error: 'Кейс не найден' });
            if (!await ownsCase(req.user, c)) return res.status(403).json({ error: 'Это чужой кейс' });
            const problems = validateForReview({ ...c, services: c.services });
            res.json({ ready: problems.length === 0, problems, warnings: adWarnings(c) });
        } catch (e) { next(e); }
    });

    // ─────────────────── Смена статуса ───────────────────

    router.patch('/:id/status', requireAuth, async (req, res, next) => {
        const id = parseId(req.params.id);
        const to = String(req.body?.status || '');
        if (!id) return res.status(400).json({ error: 'Некорректный идентификатор' });
        if (!STATUSES.includes(to)) return res.status(400).json({ error: 'Неизвестный статус' });
        try {
            const c = await loadCase(id);
            if (!c) return res.status(404).json({ error: 'Кейс не найден' });
            const isOwner = await ownsCase(req.user, c);
            if (!isOwner && req.user.role !== 'admin') return res.status(403).json({ error: 'Это чужой кейс' });

            const role = req.user.role === 'admin' ? 'admin' : 'owner';
            const move = canTransition(c.status, to, role);
            if (!move.allowed) return res.status(409).json({ error: move.why });

            // На модерацию уходит только заполненный кейс: заголовок без задачи
            // и решения — не подтверждение компетенции, а заявка на неё.
            if (to === 'review') {
                const problems = validateForReview({ ...c, services: c.services });
                if (problems.length) {
                    return res.status(409).json({ error: 'Кейс не готов к отправке', problems });
                }
            }
            // Причина возврата обязательна: «отклонён» без объяснения означает,
            // что исполнитель больше ничего не пришлёт (ТЗ §9.4).
            const note = String(req.body?.note || '').trim();
            if (to === 'changes_requested' && !note) {
                return res.status(400).json({ error: 'Укажите, что именно нужно исправить' });
            }

            await withTransaction(async (client) => {
                await client.query(`
                    UPDATE cases
                       SET status = $1,
                           moderation_note = CASE WHEN $1 = 'changes_requested' THEN $2 ELSE '' END,
                           published_at = CASE WHEN $1 = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
                           updated_at = NOW()
                     WHERE id = $3`,
                    [to, note, id]
                );
                await logEvent(client, id, to, req.user.company || req.user.email, note);
            });

            /* События ТЗ §12.1. Отправляются с сервера как часть ответа: клиент
               узнаёт из него, что именно произошло, и шлёт цель сам —
               window.ym на сервере не существует. */
            const analytics = to === 'review'
                ? { event: 'case_submit', params: { company_id: c.company_id, entities_count: (c.services || []).length + (c.product_id ? 1 : 0) } }
                : to === 'published'
                    ? {
                        event: 'case_published',
                        params: {
                            case_id: id,
                            // Сколько кейс пролежал на модерации — метрика нашей
                            // работы, а не исполнителя (ТЗ §12.1).
                            moderation_time: Math.max(0, Math.round((Date.now() - new Date(c.updated_at).getTime()) / 3600000)),
                        },
                    }
                    : null;

            if (to === 'changes_requested' || to === 'published') {
                // Уведомление автору: без него смена статуса останется незамеченной.
                try {
                    await addNotification(c.company_name, to === 'published'
                        ? `Кейс «${c.title}» опубликован`
                        : `Кейс «${c.title}» вернулся на доработку: ${note}`);
                } catch (e) { /* уведомление не должно ронять модерацию */ }
            }

            res.json({ id, status: to, analytics });
        } catch (e) { next(e); }
    });

    /** История: что происходило с кейсом. Доступна автору, а не только
     *  модератору — ТЗ §9.4. */
    router.get('/:id/history', requireAuth, async (req, res, next) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный идентификатор' });
        try {
            const c = await loadCase(id);
            if (!c) return res.status(404).json({ error: 'Кейс не найден' });
            if (!await ownsCase(req.user, c)) return res.status(403).json({ error: 'Это чужой кейс' });
            const { rows } = await pool.query(
                'SELECT event, actor, note, created_at FROM case_events WHERE case_id = $1 ORDER BY created_at DESC',
                [id]
            );
            res.json(rows.map(r => ({ event: r.event, actor: r.actor, note: r.note, at: r.created_at })));
        } catch (e) { next(e); }
    });

    // ─────────────────── Модератор ───────────────────

    router.get('/moderation/queue', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT c.id, c.slug, c.title, c.status, c.created_at, c.updated_at,
                       comp.company AS company_name, p.name AS product_name
                  FROM cases c
                  JOIN companies comp ON comp.id = c.company_id
                  LEFT JOIN products p ON p.id = c.product_id
                 WHERE c.status = 'review'
                 ORDER BY c.updated_at
            `);
            res.json(rows.map(r => ({
                id: r.id, slug: r.slug, title: r.title, company: r.company_name,
                product: r.product_name, submittedAt: r.updated_at,
            })));
        } catch (e) { next(e); }
    });

    /** Полный кейс для разбора модератором — вместе с подсказками про рекламные
     *  штампы и возможные дубли по названию у того же предприятия. */
    router.get('/moderation/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный идентификатор' });
        try {
            const c = await loadCase(id);
            if (!c) return res.status(404).json({ error: 'Кейс не найден' });
            const { rows: dupes } = await pool.query(
                `SELECT id, title, status FROM cases
                  WHERE company_id = $1 AND id <> $2 AND lower(title) = lower($3)`,
                [c.company_id, id, c.title]
            );
            res.json({
                ...publicView(c),
                id: c.id,
                status: c.status,
                customerNamed: c.customer_named,
                adWarnings: adWarnings(c),
                duplicates: dupes,
            });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = { createCasesRouter };
