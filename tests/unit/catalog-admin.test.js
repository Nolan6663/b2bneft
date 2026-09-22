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

// ─────────────────── Посадочные страницы ───────────────────

/* Управление статусом — то место, где проверка перед индексацией перестаёт
   быть украшением. Раньше похожий механизм (robotsFor) был написан и месяц
   лежал без вызова; здесь тесты сторожат, что он действительно применяется. */

const LANDING = {
    id: 3, system_key: 'service:customer:tokarnaya-obrabotka', url: '/uslugi/tokarnaya-obrabotka',
    page_type: 'service', intent: 'customer', status: 'draft', service_id: 1, product_id: null,
    demand_hits: 0, supply_count: 0,
};

test('из черновика нельзя открыть страницу сразу в индекс', async () => {
    await withRouter([
        { match: /SELECT \* FROM landing_pages WHERE id/i, rows: [LANDING] },
    ], async ({ request, pool }) => {
        const res = await request('/landings/3/status', { method: 'PATCH', body: { status: 'published_index' } });
        assert.equal(res.status, 409);
        assert.match(res.json.error, /Сначала опубликуйте с noindex/);
        assert.ok(!pool.calls.some(c => /UPDATE landing_pages/i.test(c.sql)), 'статус меняться не должен');
    });
});

test('открытие в индекс без предложения отклоняется с разбором причин', async () => {
    await withRouter([
        { match: /SELECT \* FROM landing_pages WHERE id/i, rows: [{ ...LANDING, status: 'published_noindex' }] },
        { match: /FROM company_services WHERE service_id/i, rows: [{ n: 1 }] },
        { match: /WHERE system_key = \$1 AND id <> \$2/i, rows: [] },
        { match: /WHERE url = \$1 AND id <> \$2/i, rows: [] },
    ], async ({ request, pool }) => {
        const res = await request('/landings/3/status', { method: 'PATCH', body: { status: 'published_index' } });
        assert.equal(res.status, 409);
        assert.match(res.json.error, /не прошла проверку/i);
        assert.ok(res.json.blocking.some(c => /предложения/i.test(c.title)), 'причина названа');
        assert.ok(!pool.calls.some(c => /UPDATE landing_pages/i.test(c.sql)));
    });
});

test('страница с достаточным наполнением открывается', async () => {
    await withRouter([
        { match: /SELECT \* FROM landing_pages WHERE id/i, rows: [{ ...LANDING, status: 'published_noindex' }] },
        { match: /FROM company_services WHERE service_id/i, rows: [{ n: 12 }] },
        { match: /WHERE system_key = \$1 AND id <> \$2/i, rows: [] },
        { match: /WHERE url = \$1 AND id <> \$2/i, rows: [] },
        { match: /UPDATE landing_pages/i, rows: [{ id: 3, url: LANDING.url, status: 'published_index', indexed_at: '2026-09-14' }] },
    ], async ({ request }) => {
        const res = await request('/landings/3/status', { method: 'PATCH', body: { status: 'published_index' } });
        assert.equal(res.status, 200);
        assert.equal(res.json.status, 'published_index');
    });
});

test('дубль системного ключа не пускает в индекс', async () => {
    // Две страницы на один интент — та самая каннибализация из ТЗ §2.2.
    await withRouter([
        { match: /SELECT \* FROM landing_pages WHERE id/i, rows: [{ ...LANDING, status: 'published_noindex' }] },
        { match: /FROM company_services WHERE service_id/i, rows: [{ n: 30 }] },
        { match: /WHERE system_key = \$1 AND id <> \$2/i, rows: [{ url: '/uslugi/tokarka' }] },
        { match: /WHERE url = \$1 AND id <> \$2/i, rows: [] },
    ], async ({ request }) => {
        const res = await request('/landings/3/status', { method: 'PATCH', body: { status: 'published_index' } });
        assert.equal(res.status, 409);
        assert.ok(res.json.blocking.some(c => /ключ/i.test(c.title)));
    });
});

test('закрыть страницу можно всегда, проверка наполнения не мешает', async () => {
    // Запрещать уборку бессмысленно: проверка стоит только на входе в индекс.
    await withRouter([
        { match: /SELECT \* FROM landing_pages WHERE id/i, rows: [{ ...LANDING, status: 'published_index' }] },
        { match: /UPDATE landing_pages/i, rows: [{ id: 3, url: LANDING.url, status: 'published_noindex', indexed_at: null }] },
    ], async ({ request, pool }) => {
        const res = await request('/landings/3/status', { method: 'PATCH', body: { status: 'published_noindex' } });
        assert.equal(res.status, 200);
        assert.ok(!pool.calls.some(c => /FROM company_services/i.test(c.sql)), 'наполнение при закрытии не считаем');
    });
});

// ─────────────────── Тексты посадочных страниц ───────────────────
/* Правило маркетинга (ответ 22.09, пункт 8): предупреждать о длине, но
   сохранять значение целиком — без автоматического обрезания и без блокировки
   сохранения. Библиотека проверена отдельно (content-limits.test.js); здесь
   сторожится то, что маршрут ею действительно пользуется. */

const LANDING_UPDATE = /UPDATE landing_pages SET/i;

test('длинный заголовок сохраняется целиком и возвращает предупреждение', async () => {
    const long = 'Т'.repeat(140);
    await withRouter([
        { match: LANDING_UPDATE, rows: [{ id: 3, url: '/podryadchiki/valy', status: 'draft', title: long, description: '', h1: '', intro: '', updated_at: new Date() }] },
    ], async ({ request, pool }) => {
        const res = await request('/landings/3', { method: 'PATCH', body: { title: long } });
        assert.equal(res.status, 200, 'сохранение не блокируется');
        assert.equal(res.json.title, long, 'ни одного знака не потеряно');
        assert.equal(res.json.warnings.length, 1);
        assert.match(res.json.warnings[0], /140/);
        // В базу ушло полное значение, а не подрезанное.
        assert.equal(pool.calls[0].params[1], long);
    });
});

test('правка одного поля не стирает остальные', async () => {
    await withRouter([
        { match: LANDING_UPDATE, rows: [{ id: 3, url: '/podryadchiki/valy', status: 'draft', title: 'Валы', description: 'было', h1: '', intro: '', updated_at: new Date() }] },
    ], async ({ request, pool }) => {
        await request('/landings/3', { method: 'PATCH', body: { title: 'Валы' } });
        assert.ok(!/description/.test(pool.calls[0].text), pool.calls[0].text);
    });
});

test('пустое тело не превращается в затирание текстов', async () => {
    await withRouter([], async ({ request, pool }) => {
        const res = await request('/landings/3', { method: 'PATCH', body: {} });
        assert.equal(res.status, 400);
        assert.equal(pool.calls.length, 0, 'до базы такой запрос доходить не должен');
    });
});

test('посторонние ключи в тело запроса не пролезают в SQL', async () => {
    // Имена колонок подставляются строкой, поэтому список полей закрытый.
    await withRouter([
        { match: LANDING_UPDATE, rows: [{ id: 3, url: '/x', status: 'draft', title: 'Валы', description: '', h1: '', intro: '', updated_at: new Date() }] },
    ], async ({ request, pool }) => {
        await request('/landings/3', { method: 'PATCH', body: { title: 'Валы', status: 'published_index', url: '/hack' } });
        assert.ok(!/status =/.test(pool.calls[0].text), pool.calls[0].text);
        assert.ok(!/url =/.test(pool.calls[0].text), pool.calls[0].text);
    });
});

test('тексты правит только администратор', async () => {
    await withRouter([], async ({ request }) => {
        assert.equal((await request('/landings/3', { method: 'PATCH', body: { title: 'x' } })).status, 403);
    }, EDITOR);
});

test('рекомендуемые длины отдаются админке', async () => {
    await withRouter([], async ({ request, pool }) => {
        const res = await request('/landings/limits');
        assert.equal(res.status, 200);
        assert.ok(res.json.some(l => l.field === 'title' && l.recommended === 60));
        assert.equal(pool.calls.length, 0, 'это константы, в базу ходить незачем');
    });
});

test('список посадочных отдаётся, а не съедается маршрутом справочника', async () => {
    /* Express разбирает маршруты по порядку регистрации, и `/:kind` стоит выше
       `/landings`. Пока посадочные не вынесли в отдельный роутер, GET /landings
       уходил в обработчик справочника с kind='landings' и отвечал 404 — то
       есть реестр посадочных из админки был недоступен вовсе. */
    await withRouter([
        { match: /FROM landing_pages lp/i, rows: [{ id: 1, system_key: 'contractor:customer:valy', url: '/podryadchiki/valy', page_type: 'contractor', intent: 'customer', status: 'draft', title: '', h1: '', demand_hits: 0, supply_count: 0, index_note: '', indexed_at: null, updated_at: new Date(), entity_name: 'Валы' }] },
    ], async ({ request }) => {
        const res = await request('/landings');
        assert.equal(res.status, 200);
        assert.equal(res.json[0].url, '/podryadchiki/valy');
    });
});

test('справочник с именем несуществующего вида по-прежнему 404', async () => {
    // Вынос /landings не должен был ослабить проверку белого списка.
    await withRouter([], async ({ request, pool }) => {
        assert.equal((await request('/companies')).status, 404);
        assert.equal(pool.calls.length, 0);
    });
});

// ─────────────────── Роль SEO ───────────────────
/* Маркетинг попросил доступ к панели спроса (ответ 22.09, пункт 5). Полного
   администратора под это выдавать нельзя: там заявки на верификацию, список
   пользователей и контакты предприятий. Роль `seo` открывает справочник и
   реестр посадочных — и ничего сверх того. */

const SEO = { id: 3, role: 'seo', company: '', email: 'seo@agency.ru' };

test('SEO-специалист видит справочник', async () => {
    await withRouter([
        { match: /FROM services e/i, rows: [] },
    ], async ({ request }) => {
        assert.equal((await request('/services')).status, 200);
    }, SEO);
});

test('SEO-специалист правит тексты посадочных', async () => {
    await withRouter([
        { match: LANDING_UPDATE, rows: [{ id: 3, url: '/podryadchiki/valy', status: 'draft', title: 'Производители валов', description: '', h1: '', intro: '', updated_at: new Date() }] },
    ], async ({ request }) => {
        const res = await request('/landings/3', { method: 'PATCH', body: { title: 'Производители валов' } });
        assert.equal(res.status, 200);
    }, SEO);
});

test('заказчик и исполнитель в справочник не попадают', async () => {
    await withRouter([], async ({ request }) => {
        assert.equal((await request('/services')).status, 403);
    }, EDITOR);
    await withRouter([], async ({ request }) => {
        assert.equal((await request('/services')).status, 403);
    }, { id: 4, role: 'producer', company: 'ООО Завод', email: 'p@t.ru' });
});
