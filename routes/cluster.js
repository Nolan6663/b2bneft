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
const hub = require('../lib/orders-hub');
const contractors = require('../lib/contractors-seo');
const caseSeo = require('../lib/case-seo');
const { REGIONS } = require('../seo/regions-data');
const { isRegionIndexable } = require('../lib/region-seo');

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
                   c.verified_by_platform, c.claimed,
                   -- Всего по теме, а не в выдаче: это число решает, показывать
                   -- ли ссылку на полный каталог подрядчиков.
                   COUNT(*) OVER ()::int AS total
              FROM ${linkTable} l
              JOIN companies c ON c.id = l.company_id
             WHERE l.${column} = $1 AND c.status <> 'Отклонено'
             ORDER BY c.verified_by_platform DESC, c.claimed DESC, c.company
             LIMIT ${COMPANY_LIMIT}
        `, [entityId]);
        const companies = rows.map(r => ({
            id: r.id, company: r.company, city: r.city,
            specialization: r.specialization, products: r.products,
            verifiedByPlatform: r.verified_by_platform, claimed: r.claimed,
        }));
        companies.total = rows.length ? rows[0].total : 0;
        return companies;
    }

    /** Есть ли у темы открытый каталог подрядчиков. Ссылку ставим только на
     *  индексируемую страницу: увести читателя в noindex-контур — значит
     *  потратить на него обход и ничего не получить взамен. */
    async function loadContractorHref(kind, entityId, slug) {
        const column = kind === 'service' ? 'service_id' : 'product_id';
        const { rows } = await pool.query(
            `SELECT 1 FROM landing_pages
              WHERE page_type = 'contractor' AND ${column} = $1 AND status = $2 LIMIT 1`,
            [entityId, INDEXABLE_STATUS]
        );
        return rows.length ? `${contractors.ROOT}/${slug}` : '';
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

    /** Открытые закупки по теме — по связям со справочником, которые
     *  проставляются при создании заявки (lib/order-linking). */
    async function loadOrders(kind, entityId) {
        const linkTable = kind === 'service' ? 'order_services' : 'order_products';
        const column = kind === 'service' ? 'service_id' : 'product_id';
        const { rows } = await pool.query(`
            SELECT o.id, o.title, o.deadline
              FROM ${linkTable} l
              JOIN orders o ON o.id = l.order_id
             WHERE l.${column} = $1 AND o.status = 'Активный'
             ORDER BY o.created_at DESC
             LIMIT ${ORDER_LIMIT}
        `, [entityId]);
        return rows;
    }

    /** Опубликованные кейсы по теме. ТЗ §9.3 требует выводить их на страницах
     *  услуг и изделий: именно там кейс работает — подтверждает, что кто-то
     *  такое уже делал, ровно в момент выбора исполнителя. */
    async function loadCases(kind, entityId) {
        const { rows } = kind === 'service'
            ? await pool.query(`
                SELECT c.slug, c.title, comp.company AS company_name
                  FROM case_services cs
                  JOIN cases c ON c.id = cs.case_id
                  JOIN companies comp ON comp.id = c.company_id
                 WHERE cs.service_id = $1 AND c.status = 'published'
                 ORDER BY c.published_at DESC LIMIT 6`, [entityId])
            : await pool.query(`
                SELECT c.slug, c.title, comp.company AS company_name
                  FROM cases c
                  JOIN companies comp ON comp.id = c.company_id
                 WHERE c.product_id = $1 AND c.status = 'published'
                 ORDER BY c.published_at DESC LIMIT 6`, [entityId]);
        return rows.map(r => ({ slug: r.slug, title: r.title, company: r.company_name }));
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
                const [companies, entities, orders, cases, contractorHref] = await Promise.all([
                    loadCompanies(kind, row.id),
                    loadRelated(kind, row.id),
                    loadOrders(kind, row.id),
                    loadCases(kind, row.id),
                    loadContractorHref(kind, row.id, row.slug),
                ]);

                const page = {
                    kind, entity, landing,
                    related: { companies, entities, orders, cases, contractorHref },
                    counts: {
                        companies: companies.length, orders: orders.length,
                        // Всего исполнителей по теме — может быть больше, чем
                        // помещается на странице услуги.
                        companiesTotal: companies.total || companies.length,
                    },
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
                    .replace(/<!--HEADER_CTA-->/g, 'Разместить закупку')
                    .replace(/<!--META_TITLE-->/g, htmlEscape(buildTitle(page)))
                    .replace(/<!--META_DESC-->/g, htmlEscape(buildDescription(page)))
                    .replace(/<!--META_ROBOTS-->/g, verdict.robots)
                    .replace(/<!--CANONICAL_URL-->/g, canonical)
                    .replace(/<!--JSON_LD-->/g, buildJsonLd(page, base))
                    .replace(/<!--BREADCRUMB-->/g, buildBreadcrumb(page))
                    .replace(/<!--PAGE_H1-->/g, esc(buildH1(page)))
                    .replace(/<!--PAGE_LEAD-->/g, esc(lead))
                    .replace(/<!--PAGE_STATS-->/g, stats)
                    .replace(/<!--PAGE_BODY-->/g, buildBody(page))
                    .replace(/<!--EV_PAGE_TYPE-->/g, kind)
                    .replace(/<!--EV_ENTITY_ID-->/g, String(entity.id))
                    .replace(/<!--EV_INTENT-->/g, 'customer');

                // Неиндексируемую страницу не кэшируем надолго: она в этом
                // состоянии временно, и редактор должен увидеть правку сразу.
                res.setHeader('Cache-Control', verdict.robots.startsWith('index')
                    ? 'public, max-age=3600' : 'private, max-age=0, must-revalidate');
                res.type('html').send(html);
            } catch (e) { next(e); }
        });
    }

    // ─────────────────── Страница кейса ───────────────────
    // ТЗ §3.6: один опубликованный кейс — один канонический адрес. Кейс
    // показывается на страницах услуг и изделий, но живёт по одному URL и под
    // разными категориями не дублируется.
    router.get('/keisy/:slug', async (req, res, next) => {
        try {
            const { rows: [c] } = await pool.query(
                `SELECT c.*, comp.company AS company_name, p.name AS product_name
                   FROM cases c
                   JOIN companies comp ON comp.id = c.company_id
                   LEFT JOIN products p ON p.id = c.product_id
                  WHERE c.slug = $1`,
                [String(req.params.slug || '')]
            );

            /* Неопубликованный кейс для постороннего не существует. 404 здесь
               честнее 403: мы не раскрываем даже факта, что у предприятия есть
               черновик с таким адресом. */
            if (!c || c.status !== 'published') {
                res.status(404);
                return res.sendFile(path.join(__dirname, '..', '404.html'));
            }

            const { rows: services } = await pool.query(
                `SELECT s.name, s.slug FROM case_services cs
                   JOIN services s ON s.id = cs.service_id
                  WHERE cs.case_id = $1 ORDER BY s.name`,
                [c.id]
            );

            /* Счётчик просмотров — обещанная исполнителю отдача от кейса
               (ТЗ §9.3). Пишем без ожидания: страница не должна ждать запись,
               а потеря одного просмотра при сбое ничего не решает. */
            pool.query('UPDATE cases SET views = views + 1 WHERE id = $1', [c.id]).catch(() => {});

            const base = String(APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
            const html = template()
                .replace(/<!--HEADER_CTA-->/g, 'Разместить закупку')
                .replace(/<!--META_TITLE-->/g, htmlEscape(caseSeo.buildTitle(c)))
                .replace(/<!--META_DESC-->/g, htmlEscape(caseSeo.buildDescription(c)))
                .replace(/<!--META_ROBOTS-->/g, 'index, follow')
                .replace(/<!--CANONICAL_URL-->/g, `${base}/keisy/${c.slug}`)
                .replace(/<!--JSON_LD-->/g, caseSeo.buildJsonLd(c, services, base))
                .replace(/<!--BREADCRUMB-->/g, caseSeo.buildBreadcrumb(c))
                .replace(/<!--PAGE_H1-->/g, esc(c.title))
                .replace(/<!--PAGE_LEAD-->/g, esc(caseSeo.buildLead(c)))
                .replace(/<!--PAGE_STATS-->/g, caseSeo.buildStats(c))
                .replace(/<!--PAGE_BODY-->/g, caseSeo.buildBody(c, services))
                .replace(/<!--EV_PAGE_TYPE-->/g, 'case')
                .replace(/<!--EV_ENTITY_ID-->/g, String(c.id))
                .replace(/<!--EV_INTENT-->/g, 'customer');

            res.setHeader('Cache-Control', 'public, max-age=1800');
            res.type('html').send(html);
        } catch (e) { next(e); }
    });

    // ─────────────────── Хаб заказов ───────────────────
    // Единственная страница кластера для исполнителя. Slug может принадлежать
    // и услуге, и изделию: заказы ищут и «на токарную обработку», и «на валы».

    /* Сущность + посадочная нужного типа. Slug один, а страниц по нему
       несколько — /zakazy/valy и /podryadchiki/valy живут в одном реестре и
       различаются page_type, поэтому тип передаётся параметром, а не зашит. */
    async function loadByAnyKind(slug, pageType) {
        const { rows: [row] } = await pool.query(`
            SELECT e.id, e.slug, e.name, e.accusative, e.genitive, 'service' AS kind,
                   lp.status, lp.title, lp.description AS lp_description,
                   lp.h1, lp.intro, lp.redirect_to
              FROM services e
              LEFT JOIN landing_pages lp ON lp.service_id = e.id AND lp.page_type = $2
             WHERE e.slug = $1
             UNION ALL
            SELECT e.id, e.slug, e.name, e.accusative, e.genitive, 'product' AS kind,
                   lp.status, lp.title, lp.description AS lp_description,
                   lp.h1, lp.intro, lp.redirect_to
              FROM products e
              LEFT JOIN landing_pages lp ON lp.product_id = e.id AND lp.page_type = $2
             WHERE e.slug = $1
             LIMIT 1
        `, [slug, pageType]);
        return row || null;
    }

    const loadHubEntity = (slug) => loadByAnyKind(slug, 'order');

    /* Открытые заказы хаба — по связям со справочником, а не по вхождению
       названия в заголовок. Поиск подстроки давал «вальцовку» в ответ на «вал»
       и «нарезку резьбы» в ответ на «резку»: исполнитель приходил из поиска за
       одним, а видел другое. Связи проставляются при создании заявки
       (lib/order-linking).

       Свежие за окно считаются тем же запросом: это число решает, звать ли
       робота, и отдельный поход в базу за ним не нужен. */
    async function loadHubOrders(kind, entityId, windowDays) {
        const linkTable = kind === 'service' ? 'order_services' : 'order_products';
        const column = kind === 'service' ? 'service_id' : 'product_id';
        const { rows } = await pool.query(`
            SELECT o.id, o.title, o.category, o.quantity, o.deadline, o.material,
                   o.production_type, o.created_at,
                   (o.drawing IS NOT NULL AND o.drawing <> '') AS has_drawing,
                   -- Тип параметра задаём явно: у $2 без приведения Postgres не
                   -- может вывести тип для конкатенации и падает на разборе
                   -- запроса. Умножение на интервал и читается яснее склейки строк.
                   (o.created_at > NOW() - ($2::int * INTERVAL '1 day')) AS is_fresh
              FROM ${linkTable} l
              JOIN orders o ON o.id = l.order_id
             WHERE l.${column} = $1 AND o.status = 'Активный'
             ORDER BY o.created_at DESC
             LIMIT 50
        `, [entityId, Number(windowDays)]);
        return rows.map(r => ({
            id: r.id, title: r.title, category: r.category, quantity: r.quantity,
            deadline: r.deadline, material: r.material, productionType: r.production_type,
            hasDrawing: r.has_drawing, isFresh: r.is_fresh,
        }));
    }

    router.get('/zakazy/:slug', async (req, res, next) => {
        try {
            const row = await loadHubEntity(String(req.params.slug || ''));
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
                res.status(410);
                return res.type('html').send('<!doctype html><meta charset="utf-8">'
                    + '<title>Страница удалена — ТехЗаказ</title>'
                    + '<p>Эта страница удалена. <a href="/zakupki">Перейти к закупкам</a>.</p>');
            }
            if (verdict.status !== 200) {
                res.status(verdict.status);
                return res.sendFile(path.join(__dirname, '..', '404.html'));
            }

            // kind нужен пустому состоянию: кнопка подписки должна знать,
            // на услугу подписываются или на изделие. accusative — заголовку:
            // «Заказы на токарную обработку» вместо «Открытые заказы: …».
            const entity = {
                id: row.id, slug: row.slug, name: row.name, kind: row.kind,
                accusative: row.accusative,
            };
            const { windowDays } = hub.supplyRule();
            const orders = await loadHubOrders(row.kind, row.id, windowDays);
            const fresh = orders.filter(o => o.isFresh).length;

            // Статус редактора ужесточается живым наполнением, но не смягчается:
            // пустой хаб закрывается сам, закрытый редактором не открывается.
            const robots = hub.robotsForHub(landing, fresh);

            const base = String(APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
            const related = row.kind === 'service'
                ? { href: `/uslugi/${entity.slug}`, title: entity.name }
                : { href: `/izdeliya/${entity.slug}`, title: entity.name };

            const lead = landing && landing.intro
                ? landing.intro
                : 'Заявки от заказчиков напрямую: без тендерных процедур, посредников и платы за участие.';

            const html = template()
                .replace(/<!--HEADER_CTA-->/g, 'Заполнить профиль')
                .replace(/<!--META_TITLE-->/g, htmlEscape(hub.buildTitle(entity, orders.length)))
                .replace(/<!--META_DESC-->/g, htmlEscape(hub.buildDescription(entity, orders.length, fresh)))
                .replace(/<!--META_ROBOTS-->/g, robots)
                .replace(/<!--CANONICAL_URL-->/g, `${base}${hub.ROOT}/${entity.slug}`)
                .replace(/<!--JSON_LD-->/g, hub.buildJsonLd(entity, orders, base))
                .replace(/<!--BREADCRUMB-->/g, hub.buildBreadcrumb(entity))
                .replace(/<!--PAGE_H1-->/g, esc(hub.buildH1(entity)))
                .replace(/<!--PAGE_LEAD-->/g, esc(lead))
                .replace(/<!--PAGE_STATS-->/g, hub.buildStats(orders.length, fresh))
                .replace(/<!--PAGE_BODY-->/g, hub.buildBody(entity, orders, related))
                .replace(/<!--EV_PAGE_TYPE-->/g, 'order_hub')
                .replace(/<!--EV_ENTITY_ID-->/g, String(entity.id))
                .replace(/<!--EV_INTENT-->/g, 'executor');

            // Лента заказов живёт быстрее каталога: час кэша здесь означал бы,
            // что исполнитель видит вчерашнюю картину.
            res.setHeader('Cache-Control', robots.startsWith('index')
                ? 'public, max-age=300' : 'private, max-age=0, must-revalidate');
            res.type('html').send(html);
        } catch (e) { next(e); }
    });

    // ─────────────────── Каталог подрядчиков ───────────────────
    // Четвёртая страница кластера, ТЗ §6.4. Адрес подтверждён маркетингом
    // 22.09: /podryadchiki/ — витрина подрядчиков для заказчика, ролевые
    // лендинги уезжают на /zakazchikam/ и /ispolnitelyam/.

    const loadContractorEntity = (slug) => loadByAnyKind(slug, 'contractor');

    /** Все предприятия по теме — без потолка страницы услуги. В этом и смысл
     *  отдельного каталога: на /izdeliya/ список обрезан двадцатью карточками,
     *  а здесь он полный. Лимит всё же есть, но заметно выше, и остаток честно
     *  уводится в общий каталог. */
    async function loadContractors(kind, entityId) {
        const linkTable = kind === 'service' ? 'company_services' : 'company_products';
        const column = kind === 'service' ? 'service_id' : 'product_id';
        const { rows } = await pool.query(`
            SELECT c.id, c.company, c.city, c.specialization, c.products,
                   c.verified_by_platform, c.claimed,
                   COUNT(*) OVER ()::int AS total
              FROM ${linkTable} l
              JOIN companies c ON c.id = l.company_id
             WHERE l.${column} = $1 AND c.status <> 'Отклонено'
             ORDER BY c.verified_by_platform DESC, c.claimed DESC, c.company
             LIMIT $2
        `, [entityId, contractors.LIST_LIMIT]);
        return {
            total: rows.length ? rows[0].total : 0,
            companies: rows.map(r => ({
                id: r.id, company: r.company, city: r.city,
                specialization: r.specialization, products: r.products,
                verifiedByPlatform: r.verified_by_platform, claimed: r.claimed,
            })),
        };
    }

    /** Разбивка по городам. Считается по всей выборке, а не по показанным
     *  карточкам: «в 14 городах» обязано быть правдой про тему, а не про первые
     *  сорок восемь строк.
     *
     *  Ссылка на геостраницу ставится только там, где она индексируется, —
     *  тот же предикат, что у самой геостраницы (lib/region-seo). Иначе каталог
     *  гонит робота на страницы с noindex. */
    async function loadContractorCities(kind, entityId) {
        const linkTable = kind === 'service' ? 'company_services' : 'company_products';
        const column = kind === 'service' ? 'service_id' : 'product_id';
        const { rows } = await pool.query(`
            SELECT c.city AS name, COUNT(*)::int AS count
              FROM ${linkTable} l
              JOIN companies c ON c.id = l.company_id
             WHERE l.${column} = $1 AND c.status <> 'Отклонено'
               AND COALESCE(c.city, '') <> ''
             GROUP BY c.city
             ORDER BY count DESC, c.city
        `, [entityId]);

        /* Сколько всего предприятий в самом регионе — не по этой теме, а
           вообще: именно это число решает, открыта ли геостраница. */
        const regionTotals = new Map();
        if (rows.length) {
            const { rows: totals } = await pool.query(
                `SELECT city, COUNT(*)::int AS n FROM companies
                  WHERE role = 'producer' AND status <> 'Отклонено' AND city = ANY($1)
                  GROUP BY city`,
                [rows.map(r => r.name)]
            );
            for (const t of totals) regionTotals.set(t.city, t.n);
        }

        return rows.map(r => {
            const region = REGIONS.find(x => x.name === r.name);
            const indexable = region && isRegionIndexable(regionTotals.get(r.name) || 0);
            return {
                name: r.name, count: r.count,
                href: indexable ? `/zakupki/region/${region.slug}` : '',
            };
        });
    }

    router.get('/podryadchiki/:slug', async (req, res, next) => {
        try {
            const row = await loadContractorEntity(String(req.params.slug || ''));
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
                res.status(410);
                return res.type('html').send('<!doctype html><meta charset="utf-8">'
                    + '<title>Страница удалена — ТехЗаказ</title>'
                    + '<p>Эта страница удалена. <a href="/proizvoditeli">Перейти к каталогу производств</a>.</p>');
            }
            if (verdict.status !== 200) {
                res.status(verdict.status);
                return res.sendFile(path.join(__dirname, '..', '404.html'));
            }

            const entity = {
                id: row.id, slug: row.slug, name: row.name, kind: row.kind,
                genitive: row.genitive,
            };
            const [list, cities] = await Promise.all([
                loadContractors(row.kind, row.id),
                loadContractorCities(row.kind, row.id),
            ]);

            // Наполнение ужесточает решение редактора, но не смягчает: каталог,
            // где осталось два предприятия, закрывается сам.
            const robots = contractors.robotsForCatalog(landing, list.total);

            const base = String(APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
            const related = row.kind === 'service'
                ? { href: `/uslugi/${entity.slug}`, title: entity.name }
                : { href: `/izdeliya/${entity.slug}`, title: `Изготовление «${entity.name}»` };

            const lead = landing && landing.intro
                ? landing.intro
                : 'Профили производств с указанной компетенцией. Город, специализация и происхождение карточки — у каждого предприятия.';

            const html = template()
                .replace(/<!--HEADER_CTA-->/g, 'Разместить закупку')
                .replace(/<!--META_TITLE-->/g, htmlEscape(landing && landing.title
                    ? landing.title : contractors.buildTitle(entity, list.total)))
                .replace(/<!--META_DESC-->/g, htmlEscape(landing && landing.description
                    ? landing.description : contractors.buildDescription(entity, list.total, cities.length)))
                .replace(/<!--META_ROBOTS-->/g, robots)
                .replace(/<!--CANONICAL_URL-->/g, `${base}${contractors.ROOT}/${entity.slug}`)
                .replace(/<!--JSON_LD-->/g, contractors.buildJsonLd(entity, list.companies, base))
                .replace(/<!--BREADCRUMB-->/g, contractors.buildBreadcrumb(entity))
                .replace(/<!--PAGE_H1-->/g, esc(landing && landing.h1 ? landing.h1 : contractors.buildH1(entity)))
                .replace(/<!--PAGE_LEAD-->/g, esc(lead))
                .replace(/<!--PAGE_STATS-->/g, contractors.buildStats(list.total, cities.length))
                .replace(/<!--PAGE_BODY-->/g, contractors.buildBody(entity, list.companies, cities, related, list.total))
                .replace(/<!--EV_PAGE_TYPE-->/g, 'contractor')
                .replace(/<!--EV_ENTITY_ID-->/g, String(entity.id))
                .replace(/<!--EV_INTENT-->/g, 'customer');

            res.setHeader('Cache-Control', robots.startsWith('index')
                ? 'public, max-age=3600' : 'private, max-age=0, must-revalidate');
            res.type('html').send(html);
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = { createClusterRouter, COMPANY_LIMIT, ORDER_LIMIT };
