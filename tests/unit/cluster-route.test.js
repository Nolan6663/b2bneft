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

/** Пул отвечает на четыре запроса маршрута: сущность, исполнители,
 *  связанные сущности и открытые закупки. */
function poolFor(landing, { companies = [], related = [], orders = [] } = {}) {
    return fakePool([
        { match: /FROM services e[\s\S]*LEFT JOIN landing_pages/i, rows: landing === undefined ? [] : [{ ...ENTITY, ...landing }] },
        { match: /FROM company_services l/i, rows: companies },
        { match: /FROM service_products sp/i, rows: related },
        // Закупки берутся по связям со справочником, а не поиском по заголовку.
        { match: /FROM order_services l/i, rows: orders },
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
    ]);
    await withRoute(pool, async (app) => {
        const res = await app.request('/izdeliya/valy');
        assert.equal(res.status, 200);
        const html = res.buf.toString('utf8');
        assert.match(html, /Изготовление «Валы»/);
        assert.match(html, /Пока ни одно предприятие/, 'пустой каталог говорит правду');
    });
});
