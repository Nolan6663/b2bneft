'use strict';

// Управление справочниками услуг и изделий — ТЗ §13.1.
//
// Справочник ведёт редактор, а не разработчик: до сих пор категории лежали
// в seo/categories-data.js и менялись деплоем, из-за чего добавление кластера
// требовало релиза. Здесь те же данные становятся строками таблиц, которые
// правятся из админки.
//
// Три решения, о которых стоит знать, прежде чем менять этот файл:
//
// 1. Вид справочника (`services` или `products`) приходит из URL, но в SQL
//    подставляется только через белый список KINDS. Имя таблицы — единственное,
//    что нельзя передать параметром запроса, поэтому проверка строгая: любое
//    другое значение отвергается до похода в базу.
//
// 2. Удаление узла, у которого есть потомки или связи, запрещено. Вместо него
//    предлагается объединение: ТЗ §13.1 требует «объединение сущностей с
//    сохранением связей и редиректов», и это не то же самое, что удалить и
//    завести заново — при удалении теряются накопленные связи с компаниями и
//    рвутся адреса, которые уже могли попасть в индекс.
//
// 3. Объединение переносит связи, переподчиняет потомков и оставляет посадочную
//    страницу исходной сущности жить со статусом `merged` и адресом редиректа.
//    Страница не удаляется намеренно: по её адресу мог идти трафик, и 301 на
//    новую — единственный способ его не потерять (ТЗ §4.3, §10.5).

const express = require('express');
const { toSlug, uniqueSlug, isValidSlug } = require('../lib/slug');

/** Белый список: вид справочника → таблица и колонка связи с компанией. */
const KINDS = {
    services: {
        table: 'services',
        linkTable: 'company_services',
        linkColumn: 'service_id',
        landingColumn: 'service_id',
        pairTable: 'service_products',
        pairSelf: 'service_id',
        pairOther: 'product_id',
        title: 'услуга',
    },
    products: {
        table: 'products',
        linkTable: 'company_products',
        linkColumn: 'product_id',
        landingColumn: 'product_id',
        pairTable: 'service_products',
        pairSelf: 'product_id',
        pairOther: 'service_id',
        title: 'изделие',
    },
};

const STATUSES = ['draft', 'published', 'archived'];
const NAME_MAX = 200;
const SYNONYM_MAX = 40;

/** Синонимы из тела запроса: массив непустых строк без повторов.
 *  Ограничение по количеству нужно, чтобы редактор случайной вставкой не
 *  превратил список в текст: каждый синоним — отдельный вариант разбора в
 *  lib/catalog-match, и сотня мусорных строк замедлит сопоставление и
 *  нахватает ложных связей.
 *  Возвращает null, если поле вообще не передано, — так правка одного лишь
 *  названия не стирает уже заведённые синонимы. */
function parseSynonyms(value) {
    if (!Array.isArray(value)) return null;
    const out = [];
    for (const raw of value) {
        const s = String(raw == null ? '' : raw).trim().slice(0, NAME_MAX);
        if (s && !out.includes(s)) out.push(s);
    }
    if (out.length > SYNONYM_MAX) {
        throw Object.assign(new Error(`Синонимов не больше ${SYNONYM_MAX}`), { status: 400 });
    }
    return out;
}

function createCatalogAdminRouter(deps) {
    const { pool, requireAuth, requireRole, withTransaction } = deps;
    const router = express.Router();
    const admin = [requireAuth, requireRole('admin')];

    /** Разбор вида справочника из URL. Возвращает null, если вид неизвестен. */
    function kindOf(req) {
        return Object.prototype.hasOwnProperty.call(KINDS, req.params.kind)
            ? KINDS[req.params.kind] : null;
    }

    function badKind(res) {
        return res.status(404).json({ error: 'Неизвестный справочник: ожидается services или products' });
    }

    function parseId(value) {
        const n = Number(value);
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    /** Slug из тела запроса либо сгенерированный из названия. Проверка занятости
     *  идёт по той же таблице, поэтому уникальность гарантируется до вставки —
     *  а не ловится потом по ошибке UNIQUE. */
    async function resolveSlug(kind, body, name, excludeId = null) {
        const requested = String(body.slug || '').trim();
        if (requested && !isValidSlug(requested)) {
            throw Object.assign(new Error('Slug: только латиница, цифры и дефисы'), { status: 400 });
        }
        const isTaken = async (s) => {
            const { rows } = await pool.query(
                `SELECT 1 FROM ${kind.table} WHERE slug = $1 AND ($2::int IS NULL OR id <> $2) LIMIT 1`,
                [s, excludeId]
            );
            return rows.length > 0;
        };
        if (requested) {
            if (await isTaken(requested)) {
                throw Object.assign(new Error(`Slug «${requested}» уже занят`), { status: 409 });
            }
            return requested;
        }
        return uniqueSlug(toSlug(name), isTaken);
    }

    // ─────────────────── Список ───────────────────
    // Отдаём вместе со счётчиками: редактору нужно видеть, что за узлом стоит,
    // прежде чем его трогать. Без этого удаление превращается в рулетку.
    router.get('/:kind', ...admin, async (req, res, next) => {
        const kind = kindOf(req);
        if (!kind) return badKind(res);
        try {
            const { rows } = await pool.query(`
                SELECT e.id, e.slug, e.name, e.parent_id, e.description, e.status, e.synonyms,
                       e.created_at, e.updated_at,
                       (SELECT COUNT(*)::int FROM ${kind.table} c WHERE c.parent_id = e.id) AS children,
                       (SELECT COUNT(*)::int FROM ${kind.linkTable} l WHERE l.${kind.linkColumn} = e.id) AS companies,
                       (SELECT COUNT(*)::int FROM ${kind.pairTable} p WHERE p.${kind.pairSelf} = e.id) AS linked,
                       (SELECT COUNT(*)::int FROM landing_pages lp WHERE lp.${kind.landingColumn} = e.id) AS landings
                  FROM ${kind.table} e
                 ORDER BY e.parent_id NULLS FIRST, e.name
            `);
            res.json(rows.map(r => ({
                id: r.id, slug: r.slug, name: r.name, parentId: r.parent_id,
                description: r.description, status: r.status, synonyms: r.synonyms || [],
                children: r.children, companies: r.companies,
                linked: r.linked, landings: r.landings,
                createdAt: r.created_at, updatedAt: r.updated_at,
            })));
        } catch (e) { next(e); }
    });

    // ─────────────────── Создание ───────────────────
    router.post('/:kind', ...admin, async (req, res, next) => {
        const kind = kindOf(req);
        if (!kind) return badKind(res);
        try {
            const name = String(req.body?.name || '').trim().slice(0, NAME_MAX);
            if (!name) return res.status(400).json({ error: 'Название обязательно' });

            const parentId = req.body?.parentId == null ? null : parseId(req.body.parentId);
            if (req.body?.parentId != null && parentId === null) {
                return res.status(400).json({ error: 'Некорректный родитель' });
            }
            if (parentId !== null) {
                const { rows } = await pool.query(`SELECT 1 FROM ${kind.table} WHERE id = $1`, [parentId]);
                if (!rows.length) return res.status(400).json({ error: 'Родитель не найден' });
            }

            const status = STATUSES.includes(req.body?.status) ? req.body.status : 'draft';
            const slug = await resolveSlug(kind, req.body || {}, name);

            const synonyms = parseSynonyms(req.body?.synonyms) || [];
            const { rows: [row] } = await pool.query(
                `INSERT INTO ${kind.table} (slug, name, parent_id, description, status, synonyms)
                 VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING id, slug, name, parent_id, status, synonyms`,
                [slug, name, parentId, String(req.body?.description || '').trim(), status, JSON.stringify(synonyms)]
            );
            res.status(201).json({ id: row.id, slug: row.slug, name: row.name, parentId: row.parent_id, status: row.status, synonyms: row.synonyms || [] });
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    // ─────────────────── Правка ───────────────────
    router.patch('/:kind/:id', ...admin, async (req, res, next) => {
        const kind = kindOf(req);
        if (!kind) return badKind(res);
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный идентификатор' });
        try {
            const { rows: [current] } = await pool.query(`SELECT * FROM ${kind.table} WHERE id = $1`, [id]);
            if (!current) return res.status(404).json({ error: `Не найдено: ${kind.title}` });

            const name = req.body?.name === undefined
                ? current.name
                : String(req.body.name || '').trim().slice(0, NAME_MAX);
            if (!name) return res.status(400).json({ error: 'Название обязательно' });

            let parentId = current.parent_id;
            if (req.body?.parentId !== undefined) {
                parentId = req.body.parentId == null ? null : parseId(req.body.parentId);
                if (req.body.parentId != null && parentId === null) {
                    return res.status(400).json({ error: 'Некорректный родитель' });
                }
                if (parentId === id) {
                    return res.status(400).json({ error: 'Узел не может быть родителем самому себе' });
                }
                // Цикл в иерархии вешает обход дерева намертво, поэтому проверяем
                // не только прямое самоподчинение, но и всю цепочку вверх.
                if (parentId !== null && await createsCycle(kind, id, parentId)) {
                    return res.status(400).json({ error: 'Такой родитель создаёт петлю в иерархии' });
                }
            }

            const status = req.body?.status === undefined
                ? current.status
                : (STATUSES.includes(req.body.status) ? req.body.status : current.status);

            const slug = req.body?.slug === undefined && name === current.name
                ? current.slug
                : await resolveSlug(kind, req.body || {}, name, id);

            const description = req.body?.description === undefined
                ? current.description
                : String(req.body.description || '').trim();

            // COALESCE: поле, которого не было в запросе, остаётся прежним.
            // Иначе правка одного названия молча стирала бы синонимы.
            const synonyms = req.body?.synonyms === undefined ? null : parseSynonyms(req.body.synonyms);
            const { rows: [row] } = await pool.query(
                `UPDATE ${kind.table}
                    SET name = $1, slug = $2, parent_id = $3, description = $4,
                        status = $5, synonyms = COALESCE($6::jsonb, synonyms), updated_at = NOW()
                  WHERE id = $7
              RETURNING id, slug, name, parent_id, status, synonyms`,
                [name, slug, parentId, description, status, synonyms ? JSON.stringify(synonyms) : null, id]
            );
            res.json({
                id: row.id, slug: row.slug, name: row.name,
                parentId: row.parent_id, status: row.status, synonyms: row.synonyms || [],
            });
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    /** Не окажется ли `candidate` потомком `id` — иначе получим замкнутое дерево. */
    async function createsCycle(kind, id, candidate) {
        let cursor = candidate;
        for (let depth = 0; depth < 50 && cursor !== null; depth++) {
            if (cursor === id) return true;
            const { rows: [row] } = await pool.query(
                `SELECT parent_id FROM ${kind.table} WHERE id = $1`, [cursor]
            );
            if (!row) return false;
            cursor = row.parent_id;
        }
        return false;
    }

    // ─────────────────── Удаление ───────────────────
    // Отказ с объяснением лучше молчаливого каскада: за узлом могут стоять
    // сотни связей с компаниями, собранных импортом и модерацией.
    router.delete('/:kind/:id', ...admin, async (req, res, next) => {
        const kind = kindOf(req);
        if (!kind) return badKind(res);
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный идентификатор' });
        try {
            const { rows: [row] } = await pool.query(`
                SELECT e.name,
                       (SELECT COUNT(*)::int FROM ${kind.table} c WHERE c.parent_id = e.id) AS children,
                       (SELECT COUNT(*)::int FROM ${kind.linkTable} l WHERE l.${kind.linkColumn} = e.id) AS companies,
                       (SELECT COUNT(*)::int FROM landing_pages lp WHERE lp.${kind.landingColumn} = e.id) AS landings
                  FROM ${kind.table} e WHERE e.id = $1
            `, [id]);
            if (!row) return res.status(404).json({ error: `Не найдено: ${kind.title}` });

            const blockers = [];
            if (row.children) blockers.push(`дочерних записей: ${row.children}`);
            if (row.companies) blockers.push(`связей с компаниями: ${row.companies}`);
            if (row.landings) blockers.push(`посадочных страниц: ${row.landings}`);
            if (blockers.length) {
                return res.status(409).json({
                    error: `Нельзя удалить «${row.name}» — ${blockers.join(', ')}. Объедините с другой записью.`,
                    blockers,
                });
            }

            await pool.query(`DELETE FROM ${kind.table} WHERE id = $1`, [id]);
            res.json({ deleted: true });
        } catch (e) { next(e); }
    });

    // ─────────────────── Объединение ───────────────────
    router.post('/:kind/:id/merge', ...admin, async (req, res, next) => {
        const kind = kindOf(req);
        if (!kind) return badKind(res);
        const id = parseId(req.params.id);
        const targetId = parseId(req.body?.targetId);
        if (!id || !targetId) return res.status(400).json({ error: 'Нужны идентификаторы источника и цели' });
        if (id === targetId) return res.status(400).json({ error: 'Нельзя объединить запись саму с собой' });

        try {
            const result = await withTransaction(async (client) => {
                const { rows: both } = await client.query(
                    `SELECT id, name, slug FROM ${kind.table} WHERE id = ANY($1)`, [[id, targetId]]
                );
                if (both.length !== 2) {
                    throw Object.assign(new Error('Одна из записей не найдена'), { status: 404 });
                }
                if (await cycleInTx(client, kind, id, targetId)) {
                    throw Object.assign(new Error('Цель является потомком источника'), { status: 400 });
                }

                // Связи с компаниями. ON CONFLICT DO NOTHING: если компания уже
                // связана с целью, её собственная связь сильнее перенесённой —
                // там могло стоять подтверждение модератора.
                await client.query(
                    `INSERT INTO ${kind.linkTable} (company_id, ${kind.linkColumn}, confirmation, limits)
                     SELECT company_id, $2, confirmation, limits FROM ${kind.linkTable} WHERE ${kind.linkColumn} = $1
                     ON CONFLICT DO NOTHING`, [id, targetId]
                );
                await client.query(`DELETE FROM ${kind.linkTable} WHERE ${kind.linkColumn} = $1`, [id]);

                // Связи «услуга ↔ изделие».
                await client.query(
                    `INSERT INTO ${kind.pairTable} (${kind.pairSelf}, ${kind.pairOther})
                     SELECT $2, ${kind.pairOther} FROM ${kind.pairTable} WHERE ${kind.pairSelf} = $1
                     ON CONFLICT DO NOTHING`, [id, targetId]
                );
                await client.query(`DELETE FROM ${kind.pairTable} WHERE ${kind.pairSelf} = $1`, [id]);

                // Потомки переходят к цели, иначе осиротеют при удалении.
                await client.query(
                    `UPDATE ${kind.table} SET parent_id = $2, updated_at = NOW() WHERE parent_id = $1`,
                    [id, targetId]
                );

                // Посадочные источника остаются как 301 на страницу цели.
                const { rows: [targetLanding] } = await client.query(
                    `SELECT url FROM landing_pages
                      WHERE ${kind.landingColumn} = $1 AND status = 'published_index'
                      ORDER BY id LIMIT 1`, [targetId]
                );
                const { rowCount: redirected } = await client.query(
                    `UPDATE landing_pages
                        SET status = 'merged', redirect_to = $2, ${kind.landingColumn} = $3, updated_at = NOW()
                      WHERE ${kind.landingColumn} = $1 AND status <> 'merged'`,
                    [id, targetLanding ? targetLanding.url : '', targetId]
                );

                await client.query(`DELETE FROM ${kind.table} WHERE id = $1`, [id]);

                const source = both.find(r => r.id === id);
                const target = both.find(r => r.id === targetId);
                return { merged: source.name, into: target.name, redirectedLandings: redirected };
            });
            res.json(result);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    async function cycleInTx(client, kind, id, candidate) {
        let cursor = candidate;
        for (let depth = 0; depth < 50 && cursor !== null; depth++) {
            if (cursor === id) return true;
            const { rows: [row] } = await client.query(
                `SELECT parent_id FROM ${kind.table} WHERE id = $1`, [cursor]
            );
            if (!row) return false;
            cursor = row.parent_id;
        }
        return false;
    }

    // ─────────────────── Связь услуга ↔ изделие ───────────────────
    // Именно она держит блоки «какие изделия изготавливаются этой технологией»
    // и «подходящие услуги» на страницах кластера (ТЗ §6.2, §6.3).
    router.post('/services/:id/products', ...admin, async (req, res, next) => {
        const serviceId = parseId(req.params.id);
        const productId = parseId(req.body?.productId);
        if (!serviceId || !productId) return res.status(400).json({ error: 'Нужны идентификаторы услуги и изделия' });
        try {
            const { rows } = await pool.query(
                `SELECT (SELECT COUNT(*)::int FROM services WHERE id = $1) AS s,
                        (SELECT COUNT(*)::int FROM products WHERE id = $2) AS p`,
                [serviceId, productId]
            );
            if (!rows[0].s) return res.status(404).json({ error: 'Услуга не найдена' });
            if (!rows[0].p) return res.status(404).json({ error: 'Изделие не найдено' });

            await pool.query(
                `INSERT INTO service_products (service_id, product_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`, [serviceId, productId]
            );
            res.status(201).json({ linked: true });
        } catch (e) { next(e); }
    });

    router.delete('/services/:id/products/:productId', ...admin, async (req, res, next) => {
        const serviceId = parseId(req.params.id);
        const productId = parseId(req.params.productId);
        if (!serviceId || !productId) return res.status(400).json({ error: 'Некорректные идентификаторы' });
        try {
            const { rowCount } = await pool.query(
                'DELETE FROM service_products WHERE service_id = $1 AND product_id = $2',
                [serviceId, productId]
            );
            res.json({ unlinked: rowCount > 0 });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = { createCatalogAdminRouter, KINDS, STATUSES };
