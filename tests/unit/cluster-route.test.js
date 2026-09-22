'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClusterRouter } = require('../../routes/cluster');
const { fakePool, serve, baseDeps } = require('./helpers');

/* Проводка между статусом посадочной страницы и ответом сервера. Логика
   разобрана в cluster-seo.test.js; здесь проверяется, что маршрут ею
   действительно пользуется, а не решает по-своему. */

const ENTITY = {
    id: 1, slug: 'tokarnaya-obrabotka', name: 'Токарная обработка', description: 'Точение деталей',
};

/** Пул отвечает на запросы маршрута: сущность, исполнители, связанные
 *  сущности, открытые закупки, кейсы и наличие каталога подрядчиков. */
function poolFor(landing, { companies = [], related = [], orders = [], contractorLanding = [] } = {}) {
    return fakePool([
        { match: /FROM services e[\s\S]*LEFT JOIN landing_pages/i, rows: landing === undefined ? [] : [{ ...ENTITY, ...landing }] },
        { match: /FROM company_services l/i, rows: companies },
        { match: /FROM service_products sp/i, rows: related },
        // Закупки берутся по связям со справочником, а не поиском по заголовку.
        { match: /FROM order_services l/i, rows: orders },
        // Кейсы по теме — ТЗ §9.3.
        { match: /FROM case_services cs/i, rows: [] },
        // Есть ли у темы открытый каталог подрядчиков: от этого зависит, ставить
        // ли ссылку «все N предприятий» (ТЗ §6.4, §7.1).
        { match: /FROM landing_pages[\s\S]*page_type = 'contractor'/i, rows: contractorLanding },
    ]);
}

async function withRoute(pool, fn) {
    const router = createClusterRouter(baseDeps({ pool, htmlEscape: (s) => String(s || ''), APP_URL: 'https://texzakaz.ru' }));
    const app = await serve('/', router);
    try { await fn(app); } finally { await app.close(); }
}

test('опубликованная страница отдаётся с индексацией и содержит контент', async () => {
    const pool = poolFor(
        { status: 'published_index', title: null, lp_description: null, h1: null, intro: null, redirect_to: '' },
        { companies: [{ id: 5, company: 'ООО Первый', city: 'Пермь', claimed: true, verified_by_platform: false }] }
    );
    await withRoute(pool, async (app) => {
        const res = await app.request('/uslugi/tokarnaya-obrabotka');
        assert.equal(res.status, 200);
        const html = res.buf.toString('utf8');
        assert.match(html, /name="robots" content="index, follow"/);
        assert.match(html, /ООО Первый/, 'карточки должны быть в исходном HTML');
        assert.match(html, /rel="canonical" href="https:\/\/texzakaz\.ru\/uslugi\/tokarnaya-obrabotka"/);
    });
});

test('страница без записи в реестре отдаёт 404', async () => {
    // Сущность в справочнике есть, посадочную не заводили — публичного адреса нет.
    const pool = poolFor({ status: null });
    await withRoute(pool, async (app) => {
        const res = await app.request('/uslugi/tokarnaya-obrabotka');
        assert.equal(res.status, 404);
    });
});

test('черновик наружу не выходит', async () => {
    const pool = poolFor({ status: 'draft' });
    await withRoute(pool, async (app) => {
        assert.equal((await app.request('/uslugi/tokarnaya-obrabotka')).status, 404);
    });
});

test('published_noindex открыт людям, закрыт роботу и не кэшируется надолго', async () => {
    const pool = poolFor({ status: 'published_noindex', redirect_to: '' });
    await withRoute(pool, async (app) => {
        const res = await app.request('/uslugi/tokarnaya-obrabotka');
        assert.equal(res.status, 200);
        assert.match(res.buf.toString('utf8'), /name="robots" content="noindex, follow"/);
        assert.match(res.headers.get('cache-control') || '', /no|must-revalidate/i,
            'страница в этом статусе временно, правка редактора должна быть видна сразу');
    });
});

test('объединённая страница отдаёт 301 на цель', async () => {
    const pool = poolFor({ status: 'merged', redirect_to: '/uslugi/mehanicheskaya-obrabotka' });
    await withRoute(pool, async (app) => {
        // redirect: 'manual' обязателен: обычный fetch пройдёт по редиректу
        // и покажет код конечной страницы вместо самого 301.
        const res = await fetch(app.url + '/uslugi/tokarka', { redirect: 'manual' });
        assert.equal(res.status, 301);
        assert.equal(res.headers.get('location'), '/uslugi/mehanicheskaya-obrabotka');
    });
});

test('архивная страница отвечает 410', async () => {
    const pool = poolFor({ status: 'archived' });
    await withRoute(pool, async (app) => {
        const res = await app.request('/uslugi/tokarnaya-obrabotka');
        assert.equal(res.status, 410, 'после 410 робот перестаёт возвращаться, после 404 — нет');
    });
});

test('несуществующий slug — 404, а не пустая страница', async () => {
    const pool = poolFor(undefined);
    await withRoute(pool, async (app) => {
        assert.equal((await app.request('/uslugi/nesushchestvuyushchaya')).status, 404);
    });
});

test('изделия обслуживаются тем же механизмом', async () => {
    const pool = fakePool([
        { match: /FROM products e[\s\S]*LEFT JOIN landing_pages/i, rows: [{ id: 2, slug: 'valy', name: 'Валы', description: '', status: 'published_index', redirect_to: '' }] },
        { match: /FROM company_products l/i, rows: [] },
        { match: /FROM service_products sp/i, rows: [] },
        { match: /FROM order_products l/i, rows: [] },
        { match: /FROM cases c[\s\S]*WHERE c\.product_id/i, rows: [] },
        { match: /FROM landing_pages[\s\S]*page_type = 'contractor'/i, rows: [] },
    ]);
    await withRoute(pool, async (app) => {
        const res = await app.request('/izdeliya/valy');
        assert.equal(res.status, 200);
        const html = res.buf.toString('utf8');
        assert.match(html, /Изготовление «Валы»/);
        assert.match(html, /Пока ни одно предприятие/, 'пустой каталог говорит правду');
    });
});

// ─────────────────── Каталог подрядчиков ───────────────────
// Четвёртая страница кластера. Здесь проверяется только проводка: что маршрут
// пользуется lib/contractors-seo, а не решает по-своему.

const CONTRACTOR_ENTITY = {
    id: 4, slug: 'valy', name: 'Валы', kind: 'product', genitive: 'валов',
};

function contractorPool(landing, { companies = [], cities = [], regionTotals = [] } = {}) {
    return fakePool([
        // Сущность ищется в обоих справочниках: slug может принадлежать и
        // услуге, и изделию.
        { match: /FROM services e[\s\S]*UNION ALL[\s\S]*FROM products e/i,
          rows: landing === undefined ? [] : [{ ...CONTRACTOR_ENTITY, ...landing }] },
        { match: /COUNT\(\*\) OVER \(\)/i, rows: companies },
        { match: /GROUP BY c\.city/i, rows: cities },
        { match: /WHERE role = 'producer'/i, rows: regionTotals },
    ]);
}

test('каталог подрядчиков отдаётся с индексацией при достаточном наполнении', async () => {
    const companies = Array.from({ length: 6 }, (_, i) => ({
        id: i + 1, company: `ООО Завод ${i + 1}`, city: 'Челябинск',
        specialization: 'Токарная обработка', claimed: true, verified_by_platform: false,
        total: 6,
    }));
    const pool = contractorPool({ status: 'published_index', redirect_to: '' }, {
        companies,
        cities: [{ name: 'Челябинск', count: 6 }],
        regionTotals: [{ city: 'Челябинск', n: 40 }],
    });
    await withRoute(pool, async (app) => {
        const res = await app.request('/podryadchiki/valy');
        assert.equal(res.status, 200);
        const html = res.buf.toString('utf8');
        assert.match(html, /name="robots" content="index, follow"/);
        assert.match(html, /Производители валов/, 'родительный падеж из справочника');
        assert.match(html, /ООО Завод 1/, 'карточки в исходном HTML, без JavaScript');
        assert.match(html, /rel="canonical" href="https:\/\/texzakaz\.ru\/podryadchiki\/valy"/);
    });
});

test('каталог с наполнением ниже порога закрывается сам', async () => {
    // Порог по умолчанию — 5 предприятий (ответ маркетинга 22.09, пункт 6).
    const companies = [{
        id: 1, company: 'ООО Единственный', city: 'Пермь', claimed: true,
        verified_by_platform: false, total: 1,
    }];
    const pool = contractorPool({ status: 'published_index', redirect_to: '' }, { companies });
    await withRoute(pool, async (app) => {
        const res = await app.request('/podryadchiki/valy');
        assert.equal(res.status, 200, 'человеку страница открыта');
        assert.match(res.buf.toString('utf8'), /name="robots" content="noindex, follow"/,
            'а роботу — нет: витрина с одним предприятием в индексе вредна');
    });
});

test('каталог без записи в реестре отдаёт 404', async () => {
    const pool = contractorPool({ status: null });
    await withRoute(pool, async (app) => {
        assert.equal((await app.request('/podryadchiki/valy')).status, 404);
    });
});

test('страница услуги ссылается на каталог, только когда он открыт', async () => {
    const companies = Array.from({ length: 20 }, (_, i) => ({
        id: i + 1, company: `ООО Завод ${i + 1}`, city: 'Пермь', claimed: true,
        verified_by_platform: false, total: 31,
    }));
    const withCatalog = poolFor(
        { status: 'published_index', redirect_to: '' },
        { companies, contractorLanding: [{ '?column?': 1 }] }
    );
    await withRoute(withCatalog, async (app) => {
        const html = (await app.request('/uslugi/tokarnaya-obrabotka')).buf.toString('utf8');
        assert.match(html, /href="\/podryadchiki\/tokarnaya-obrabotka"/);
        assert.match(html, /Все 31 предприятие/, 'число берётся из общего счёта, а не из выдачи');
    });

    const withoutCatalog = poolFor(
        { status: 'published_index', redirect_to: '' },
        { companies, contractorLanding: [] }
    );
    await withRoute(withoutCatalog, async (app) => {
        const html = (await app.request('/uslugi/tokarnaya-obrabotka')).buf.toString('utf8');
        assert.ok(!/podryadchiki/.test(html), 'ссылки в никуда быть не должно');
    });
});
