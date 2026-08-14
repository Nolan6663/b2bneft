'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createCompanyEnricher = require('../../lib/company-enrich');

/* Обогащение карточек пачкой.

   Раньше на каждую компанию уходило семь запросов, а список компаний отдаётся
   целиком и дёргается из настроек, сделок, тарифа и партнёров — то есть один
   заход поднимал десятки тысяч запросов. Проверяем ровно две вещи: что число
   запросов больше не зависит от длины списка и что цифры в карточке от этого
   не поехали. */

const storage = { photoPublicUrl: (n) => '/photos/' + n };

function poolWith(rows = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (/FROM proposals\s+WHERE company/i.test(sql)) return { rows: rows.proposals || [] };
            if (/JOIN orders o ON o\.id = p\.order_id/i.test(sql)) return { rows: rows.responses || [] };
            if (/FROM orders\s+WHERE company/i.test(sql)) return { rows: rows.orders || [] };
            if (/FROM favorites/i.test(sql)) return { rows: rows.favorites || [] };
            if (/FROM company_photos/i.test(sql)) return { rows: rows.photos || [] };
            throw new Error('непредусмотренный запрос: ' + sql.slice(0, 80));
        },
    };
}

test('число запросов не зависит от размера списка', async () => {
    const pool = poolWith();
    const { enrichCompanies } = createCompanyEnricher({ pool, storage });

    const many = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, company: 'Завод ' + i, role: 'producer' }));
    const result = await enrichCompanies(many, 'ООО Заказчик');

    assert.equal(result.length, 300);
    assert.ok(pool.calls.length <= 5,
        `на 300 компаний ушло ${pool.calls.length} запросов — пачка перестала быть пачкой`);
});

test('пустой список до базы не доходит', async () => {
    const pool = poolWith();
    const { enrichCompanies } = createCompanyEnricher({ pool, storage });
    assert.deepEqual(await enrichCompanies([], null), []);
    assert.equal(pool.calls.length, 0);
});

test('рейтинг и статистика поставщика считаются как раньше', async () => {
    const pool = poolWith({
        proposals: [{ company: 'ООО Завод', total: '10', won: '4', resolved: '5', avg_days: '12.4' }],
        responses: [{ company: 'ООО Завод', n: '4', avg_sec: '7200' }],
        photos: [
            { company_id: 1, id: 5, stored_name: 'a.jpg', original_name: 'цех.jpg' },
            { company_id: 1, id: 6, stored_name: 'b.jpg', original_name: 'станок.jpg' },
        ],
    });
    const { enrichCompany } = createCompanyEnricher({ pool, storage });

    const c = await enrichCompany({ id: 1, company: 'ООО Завод', role: 'producer' }, null);

    assert.equal(c.rating, 'A+', '4 победы из 5 решённых — и порог в три победы пройден');
    assert.equal(c.status, 'Верифицирован');
    assert.deepEqual(c.ratingStats, { won: 4, resolved: 5 });
    assert.deepEqual(c.stats, {
        completedOrders: 4,
        avgDeliveryDays: 12,
        totalProposals: 10,
        avgFirstResponseHours: 2,
        winRate: 80,
    });
    assert.equal(c.photos.length, 2);
    assert.equal(c.photos[0].url, '/photos/a.jpg');
    assert.equal(c.isFavorite, false, 'без владельца избранного нет');
});

test('поставщик без КП: ни рейтинга, ни статистики — а не нули', async () => {
    const pool = poolWith();
    const { enrichCompany } = createCompanyEnricher({ pool, storage });
    const c = await enrichCompany({ id: 2, company: 'Новый', role: 'producer' }, null);

    assert.equal(c.rating, undefined, 'рейтинг с потолка хуже, чем его отсутствие');
    assert.equal(c.status, undefined);
    assert.equal(c.stats, null);
});

test('порог в три решённых КП: доля побед не показывается раньше', async () => {
    const pool = poolWith({ proposals: [{ company: 'ООО Завод', total: '2', won: '1', resolved: '2', avg_days: '5' }] });
    const { enrichCompany } = createCompanyEnricher({ pool, storage });
    const c = await enrichCompany({ id: 3, company: 'ООО Завод', role: 'producer' }, null);
    assert.equal(c.stats.winRate, null, 'на двух КП это случайность, а не показатель');
});

test('SLA не показывается, пока откликов меньше двух', async () => {
    const pool = poolWith({
        proposals: [{ company: 'ООО Завод', total: '3', won: '0', resolved: '0', avg_days: null }],
        responses: [{ company: 'ООО Завод', n: '1', avg_sec: '3600' }],
    });
    const { enrichCompany } = createCompanyEnricher({ pool, storage });
    const c = await enrichCompany({ id: 4, company: 'ООО Завод', role: 'producer' }, null);
    assert.equal(c.stats.avgFirstResponseHours, null);
    assert.equal(c.stats.avgDeliveryDays, null, 'без выигранных КП средний срок не из чего считать');
});

test('заказчик считается по заявкам, а не по КП', async () => {
    const pool = poolWith({ orders: [{ company: 'ООО Заказчик', total: '7', closed: '2' }] });
    const { enrichCompany } = createCompanyEnricher({ pool, storage });
    const c = await enrichCompany({ id: 8, company: 'ООО Заказчик', role: 'customer' }, null);

    assert.equal(c.status, 'Верифицирован', 'есть закрытая заявка — значит доводил дело до конца');
    assert.deepEqual(c.stats, { postedOrders: 7, closedOrders: 2 });
});

test('избранное проставляется по владельцу списка', async () => {
    const pool = poolWith({ favorites: [{ company_id: 2 }] });
    const { enrichCompanies } = createCompanyEnricher({ pool, storage });
    const [first, second] = await enrichCompanies([
        { id: 1, company: 'А', role: 'producer' },
        { id: 2, company: 'Б', role: 'producer' },
    ], 'ООО Заказчик');

    assert.equal(first.isFavorite, false);
    assert.equal(second.isFavorite, true);
});
