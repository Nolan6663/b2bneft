'use strict';

// Публичные страницы эталонного кластера: /uslugi/{slug} и /izdeliya/{slug}.
//
// Главное отличие от прежних SEO-страниц (регионы, операции): здесь не код
// решает, звать ли робота, а статус строки в landing_pages. Сущность может
// существовать в справочнике, иметь публичный адрес и при этом не попадать в
// индекс — это три разных состояния, и ответ на вопрос 13 маркетинга требует
// именно такого разделения.
//
// Связанные сущности подбираются в выдачу только если у них самих есть
// индексируемая посадочная: ссылка в noindex-контур разгоняет обход мусора,
// а ссылка в никуда — обычная битая ссылка. Это первое из ограничений
// перелинковки, которые мы описали в ответе на вопрос 3.

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
    responseFor, buildTitle, buildDescription, buildH1, buildBreadcrumb,
    buildBody, buildJsonLd, esc, plural, KINDS,
} = require('../lib/cluster-seo');
const { INDEXABLE_STATUS } = require('../lib/catalog-schema');

/* Сколько исполнителей показываем на странице. Больше двадцати — это уже
   каталог, и ему место в отдельном разделе, а не в подвале страницы услуги. */
const COMPANY_LIMIT = 20;
const ORDER_LIMIT = 6;

const KIND_BY_ROOT = { uslugi: 'service', izdeliya: 'product' };

function createClusterRouter(deps) {
    const { pool, htmlEscape, APP_URL } = deps;
    const router = express.Router();
    const template = () => fs.readFileSync(path.join(__dirname, '..', 'zakupki', 'cluster.html'), 'utf8');

    /* Сущность + её посадочная одним запросом: страница без записи в реестре
       публичного адреса не имеет, и знать об этом надо до сборки контента. */
    async function loadEntity(kind, slug) {
        const table = kind === 'service' ? 'services' : 'products';
        const column = kind === 'service' ? 'service_id' : 'product_id';
        const { rows: [row] } = await pool.query(`
            SELECT e.id, e.slug, e.name, e.description,
                   lp.status, lp.title, lp.description AS lp_description,
                   lp.h1, lp.intro, lp.redirect_to
              FROM ${table} e
              LEFT JOIN landing_pages lp ON lp.${column} = e.id
             WHERE e.slug = $1
             ORDER BY lp.id
             LIMIT 1
        `, [slug]);
        return row || null;
    }

    /** Исполнители, заявившие эту услугу или изделие. Реестровые догадки
     *  (confirmation = 'registry') показываем — это единственное наполнение на
     *  старте, — но отмечаем происхождение в карточке, как требует ТЗ §11.2. */
    async function loadCompanies(kind, entityId) {
        const linkTable = kind === 'service' ? 'company_services' : 'company_products';
        const column = kind === 'service' ? 'service_id' : 'product_id';
        const { rows } = await pool.query(`
            SELECT c.id, c.company, c.city, c.specialization, c.products,
                   c.verified_by_platform, c.claimed
              FROM ${linkTable} l
              JOIN companies c ON c.id = l.company_id
             WHERE l.${column} = $1 AND c.status <> 'Отклонено'
             ORDER BY c.verified_by_platform DESC, c.claimed DESC, c.company
             LIMIT ${COMPANY_LIMIT}
        `, [entityId]);
        return rows.map(r => ({
            id: r.id, company: r.company, city: r.city,
            specialization: r.specialization, products: r.products,
            verifiedByPlatform: r.verified_by_platform, claimed: r.claimed,
        }));
    }

    /** Связанные сущности другого вида — и только те, у которых есть
     *  индексируемая страница. Фильтр в SQL, чтобы не полагаться на память
     *  следующего, кто станет править эту выборку. */
    async function loadRelated(kind, entityId) {
        const { rows } = kind === 'service'
            ? await pool.query(`
                SELECT p.slug, p.name FROM service_products sp
                  JOIN products p ON p.id = sp.product_id
                  JOIN landing_pages lp ON lp.product_id = p.id AND lp.status = $2
                 WHERE sp.service_id = $1
                 ORDER BY p.name`, [entityId, INDEXABLE_STATUS])
            : await pool.query(`
                SELECT s.slug, s.name FROM service_products sp
                  JOIN services s ON s.id = sp.service_id
                  JOIN landing_pages lp ON lp.service_id = s.id AND lp.status = $2
                 WHERE sp.product_id = $1
                 ORDER BY s.name`, [entityId, INDEXABLE_STATUS]);
        return rows;
    }

    /** Открытые закупки по названию сущности. Подбор грубый — по вхождению в
     *  заголовок и категорию: связи «заказ ↔ справочник» пока нет, она появится
     *  вместе с формой размещения из ТЗ §6.8. */
    async function loadOrders(name) {
        const { rows } = await pool.query(`
            SELECT id, title, deadline FROM orders
             WHERE status = 'Активный'
               AND (title ILIKE $1 OR category ILIKE $1)
             ORDER BY created_at DESC
             LIMIT ${ORDER_LIMIT}
        `, [`%${name}%`]);
        return rows;
    }

    for (const [root, kind] of Object.entries(KIND_BY_ROOT)) {
        router.get(`/${root}/:slug`, async (req, res, next) => {
            try {
                const row = await loadEntity(kind, String(req.params.slug || ''));
                if (!row) {
                    res.status(404);
                    return res.sendFile(path.join(__dirname, '..', '404.html'));
                }

                const landing = row.status ? {
                    status: row.status, title: row.title, description: row.lp_description,
                    h1: row.h1, intro: row.intro, redirect_to: row.redirect_to,
                } : null;

                const verdict = responseFor(landing);
                if (verdict.status === 301) return res.redirect(301, verdict.location);
                if (verdict.status === 410) {
                    // 410 говорит роботу «страницы больше не будет» — в отличие
                    // от 404, после которого он продолжит заходить месяцами.
                    res.status(410);
                    return res.type('html').send('<!doctype html><meta charset="utf-8">'
                        + '<title>Страница удалена — ТехЗаказ</title>'
                        + '<p>Эта страница удалена. <a href="/zakupki">Перейти к закупкам</a>.</p>');
                }
                if (verdict.status !== 200) {
                    res.status(verdict.status);
                    return res.sendFile(path.join(__dirname, '..', '404.html'));
                }

                const entity = { id: row.id, slug: row.slug, name: row.name, description: row.description };
                const [companies, entities, orders] = await Promise.all([
                    loadCompanies(kind, row.id),
                    loadRelated(kind, row.id),
                    loadOrders(row.name),
                ]);

                const page = {
                    kind, entity, landing,
                    related: { companies, entities, orders },
                    counts: { companies: companies.length, orders: orders.length },
                };

                const base = String(APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
                const canonical = `${base}${KINDS[kind].root}/${entity.slug}`;
                const n = companies.length;
                const stats = n
                    ? `<div class="zr-stat"><b>${n}</b><span>${plural(n, 'исполнитель', 'исполнителя', 'исполнителей')} в каталоге</span></div>`
                    : '';

                const lead = landing && landing.intro
                    ? landing.intro
                    : `Разместите чертёж или техническое задание — предложения придут напрямую от производств, без посредников и тендерных процедур.`;

                const html = template()
                    .replace(/<!--META_TITLE-->/g, htmlEscape(buildTitle(page)))
                    .replace(/<!--META_DESC-->/g, htmlEscape(buildDescription(page)))
                    .replace(/<!--META_ROBOTS-->/g, verdict.robots)
                    .replace(/<!--CANONICAL_URL-->/g, canonical)
                    .replace(/<!--JSON_LD-->/g, buildJsonLd(page, base))
                    .replace(/<!--BREADCRUMB-->/g, buildBreadcrumb(page))
                    .replace(/<!--PAGE_H1-->/g, esc(buildH1(page)))
                    .replace(/<!--PAGE_LEAD-->/g, esc(lead))
                    .replace(/<!--PAGE_STATS-->/g, stats)
                    .replace(/<!--PAGE_BODY-->/g, buildBody(page));

                // Неиндексируемую страницу не кэшируем надолго: она в этом
                // состоянии временно, и редактор должен увидеть правку сразу.
                res.setHeader('Cache-Control', verdict.robots.startsWith('index')
                    ? 'public, max-age=3600' : 'private, max-age=0, must-revalidate');
                res.type('html').send(html);
            } catch (e) { next(e); }
        });
    }

    return router;
}

module.exports = { createClusterRouter, COMPANY_LIMIT, ORDER_LIMIT };
