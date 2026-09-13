'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogAdminRouter } = require('../../routes/catalog-admin');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

/* Справочник услуг и изделий правит редактор, а не разработчик (ТЗ §13.1).
   Тесты сторожат то, что дороже всего чинить задним числом: уникальность
   адресов, целостность иерархии и сохранность связей при объединении. */

const BASE = '/api/admin/catalog';
const ADMIN = { id: 1, role: 'admin', company: '', email: 'a@t.ru' };
const EDITOR = { id: 2, role: 'customer', company: 'ООО Заказчик', email: 'c@t.ru' };

/** Поднимает роутер и гарантированно гасит сервер: незакрытый слушатель
 *  подвешивает весь прогон, если assert упал раньше close(). */
async function withRouter(rules, fn, user = ADMIN) {
    const pool = fakePool(rules);
    const instance = createCatalogAdminRouter(baseDeps({ pool, requireAuth: fakeAuth(user) }));
    const app = await serve(BASE, instance);
    try {
        await fn({ request: (p, o) => app.request(BASE + p, o), pool });
    } finally {
        await app.close();
    }
}

// ─────────────────── Доступ ───────────────────

test('справочник закрыт от неадминистратора', async () => {
    await withRouter([], async ({ request }) => {
        const res = await request('/services');
        assert.equal(res.status, 403);
    }, EDITOR);
});

test('неизвестный вид справочника не доходит до базы', async () => {
    // Имя таблицы подставляется в SQL, поэтому проверка обязана быть до запроса.
    // fakePool без правил бросил бы на любом запросе — значит, запросов не было.
    await withRouter([], async ({ request, pool }) => {
        const res = await request('/companies');
        assert.equal(res.status, 404);
        assert.equal(pool.calls.length, 0, 'в базу ходить не должны');
    });
});

// ─────────────────── Создание ───────────────────

test('slug генерируется из названия', async () => {
    await withRouter([
        { match: /SELECT 1 FROM services WHERE slug/i, rows: [] },
        { match: /INSERT INTO services/i, rows: [{ id: 10, slug: 'tokarnaya-obrabotka', name: 'Токарная обработка', parent_id: null, status: 'draft' }] },
    ], async ({ request, pool }) => {
        const res = await request('/services', { method: 'POST', body: { name: 'Токарная обработка' } });
        assert.equal(res.status, 201);
        assert.equal(res.json.slug, 'tokarnaya-obrabotka');
        const insert = pool.calls.find(c => /INSERT INTO services/i.test(c.sql));
        assert.equal(insert.params[0], 'tokarnaya-obrabotka');
    });
});

test('занятый slug получает числовой суффикс, а не падает', async () => {
    let asked = 0;
    await withRouter([
        { match: /SELECT 1 FROM services WHERE slug/i, rows: () => (++asked === 1 ? [{ one: 1 }] : []) },
        { match: /INSERT INTO services/i, rows: [{ id: 11, slug: 'frezernaya-obrabotka-2', name: 'Фрезерная обработка', parent_id: null, status: 'draft' }] },
    ], async ({ request, pool }) => {
        const res = await request('/services', { method: 'POST', body: { name: 'Фрезерная обработка' } });
        assert.equal(res.status, 201);
        const insert = pool.calls.find(c => /INSERT INTO services/i.test(c.sql));
        assert.equal(insert.params[0], 'frezernaya-obrabotka-2', 'второй записи достаётся суффикс');
    });
});

test('slug, введённый руками, проверяется на формат', async () => {
    await withRouter([], async ({ request }) => {
        const res = await request('/services', { method: 'POST', body: { name: 'Литьё', slug: 'Литьё Под Давлением' } });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /латиниц/i);
    });
});

test('запись без названия не создаётся', async () => {
    await withRouter([], async ({ request }) => {
        const res = await request('/products', { method: 'POST', body: { name: '   ' } });
        assert.equal(res.status, 400);
    });
});

// ─────────────────── Иерархия ───────────────────

test('узел не может стать родителем самому себе', async () => {
    await withRouter([
        { match: /SELECT \* FROM services WHERE id/i, rows: [{ id: 5, name: 'Резка', slug: 'rezka', parent_id: null, description: '', status: 'draft' }] },
    ], async ({ request }) => {
        const res = await request('/services/5', { method: 'PATCH', body: { parentId: 5 } });
        assert.equal(res.status, 400);
    });
});

test('петля в иерархии через потомка не проходит', async () => {
    // 5 — родитель 9. Подчинить 5 девятому значит замкнуть дерево, и обход
    // по parent_id зациклится.
    const parents = { 9: 5, 5: null };
    await withRouter([
        { match: /SELECT \* FROM services WHERE id/i, rows: [{ id: 5, name: 'Резка', slug: 'rezka', parent_id: null, description: '', status: 'draft' }] },
        { match: /SELECT parent_id FROM services WHERE id/i, rows: (sql, p) => [{ parent_id: parents[p[0]] ?? null }] },
    ], async ({ request }) => {
        const res = await request('/services/5', { method: 'PATCH', body: { parentId: 9 } });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /петл/i);
    });
});

// ─────────────────── Удаление ───────────────────

test('удаление отклоняется, пока за записью стоят связи', async () => {
    await withRouter([
        { match: /FROM services e WHERE e\.id/i, rows: [{ name: 'Токарная обработка', children: 2, companies: 37, landings: 1 }] },
    ], async ({ request, pool }) => {
        const res = await request('/services/5', { method: 'DELETE' });
        assert.equal(res.status, 409);
        assert.deepEqual(res.json.blockers, ['дочерних записей: 2', 'связей с компаниями: 37', 'посадочных страниц: 1']);
        assert.ok(!pool.calls.some(c => /DELETE FROM services/i.test(c.sql)), 'удалять ничего не должны');
    });
});

test('пустая запись удаляется', async () => {
    await withRouter([
        { match: /FROM services e WHERE e\.id/i, rows: [{ name: 'Ошибочная', children: 0, companies: 0, landings: 0 }] },
        { match: /DELETE FROM services/i, rows: [] },
    ], async ({ request, pool }) => {
        const res = await request('/services/5', { method: 'DELETE' });
        assert.equal(res.status, 200);
        assert.ok(pool.calls.some(c => /DELETE FROM services/i.test(c.sql)));
    });
});

// ─────────────────── Объединение ───────────────────

test('объединение переносит связи, потомков и оставляет 301', async () => {
    await withRouter([
        { match: /SELECT id, name, slug FROM services WHERE id = ANY/i, rows: [
            { id: 5, name: 'Токарка', slug: 'tokarka' },
            { id: 7, name: 'Токарная обработка', slug: 'tokarnaya-obrabotka' },
        ] },
        { match: /SELECT parent_id FROM services WHERE id/i, rows: [{ parent_id: null }] },
        { match: /INSERT INTO company_services/i, rows: [] },
        { match: /DELETE FROM company_services/i, rows: [] },
        { match: /INSERT INTO service_products/i, rows: [] },
        { match: /DELETE FROM service_products/i, rows: [] },
        { match: /UPDATE services SET parent_id/i, rows: [] },
        { match: /SELECT url FROM landing_pages/i, rows: [{ url: '/uslugi/tokarnaya-obrabotka/' }] },
        { match: /UPDATE landing_pages/i, rows: [] },
        { match: /DELETE FROM services WHERE id/i, rows: [] },
    ], async ({ request, pool }) => {
        const res = await request('/services/5/merge', { method: 'POST', body: { targetId: 7 } });
        assert.equal(res.status, 200);
        assert.equal(res.json.merged, 'Токарка');
        assert.equal(res.json.into, 'Токарная обработка');

        const landing = pool.calls.find(c => /UPDATE landing_pages/i.test(c.sql));
        assert.match(landing.sql, /status = 'merged'/, 'страница источника должна стать merged');
        assert.equal(landing.params[1], '/uslugi/tokarnaya-obrabotka/', 'редирект ведёт на страницу цели');

        const reparent = pool.calls.find(c => /UPDATE services SET parent_id/i.test(c.sql));
        assert.deepEqual(reparent.params, [5, 7], 'потомки переходят к цели');

        const moveLinks = pool.calls.find(c => /INSERT INTO company_services/i.test(c.sql));
        assert.match(moveLinks.sql, /ON CONFLICT DO NOTHING/i, 'своя связь компании сильнее перенесённой');
    });
});

test('объединение записи с самой собой отклоняется', async () => {
    await withRouter([], async ({ request, pool }) => {
        const res = await request('/services/5/merge', { method: 'POST', body: { targetId: 5 } });
        assert.equal(res.status, 400);
        assert.equal(pool.calls.length, 0);
    });
});

// ─────────────────── Связь услуга ↔ изделие ───────────────────

test('связь не создаётся на несуществующее изделие', async () => {
    await withRouter([
        { match: /SELECT \(SELECT COUNT/i, rows: [{ s: 1, p: 0 }] },
    ], async ({ request }) => {
        const res = await request('/services/5/products', { method: 'POST', body: { productId: 999 } });
        assert.equal(res.status, 404);
        assert.match(res.json.error, /Изделие/);
    });
});

test('повторная связь не ломается об уникальный ключ', async () => {
    await withRouter([
        { match: /SELECT \(SELECT COUNT/i, rows: [{ s: 1, p: 1 }] },
        { match: /INSERT INTO service_products/i, rows: [] },
    ], async ({ request, pool }) => {
        const res = await request('/services/5/products', { method: 'POST', body: { productId: 8 } });
        assert.equal(res.status, 201);
        const insert = pool.calls.find(c => /INSERT INTO service_products/i.test(c.sql));
        assert.match(insert.sql, /ON CONFLICT DO NOTHING/i);
    });
});
